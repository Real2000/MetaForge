/**
 * 知识库摄取管道（V2.3 #5 摄取管道化 + PaddleOCR 接入 2026-10-31）
 *
 * 背景：上传解析链路原先全部内联在 routes/knowledge.js 的 POST /:id/files（约 140 行），
 * 按序执行「归属校验 → 解析 → 清洗 → 切片 → TOC → 父子切片 → 落库 → 三后处理」。
 * 本模块将其重构为「步骤注册表 + 执行器」，支撑三件事：
 *   1. 库级自定义管道（kbs.pipeline 列，PUT /api/knowledge/:id 配置步骤子集/顺序）；
 *   2. 异步摄取（?async=1：先落 pending 行立即返回，后台执行，前端轮询 /:id/logs 观测）；
 *   3. OCR 增强（o 步骤：扫描版文件文本过短时调 PaddleOCR 服务，见 lib/paddleocr.js）。
 *
 * 等价性硬指标（本版发版出口）：默认管道 + 同步模式下，与改造前行为逐字节等价——
 *   - SQL 写入的表/列/值：kb_files（成功行 name 原样不截断、source 原样 `source||'upload'`、
 *     size/parsed_at/created_at）、kb_chunks（父块先插、子块 parent_id/chapter_id 计算逐字保留）、
 *     kbs.toc 回写；失败行对齐 insertFailedFile 语义（name 截 200 / source 白名单 / error_msg 截 500 /
 *     parsed_at NULL / chunk_count 0）
 *   - 错误消息文案逐字沿用：「文件解析失败：」「解析后无有效文本内容（扫描版 PDF 需先 OCR）」
 *     「切片后无有效片段」（「请提供文件名」「请提供文件内容…」两参数错误留在路由层，不落库；
 *     非字符串 file_b64 的 Buffer.from TypeError 经路由层捕获 + parseError 钩子复刻原 catch 行为）
 *   - op_logs 动作：成功「上传知识库文件」（detail `${kb.name} / ${name}（${n} 片段）`）；
 *     失败「知识库文件解析失败」（detail `${kb.name} / ${safeName}：${msg 截 200}`）
 *   - fire-and-forget 三后处理触发条件不变：keywords 恒触发、metadata 仅 kb.auto_metadata 开启、
 *     regression 恒触发（各自内部静默/落 err_logs 语义保留），且不 await
 *
 * P2-3 语义分片增强（2026-11-05，有意打破切片内容等价性——其余等价面全部保留）：
 *   chunk 步骤由「短段落各自成块」改为「句边界切分（逐字沿用）+ 语义聚合（短段落贪心合并至
 *   ~chunkSize；标题/章节号/序号开头的段落为强边界不合并）」。SQL/文案/日志等价面不变；
 *   多短段落场景的块数与块内容由 N 变为聚合后的 ⌈总字数/chunkSize⌉——存量数据不迁移，
 *   重新解析后生效。
 *
 * 状态流转（kb_files.status）：
 *   执行前 INSERT 'pending'（拿 fileId）→ 首个同步步骤开始前 UPDATE 'processing'
 *   → 全部成功 UPDATE 'success'（chunk_count 落值 + parsed_at）→ 任何同步步骤失败 UPDATE 'failed'（error_msg）
 *   （改造前为一次性 INSERT 'success' / INSERT 'failed'，最终行字段值一致；pending/processing 是
 *    #5 异步化后的可观测中间态，解析日志页四态汇总的预留位自此启用）
 *
 * V2.3 审查加固（P1-1，Tech Lead 实证发现）：自定义管道摘除 chunk 步骤曾导致「假成功」——
 *   persistSuccess 对 ctx.chunks=null（|| [] 兜底）静默写 success + chunk_count=0 + 0 分块，
 *   文件看起来解析成功但检索永远命中不了。修复：核心步骤跑完后分块产出为空 → failed
 *   「切片后无有效片段」（文案沿用现状，等价性不受影响：默认管道 chunk 步骤自身已拦截此情形）。
 */

const { db, now } = require('../db');
const fileparse = require('./fileparse');                     // 文件解析（与工作流文件上传同一实现）
const { extractToc, assignChapterIds } = require('./tocService'); // TOC 目录提取
const { generateForFile } = require('./keywordgen');           // 自动关键词/问法（后处理）
const { extractMetadataForFile } = require('./kb-metadata');   // 自动元数据抽取（后处理）
const { runKbRegression } = require('./kb-eval-regression');   // 召回评测回归（后处理）
const paddleocr = require('./paddleocr');                      // PaddleOCR HTTP 封装（ocr 步骤）
const path = require('path');                                  // U1-9：vision-describe 步骤判断文件扩展名

/**
 * 步骤注册表：name → { name, label(中文名), desc(一句话), post?, async run(ctx) }
 *  - ctx 随步骤推进累积：{ kb, fileId, name, buf, content, source, user, ip, byteSize,
 *    text, chunks, chapterIds, toc, chunkSize, hasParentSlice, parentChunks, childToParent }
 *  - run 返回 { ok:true, skipped? } 表示通过/跳过；返回 { ok:false, msg } 表示步骤失败
 *    （执行器落 failed，msg 为落库与同步 400 响应的错误文案）
 *  - post:true 标记 fire-and-forget 后处理步骤：在落库成功后触发且【不 await 其内部异步任务】
 *    （等价改造前的 generateForFile / extractMetadataForFile / runKbRegression 三后处理）
 * 注册顺序即默认管道顺序（DEFAULT_PIPELINE 与此处的键序一致）。
 */
const PIPELINE_STEPS = {

  // ---------- 同步核心步骤（任一失败 → 整体 failed，同步模式返回 400） ----------

  parse: {
    name: 'parse',
    label: '文件解析',
    desc: 'file_b64 二进制解析（PDF/DOCX/XLSX/PPTX/TXT/MD）或 content 直传文本 → 原始文本',
    async run(ctx) {
      // 路由层预转换兜底：file_b64 为非字符串（数字/对象）时 Buffer.from 抛 TypeError，
      // 路由层捕获后经 parseError 传入——此处复刻改造前路由 catch 分支（failed + 400 同文案），
      // 防止 Express 4 下 async handler 裸抛导致请求永久挂起（等价性硬指标的边界补齐）
      if (ctx.parseError) return { ok: false, msg: '文件解析失败：' + ctx.parseError.message };
      try {
        if (ctx.buf) {
          // 与改造前同源：lib/fileparse.parseFileBuffer（工作流文件上传共用同一实现）
          ctx.text = (await fileparse.parseFileBuffer(ctx.name, ctx.buf)).text;
        } else {
          ctx.text = ctx.content; // 直传文本（路由层已校验 content 为字符串）
        }
        return { ok: true };
      } catch (e) {
        // 错误文案逐字沿用改造前路由 catch 分支（等价性硬指标）
        return { ok: false, msg: '文件解析失败：' + e.message };
      }
    },
  },

  ocr: {
    name: 'ocr',
    label: 'OCR 增强',
    desc: '扫描版/图片型文件（解析文本过短）调 PaddleOCR 服务识别增强文本；未配置/不可用/失败一律静默降级不阻塞',
    async run(ctx) {
      // 触发条件①：存在原始文件 buffer（content 直传文本无从 OCR）
      if (!ctx.buf) return { ok: true, skipped: 'no_buffer' };
      // 触发条件②：解析后文本过短（<8 字符，扫描版特征）——文本充足无需增强
      if ((ctx.text || '').length >= 8) return { ok: true, skipped: 'text_enough' };
      // 未配置 → 完全静默跳过（不发请求/不写日志——未配置环境与改造前逐字节等价的硬保证）
      if (!paddleocr.isConfigured()) return { ok: true, skipped: 'not_configured' };
      // 探测失败（已配置但服务不可达）→ console.warn + err_logs 记一条降级后跳过
      if (!(await paddleocr.ocrAvailable())) {
        warnOcrDegrade(ctx, 'PADDLEOCR 服务不可达（健康探测失败），本次跳过 OCR 增强');
        return { ok: true, skipped: 'probe_failed' };
      }
      // 识别（失败同样静默降级；降级后 clean 仍无文本则按现状文案 failed）
      try {
        const ocrText = await paddleocr.ocrImage(ctx.buf);
        if (ocrText && String(ocrText).trim()) {
          ctx.text = String(ocrText); // OCR 结果整体替换原文本（原文本本就过短无有效内容）
          ctx.ocrUsed = true;
          return { ok: true };
        }
        warnOcrDegrade(ctx, 'OCR 识别结果为空，本次跳过增强');
        return { ok: true, skipped: 'empty_result' };
      } catch (e) {
        warnOcrDegrade(ctx, `OCR 识别失败：${e.message}，本次跳过增强`);
        return { ok: true, skipped: 'error' };
      }
    },
  },

  'vision-describe': {
    name: 'vision-describe',
    label: '图片理解（VL）',
    desc: '图片型文件（.png/.jpg/.webp 等）用多模态 VL 模型生成描述文本；与 OCR 互斥——已走 vision 则 OCR 跳过；模型由知识库 vision_model 指定',
    async run(ctx) {
      const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
      const ext = path.extname((ctx.name || '').toLowerCase());
      if (!IMG_EXTS.has(ext)) return { ok: true, skipped: 'not_image' };
      const visionModel = ctx.kb?.vision_model;
      if (!visionModel) return { ok: true, skipped: 'no_vision_model' };
      // 有 buf 且已配置 vision_model → 走 vision 描述：结果写入 ctx.text（覆盖 parse 的短文本），后续 clean 步骤处理
      if (!ctx.buf) return { ok: true, skipped: 'no_buffer' };
      try {
        const { visionDescribe } = require('./llm');
        const r = await visionDescribe(ctx.buf, visionModel);
        if (r.ok && r.text) {
          ctx.text = r.text;
          ctx.visionUsed = true;
          ctx.imageDescs = r.text; // 额外保存供检索增强匹配
          return { ok: true };
        }
        console.warn(`[ingestion] vision-describe 失败（${r.msg || '未知'}），跳过（不阻断文件处理）`);
        return { ok: true, skipped: 'vision_failed' };
      } catch (e) {
        console.warn('[ingestion] vision-describe 异常（不阻断）：', e.message);
        return { ok: true, skipped: 'vision_error' };
      }
    },
  },

  clean: {
    name: 'clean',
    label: '文本清洗',
    desc: '统一换行符、去空字符、去首尾空白；清洗后仍无有效文本（<8 字符）判失败',
    async run(ctx) {
      ctx.text = (ctx.text || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
      // 文案逐字沿用改造前（等价性硬指标）；OCR 降级后仍无文本同样落此失败
      if (ctx.text.length < 8) return { ok: false, msg: '解析后无有效文本内容（扫描版 PDF 需先 OCR）' };
      return { ok: true };
    },
  },

  chunk: {
    name: 'chunk',
    label: '智能切片',
    desc: '按库配置（chunk_size/overlap/separator）句边界切分+语义聚合（短段落合并至~chunkSize，标题/章节号为强边界）并做重叠，同时生成父子切片映射；切片为空判失败',
    async run(ctx) {
      const kb = ctx.kb;
      // ---- P2-3 语义分片增强（2026-11-05）：两段式切片 = 句边界切分（逐字沿用改造前）+ 语义聚合（新增） ----
      // 改造前（管道化自路由 L167-198 逐字搬移）：短段落各自成块 → 碎片化分块伤召回（一句话一块，语义信号弱）。
      // P2-3 增强：相邻短段落贪心合并至 ~chunkSize；标题/章节号开头的段落视为语义强边界不与前面合并。
      // 行为兼容：超长段落按句边界切分逐字沿用改造前；空段过滤（<8 字）沿用；
      //          仅「多短段落」场景块数由 N 变为聚合后的 ⌈总字数/chunkSize⌉（重叠/父子切片/chapterIds 逻辑不变）。
      const chunkSize = kb.chunk_size || 500;
      const chunkOverlap = kb.chunk_overlap || 0;
      const sep = kb.chunk_separator || '\n\s*\n';
      const sepRe = new RegExp(sep);
      // 第一步：段落级语义单元收集（超长段落：按句边界切 ~chunkSize 字——切分逻辑自改造前逐字搬移）
      const units = [];
      for (const para of ctx.text.split(sepRe)) {
        const p = para.trim();
        if (p.length < 8) continue;
        if (p.length <= chunkSize) { units.push(p); continue; }
        let cur = '';
        for (const sent of p.split(/(?<=[。！？；.!?;])/)) {
          if ((cur + sent).length > chunkSize && cur) { units.push(cur.trim()); cur = sent; }
          else cur += sent;
        }
        if (cur.trim().length >= 8) units.push(cur.trim());
      }
      // 第二步：语义聚合——markdown 标题 / 中文章节 / 序号开头的单元是强边界，其余贪心合并至 ~chunkSize
      const HEADING_RE = /^(#{1,4}\s|第[一二三四五六七八九十百千0-9]+[章节篇部]|[一二三四五六七八九十]+[、.．]|[0-9]{1,3}[.、．][\s）)]|[（(][一二三四五六七八九十0-9]+[）)])/;
      const chunks = [];
      let agg = '';
      for (const u of units) {
        if (!agg || HEADING_RE.test(u) || agg.length + 2 + u.length > chunkSize) {
          if (agg) chunks.push(agg);
          agg = u;
        } else agg += '\n\n' + u;
      }
      if (agg) chunks.push(agg);
      // 重叠切片：对相邻两块各取末尾 overlap 字符追加到前一块
      if (chunkOverlap > 0 && chunks.length > 1) {
        for (let i = chunks.length - 1; i > 0; i--) {
          const prev = chunks[i - 1];
          const next = chunks[i];
          if (prev.length > chunkOverlap) {
            chunks[i - 1] = prev + '\n' + next.slice(0, chunkOverlap);
          }
        }
      }
      // 文案逐字沿用改造前（等价性硬指标）
      if (!chunks.length) return { ok: false, msg: '切片后无有效片段' };
      ctx.chunks = chunks;
      ctx.chunkSize = chunkSize; // 供 toc 步骤沿用同一取值
      ctx.chapterIds = chunks.map(() => null); // 章节归属先占位 null（toc 步骤成功时覆盖）
      // ---- 父子切片（自改造前路由 L224-242 逐字搬移；注意改造前该段在 TOC 之后执行，
      //      但两者均只读 chunks 互不写对方产物，先后顺序无行为差异，等价） ----
      // 父子切片（P2 2026-10-28）：子分片 ~200 字精准召回，父分片 ~1000 字保持上下文完整
      const hasParentSlice = chunkSize > 200; // 只有 chunkSize > 200 时才需要分割父子切片
      let parentChunks = [];
      let childToParent = []; // 每个子分片对应的父分片索引（-1 = 独立，不关联）
      if (hasParentSlice && chunks.length >= 2) {
        // 计算每个父分片应该包含的子分片数
        const pSize = 1000; // 目标父分片大小
        const childCount = Math.max(2, Math.round(pSize / chunkSize));
        for (let i = 0; i < chunks.length; i += childCount) {
          const group = chunks.slice(i, i + childCount);
          parentChunks.push(group.join('\n'));
          for (let j = 0; j < group.length; j++) childToParent.push(parentChunks.length - 1);
        }
      } else {
        childToParent = chunks.map(() => -1);
      }
      ctx.hasParentSlice = hasParentSlice;
      ctx.parentChunks = parentChunks;
      ctx.childToParent = childToParent;
      return { ok: true };
    },
  },

  toc: {
    name: 'toc',
    label: 'TOC 目录提取',
    desc: 'LLM 提取文档章节层级目录并标记分块章节归属（失败不阻塞上传，静默跳过）',
    async run(ctx) {
      // ---- 以下逻辑自改造前路由 L200-222 逐字搬移（含「失败不阻塞」语义） ----
      // 注意：chunks 统一保持字符串数组，章节归属单独存 chapterIds —— 避免对象混入导致 join 产生 [object Object]
      try {
        const toc = await extractToc(ctx.text, ctx.chunkSize || 500);
        if (toc && toc.length) {
          const withChapters = ctx.chunks.map(c => ({ content: c }));
          assignChapterIds(withChapters, toc);
          ctx.chapterIds = withChapters.map(c => c.chapterId || null);
          // TOC 每章节定位：首个包含该标题的分块索引；未命中继承上一章节位置
          let lastIdx = 0;
          for (const t of toc) {
            let found = -1;
            for (let i = 0; i < ctx.chunks.length; i++) {
              if (ctx.chunks[i].includes(t.title)) { found = i; break; }
            }
            t.startChunkIdx = found >= 0 ? found : lastIdx;
            lastIdx = t.startChunkIdx;
          }
          ctx.toc = toc;
        }
      } catch { /* TOC 提取失败不阻塞上传（改造前语义逐字保留） */ }
      return { ok: true };
    },
  },

  // ---------- fire-and-forget 后处理步骤（落库成功后触发，不 await，等价改造前三后处理） ----------

  metadata: {
    name: 'metadata',
    label: '自动元数据',
    desc: '库开启 auto_metadata 时后台 fire-and-forget 抽取分块元数据（不阻塞上传，未开启/无供应商/失败均静默）',
    post: true,
    async run(ctx) {
      // 触发条件逐字对齐改造前 if (kb.auto_metadata)
      if (!ctx.kb.auto_metadata) return { ok: true, skipped: 'disabled' };
      extractMetadataForFile(ctx.fileId).catch(() => { }); // 等价改造前：fire-and-forget 且失败静默
      return { ok: true };
    },
  },

  keywords: {
    name: 'keywords',
    label: '自动关键词',
    desc: '后台 fire-and-forget 生成分块关键词/问法（不阻塞上传，无模型/失败静默跳过）',
    post: true,
    async run(ctx) {
      generateForFile(ctx.fileId).catch(() => { }); // 等价改造前：fire-and-forget 且失败静默
      return { ok: true };
    },
  },

  graphrag: {
    name: 'graphrag',
    label: '知识图谱抽取',
    desc: '后台 fire-and-forget 用 LLM 抽取实体与关系三元组入库（M4 AI-04；不阻塞上传，无供应商/失败静默，单文件分块数设上限控成本）',
    post: true,
    async run(ctx) {
      // 懒加载避免启动期依赖图扩大；图谱抽取可能较慢（逐分块 LLM 调用），必须不阻塞摄取响应
      const { buildGraphForFile } = require('./graphrag');
      buildGraphForFile(ctx.fileId, ctx.kb.id).catch(e => {
        // 图谱抽取失败落 err_logs 可观测（与 regression 步骤同语义），不影响文件已成功入库的状态
        try {
          db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)')
            .run('kb-graphrag', `库#${ctx.kb.id} 文件#${ctx.fileId}（${ctx.name}）图谱抽取失败：${e && e.message}`, now());
        } catch { }
      });
      return { ok: true };
    },
  },

  regression: {
    name: 'regression',
    label: '召回评测回归',
    desc: '上传成功后 fire-and-forget 重跑该库评测集验证召回未劣化并通知 owner（失败落 err_logs，无评测集静默）',
    post: true,
    async run(ctx) {
      runKbRegression(ctx.kb.id, { username: ctx.user?.username, ip: ctx.ip }).catch(e => {
        // 等价改造前：回归失败落 err_logs（原全静默），文案逐字保留
        try {
          db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)')
            .run('kb-regression', `库#${ctx.kb.id} 上传后回归失败：${e.message}`, now());
        } catch { }
      });
      return { ok: true };
    },
  },
};

/** 默认管道步骤名数组（顺序即执行顺序；注册表键序与此一致）。
 *  M4 AI-04（2026-11-23）：keywords 后新增 graphrag（post，fire-and-forget）——实体/三元组抽取自此接入默认管道；
 *  存量库的自定义 pipeline 数组不含 graphrag 则不启用（与「默认管道 keywords 后加 graphrag」的排期口径一致）。 */
const DEFAULT_PIPELINE = ['parse', 'ocr', 'vision-describe', 'clean', 'chunk', 'toc', 'metadata', 'keywords', 'graphrag', 'regression'];

/** 步骤名白名单校验：是否为注册表内合法步骤 */
function VALID_STEP(name) {
  return Object.prototype.hasOwnProperty.call(PIPELINE_STEPS, name);
}

/** OCR 降级留痕：console.warn + err_logs 一条（仅「已配置但探测/识别失败」时调用；未配置路径完全静默） */
function warnOcrDegrade(ctx, message) {
  console.warn(`[ingestion] OCR 降级：${message}`);
  try {
    db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)')
      .run('kb-ocr', `库#${ctx.kb.id} 文件#${ctx.fileId}（${ctx.name}）：${message}`, now());
  } catch { }
}

/**
 * 同步落库失败（对齐改造前 insertFailedFile 语义，逐字等价）：
 * kb_files 置 failed + error_msg（截 500）+ name 截 200 + source 白名单归一 + chunk_count=0 + parsed_at=NULL，
 * 并写 op_logs「知识库文件解析失败」。返回给调用方的失败结果对象（msg 原文，供同步 400 响应）。
 * 注：改造前是 INSERT failed 行；管道先 INSERT pending 再 UPDATE，最终行字段值一致（见文件头等价性说明）
 */
function failPipeline(ctx, errMsg) {
  const msg = String(errMsg || '未知原因').slice(0, 500);
  // name 截 200（对齐 files.js 先例）/ source 白名单，防存储滥用——逐字对齐改造前 insertFailedFile
  const safeName = String(ctx.name || '未命名').slice(0, 200);
  const safeSource = ['upload', 'api', 'pipeline'].includes(ctx.source) ? ctx.source : 'upload';
  db.prepare(`UPDATE kb_files SET status='failed', name=?, source=?, chunk_count=0, error_msg=?, parsed_at=NULL WHERE id=?`)
    .run(safeName, safeSource, msg, ctx.fileId);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(ctx.user?.username, '知识库文件解析失败', `${ctx.kb.name} / ${safeName}：${msg.slice(0, 200)}`, ctx.ip, now());
  return { ok: false, status: 'failed', fileId: ctx.fileId, msg: errMsg };
}

/**
 * 核心步骤全部成功后的落库（kb_chunks 插入 + toc 回写 + 状态置 success + op_logs）。
 * 全部自改造前路由 L244-262 逐字搬移（等价性硬指标）：
 * 先插父分片再插子分片、parent_id/chapter_id 计算逻辑、toc 回写 kbs、op_logs「上传知识库文件」。
 * 状态流转在此从 pending/processing → success（chunk_count 落值 + parsed_at 解析完成时间）。
 * U0-7：每个 chunk 写入前过内容安全审核（敏感词/PII/注入检测）。
 */
function persistSuccess(ctx) {
  const kb = ctx.kb;
  const chunks = ctx.chunks || [];
  const { review } = require('./content-filter');
  // 审核命中分块列表（中断上传但不清空已有，方便排查修复后重传）
  const blockedChunks = [];

  // 先插父分片，再插子分片
  if (ctx.hasParentSlice && ctx.parentChunks.length) {
    const insParent = db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content,parent_id,modality) VALUES (?,?,?,?,?)');
    ctx.parentChunks.forEach(pc => {
      const result = review(pc, 'kb_import');
      if (result.blocked) { blockedChunks.push('父分片：' + result.reason); return; }
      insParent.run(ctx.fileId, kb.id, result.cleaned || pc, null, ctx.visionUsed ? 'image' : 'text');
    });
  }
  // AI-11（2026-11-23）：图片文件（visionUsed）分块标 modality='image'——文搜图命中可标识来源，
  // 图搜图可限定检索域；文本文件保持 'text'（列默认，存量行自动归一）
  const ins = db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content,parent_id,chapter_id,modality) VALUES (?,?,?,?,?,?)');
  const parentStartIdx = ctx.hasParentSlice ? ctx.parentChunks.length : 0;
  const chunkModality = ctx.visionUsed ? 'image' : 'text';
  chunks.forEach((c, i) => {
    const result = review(c, 'kb_import');
    if (result.blocked) { blockedChunks.push(`分块 #${i + 1}：${result.reason}`); return; }
    const parentId = ctx.hasParentSlice && ctx.childToParent[i] >= 0 ? (parentStartIdx + ctx.childToParent[i] + 1) : null;
    ins.run(ctx.fileId, kb.id, result.cleaned || c, parentId, ctx.chapterIds ? ctx.chapterIds[i] : null, chunkModality);
  });

  // 有审核拦截的分块 → 记录但不中断已通过的分块写入（不影响已合法内容入库）
  if (blockedChunks.length) {
    const detail = `文件「${ctx.originalName || ctx.file?.name || ''}」上传中有 ${blockedChunks.length} 个分块因内容安全审核被跳过：${blockedChunks.join('；')}`;
    console.warn('[content-filter]', detail);
    try {
      const { logSecurityEvent } = require('./security');
      logSecurityEvent('kb_import_blocked', detail.slice(0, 500), '拦截', 'knowledge_base');
    } catch { }
  }
  // 如果有 TOC，回写入 kbs 表
  if (ctx.toc && ctx.toc.length) {
    db.prepare('UPDATE kbs SET toc=? WHERE id=?').run(JSON.stringify(ctx.toc), kb.id);
  }
  // 状态流转③：全部成功 → success（chunk_count 落值；parsed_at=解析完成时间，对齐改造前成功行语义）
  db.prepare(`UPDATE kb_files SET status='success', chunk_count=?, parsed_at=datetime('now','localtime') WHERE id=?`)
    .run(chunks.length, ctx.fileId);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(ctx.user?.username, '上传知识库文件', `${kb.name} / ${ctx.name}（${chunks.length} 片段）`, ctx.ip, now());
}

/**
 * 步骤执行主体（内部函数，由 startPipeline 构造 promise）：
 * 1. 同步核心步骤逐个 await（首步开始前置 processing；{ ok:false } → failPipeline）；
 * 2. 核心步骤全过 → persistSuccess 落库；
 * 3. 后处理步骤（post:true）在落库成功后逐个触发——run 内部已 fire-and-forget 不 await 内部任务，
 *    此处 await 的是 run 本身（立即返回），等价改造前三后处理的触发时机；
 * 4. 任何未预期异常（如非法 chunk_separator 构造正则抛错——改造前此路径会挂起请求）统一落 failed。
 * 永不 reject：失败以 { ok:false } 结果对象返回（调用方可安全 fire-and-forget，仅意外时由外层 .catch 兜底）
 */
async function execSteps(ctx, stepNames) {
  try {
    let started = false;
    for (const stepName of stepNames) {
      const step = PIPELINE_STEPS[stepName];
      if (!step || step.post) continue; // 后处理步骤延后到落库成功后统一触发
      if (!started) {
        // 状态流转②：首个同步步骤开始前 → processing（异步模式下可观测「处理中」中间态）
        db.prepare("UPDATE kb_files SET status='processing' WHERE id=?").run(ctx.fileId);
        started = true;
      }
      const r = await step.run(ctx);
      if (r && r.ok === false) return failPipeline(ctx, r.msg); // 同步步骤失败 → failed + 返回失败结果
    }
  // V2.3 审查加固（P1-1）：分块产出为空（自定义管道摘除 chunk 步骤，或 chunk 步骤被跳过后
  // 无任何步骤产出 chunks）→ 落 failed 而非假成功——否则文件标记成功但检索永远命中不了（0 分块）。
  // 文案沿用现状「切片后无有效片段」；默认管道不受影响（chunk 步骤自身已拦截同情形，此处恒不触发）
  if (!ctx.chunks || !ctx.chunks.length) {
    return failPipeline(ctx, '切片后无有效片段');
  }
  persistSuccess(ctx); // 核心步骤全部成功 → 落库 + success
  for (const stepName of stepNames) {
    const step = PIPELINE_STEPS[stepName];
    if (!step || !step.post) continue;
    try { await step.run(ctx); } catch { /* 后处理触发失败不影响摄取结果（等价改造前 fire-and-forget 静默） */ }
  }
  return { ok: true, status: 'success', fileId: ctx.fileId, chunks: (ctx.chunks || []).length };
  } catch (e) {
    // 兜底：步骤内未捕获异常统一落 failed（改造前该路径会导致请求挂起，管道化后收口为可观测失败）
    return failPipeline(ctx, `管道步骤执行失败：${e.message}`);
  }
}

/**
 * 启动摄取管道（同步执行入口 + 异步模式共用底座）：
 * 入口同步完成「字节数计算 → 步骤序列校验 → INSERT pending 拿 fileId」，随后返回执行 promise。
 * 返回 { fileId, promise }：
 *   - fileId：pending 行 id（前置校验失败时为 null，promise resolve 出 { ok:false, status:'bad_steps', msg }）
 *   - promise：execSteps 结果（永不 reject，见其注释；异步模式调用方可直接 fire-and-forget）
 * opts: { kb, name, buf, content, source, user, ip, steps, parseError }
 *   - buf：二进制文件的 Buffer（由路由层 Buffer.from(file_b64) 得到；非字符串 file_b64 转换抛错时
 *     buf=null 且 parseError=该异常，由 parse 步骤复刻改造前 catch 行为）
 *   - steps：步骤名数组；null/空数组 = 默认管道；元素须全部命中 VALID_STEP 白名单
 */
function startPipeline(opts) {
  const { kb, name, buf, content, source, user, ip, steps, parseError } = opts || {};
  // 字节数（对齐改造前：文件取 buf.length，直传文本取 Buffer.byteLength）
  let byteSize = 0;
  if (buf) byteSize = buf.length;
  else if (typeof content === 'string') byteSize = Buffer.byteLength(content);
  // 步骤序列：null/空 → 默认管道；自定义须全量命中白名单（整体拒绝，不插 pending 行防垃圾数据）
  let stepNames = DEFAULT_PIPELINE.slice();
  if (Array.isArray(steps) && steps.length) {
    const bad = steps.filter(s => !VALID_STEP(s));
    if (bad.length) {
      const msg = `未知管道步骤：${bad.join('、')}（可用步骤：${DEFAULT_PIPELINE.join(' / ')}）`;
      return { fileId: null, promise: Promise.resolve({ ok: false, status: 'bad_steps', msg }) };
    }
    stepNames = steps.map(String);
  }
  // 状态流转①：执行前 INSERT pending（拿 fileId；行值对齐改造前成功路径 INSERT——name 原样不截断、
  // source 原样 `source||'upload'`；失败时由 failPipeline UPDATE 为 insertFailedFile 语义的最终值）
  const ins = db.prepare(`INSERT INTO kb_files (kb_id,name,size,status,chunk_count,source,parsed_at,created_at)
    VALUES (?,?,?,'pending',0,?,NULL,datetime('now','localtime'))`)
    .run(kb.id, name, byteSize, source || 'upload');
  const ctx = {
    kb,
    fileId: Number(ins.lastInsertRowid),
    name,
    buf: buf || null,
    content,
    source,
    user,
    ip,
    byteSize,
    parseError: parseError || null, // 路由层 Buffer.from 抛错的兜底（parse 步骤消费，见其注释）
    // 以下为步骤累积产物（随管道推进填充）
    text: '',
    chunks: null,        // 子分片数组（chunk 步骤产出）
    chapterIds: null,    // 每个子分片的 TOC 章节归属（chunk 占位 null，toc 步骤覆盖）
    toc: null,           // TOC 目录结构（toc 步骤产出，成功时回写 kbs）
    chunkSize: 0,
    hasParentSlice: false,
    parentChunks: [],
    childToParent: [],
  };
  return { fileId: ctx.fileId, promise: execSteps(ctx, stepNames) };
}

/**
 * 摄取管道同步执行入口（默认上传路径使用）：await 全管道，返回最终结果对象。
 * 成功：{ ok:true, status:'success', fileId, chunks }
 * 失败：{ ok:false, status:'failed'|'bad_steps', fileId, msg }（msg 为同步 400 响应文案，逐字沿用改造前）
 */
async function runIngestionPipeline(opts) {
  const { promise } = startPipeline(opts);
  return promise;
}

/**
 * kbs.pipeline 读取侧归一（库列表/上传路由取步骤用）：
 * NULL/空串/非数组/空数组/损坏 JSON/含非法步骤名 → null（= 默认管道，fail-safe：
 * 异常配置回落默认而非阻断上传；写入侧已由 PUT /:id 白名单校验，此处为防御纵深）
 */
function parsePipelineConfig(raw) {
  if (raw == null || raw === '') return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return null;
    const names = arr.map(s => String(s || '')).filter(VALID_STEP);
    return names.length ? names : null;
  } catch {
    return null; // 损坏 JSON 静默回落默认
  }
}

module.exports = {
  PIPELINE_STEPS,        // 步骤注册表（name → 定义对象）
  DEFAULT_PIPELINE,      // 默认管道步骤名数组
  VALID_STEP,            // 步骤名白名单校验
  runIngestionPipeline,  // 同步执行入口（await 全管道）
  startPipeline,         // 底座入口（异步模式：先拿 fileId 再 fire-and-forget promise）
  parsePipelineConfig,   // kbs.pipeline 读取侧归一（NULL/异常 → null=默认）
};
