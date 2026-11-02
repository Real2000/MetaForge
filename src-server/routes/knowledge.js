/**
 * 知识库：库 CRUD（含 V2.3 #5 摄取管道配置 pipeline 字段）/ 文件上传解析（管道化）/ 召回测试
 *
 * V2.3 #5 摄取管道化 + PaddleOCR 接入（2026-10-31）：
 * - 上传解析链路自本文件内联实现（原 L135-274 约 140 行）移入 lib/ingestion-pipeline.js
 *   （步骤注册表 + 执行器：parse→ocr→clean→chunk→toc→落库→metadata/keywords/regression 后处理），
 *   默认管道 + 同步模式下行为与改造前逐字节等价（错误文案 / SQL 写入 / op_logs / fire-and-forget 条件）；
 * - 同步模式（默认）：await 全管道，成功 { code:0, data:{ id, chunks } }、失败 400 同改造前文案；
 * - 异步模式 ?async=1：先落 pending 行立即返回 { code:0, data:{ id, status:'pending', async:true } }，
 *   管道后台 fire-and-forget 执行（异常兜底落 failed + err_logs），前端轮询 GET /:id/files 或 /:id/logs 观测终态；
 * - 库级管道配置：PUT /:id 接受 pipeline 字段（步骤名数组，白名单校验；null/[]=恢复默认），
 *   仅影响后续上传，不自动重切存量分块；
 * - ocr 步骤依赖外部 PaddleOCR 服务（env PADDLEOCR_URL，未配置=整体跳过，部署见
 *   docker-compose.paddleocr.yml + docs/PaddleOCR部署说明.md）。
 */
const express = require('express');
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { retrieve, rerankModels } = require('../lib/retriever');
const { generateForFile } = require('../lib/keywordgen');
const { extractMetadataForFile, sanitizeMetadata } = require('../lib/kb-metadata'); // V1.2 #2 2026-10-30：自动元数据抽取 + 入参清洗
const { retrieveGraph } = require('../lib/graphrag');
const { rerunEvalSet, runKbRegression } = require('../lib/kb-eval-regression'); // V1.3 #6 2026-10-30：知识库级召回评测集重跑核心 + 库变更自动回归
const {
  runIngestionPipeline, // 同步执行入口（默认上传路径：await 全管道）
  startPipeline,        // 底座入口（异步模式：先拿 pending fileId 再 fire-and-forget）
  DEFAULT_PIPELINE,     // 默认管道步骤名数组（白名单提示用）
  VALID_STEP,           // 步骤名白名单校验（PUT pipeline 字段用）
  parsePipelineConfig,  // kbs.pipeline 读取侧归一（NULL/空/损坏 → null=默认管道）
} = require('../lib/ingestion-pipeline'); // V2.3 #5 2026-10-31：摄取管道（上传链路自此管道化）

const router = express.Router();
router.use(auth);

// P5.30 安全止血：写操作归属校验——此前 PUT/DELETE/上传对任何登录用户放行（可改删他人知识库、向他人知识库注入内容）。
// P0-1: owner 规范化——存量已迁移（nickname→username），创建时写入 req.user.username，校验仅比较 username 与 admin
function denyIfNotAllowed(kb, user) {
  if (!kb) return { code: 404, msg: '知识库不存在' };
  if (user.role === 'admin') return null;
  if (kb.owner === user.username) return null;
  return { code: 403, msg: '无权管理该知识库（仅创建者或管理员）' };
}

// V2.3 #5 2026-10-31：原 insertFailedFile（解析失败落库 + 审计）已随上传链路整体移入
// lib/ingestion-pipeline.js 的 failPipeline（kb_files 置 failed + error_msg 截 500 + name 截 200 +
// source 白名单 + op_logs「知识库文件解析失败」），行为逐字等价；本文件不再保留副本，避免两处漂移

router.get('/', (req, res) => {
  // V1.2 审查加固 2026-10-30：库列表加 owner 过滤——此前任意登录用户可看全平台库名/描述/配置（含
  // auto_metadata、分块参数），与 agents 挂库归属校验组合是攻击链的侦察环节；管理员仍见全部（管理页需要）
  const rows = db.prepare(`
    SELECT k.*, (SELECT COUNT(*) FROM kb_files f WHERE f.kb_id=k.id) AS file_count
    FROM kbs k WHERE (?='admin' OR k.owner=?) ORDER BY k.id DESC`).all(req.user.role, req.user.username);
  // V2.4 #9 2026-10-31 空间隔离——知识库的读取/创建均关联 space_id
  // space_id 已预加（ALTER TABLE kbs ADD COLUMN space_id INTEGER DEFAULT 0），
  // 0 = 无空间归属（所有用户可见），非 0 值 = 空间 ID（当前是改进程中的过渡语义）。
  // ============================================================
  // 列表的第一关是 owner 过滤（第 51-53 行），在此基础上叠加空间过滤。
  // 非管理员用户只能看到：
  //   - space_id IS NULL（0 或 NULL → 无归属）
  //   - 或 space_id 对应的空间允许当前用户访问（通过 agent_acls 或 owner 匹配判断）
  // 注意：sql 的第 51-53 行已做了 owner 过滤，此处仅做空间的追加过滤。
  // ============================================================
  let filtered = rows;
  if (req.user.role !== 'admin') {
    // 获取当前用户为 owner 的所有个人空间 ID
    const mySpaceIds = db.prepare('SELECT id FROM spaces WHERE owner=?').all(req.user.username).map(r => r.id);
    filtered = rows.filter(k => !k.space_id || mySpaceIds.includes(k.space_id) || k.owner === req.user.username);
    // ↑ 空间过滤条件（V2.4 #9）：
    //   - !k.space_id（0 或 NULL/undefined）→ 无空间归属 → 全员可见
    //   - mySpaceIds 包含该 space_id → 当前用户是该空间的 owner → 可见
    //   - k.owner 匹配 → 创建者可见
  }
  const data = filtered.map(r => ({ ...r, pipeline: parsePipelineConfig(r.pipeline) }));
  res.json({ code: 0, data });
});

router.post('/', (req, res) => {
  const { name, description } = req.body || {};
  if (!name?.trim()) return res.json({ code: 400, msg: '知识库名称不能为空' });
  // V2.4 #8 收尾：社区版用户最多创建 1 个知识库（edition 限制，与 plan 的软约束叠加）
  const { getSoftLimit } = require('../lib/plans');
  const softLimit = getSoftLimit('kb', req.user.username);
  if (softLimit > 0 && !req.user.plan) {
    const count = db.prepare('SELECT COUNT(*) c FROM kbs WHERE owner=?').get(req.user.username).c;
    if (count >= softLimit) {
      return res.json({ code: 402, msg: `社区版最多创建 ${softLimit} 个知识库（当前 ${count} 个），请升级专业版或企业版`, data: { upgrade_hint: true } });
    }
  }
  // V2.4 #9：创建知识库时写入 owner 的个人空间 space_id。当前用户所属个人空间通过用户查空间表获取。
  // 若无匹配的个人空间，则写入 0（无空间归属，默认所有用户可见）。
  // 创建空间前找到当前用户拥有的第一个个人空间，如果没有则设为 0（无归属）。
  let spaceId = 0;
  const mySpace = db.prepare('SELECT id FROM spaces WHERE type=? AND owner=? LIMIT 1').get('personal', req.user.username);
  if (mySpace) spaceId = mySpace.id;
  // 知识库数据：name,description,enabled,owner,space_id 写入
  const info = db.prepare(`INSERT INTO kbs (name,description,enabled,owner,space_id,created_at) VALUES (?,?,1,?,?,datetime('now','localtime'))`)
    .run(name.trim(), description || '', req.user.username, spaceId);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '创建知识库', name.trim(), req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

router.put('/:id', (req, res) => {
  const { name, description, enabled, chunk_size, chunk_overlap, chunk_separator, auto_metadata, pipeline } = req.body || {};
  const old = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(old, req.user);
  if (deny) return res.json(deny);
  // V1.2 #2 2026-10-30：auto_metadata 开关归一（0/1；未传保留原值）——开启后上传文件后台 LLM 自动抽取元数据
  const autoMeta = auto_metadata == null ? (old.auto_metadata ?? 0) : (auto_metadata ? 1 : 0);
  // V1.3 #6 2026-10-30：切片参数最终取值（未传保留原值）
  const nextSize = chunk_size ?? old.chunk_size;
  const nextOverlap = chunk_overlap ?? old.chunk_overlap;
  const nextSep = chunk_separator ?? old.chunk_separator;
  // V2.3 #5 2026-10-31：pipeline 字段归一——三态语义：
  //   undefined → 保留原值（未传不动）；null 或 [] → 恢复默认管道（存 NULL）；
  //   数组 → 元素须全部命中 VALID_STEP 白名单（非法 400 列出非法名与白名单），存 JSON.stringify
  let nextPipeline;
  if (pipeline === undefined) {
    nextPipeline = old.pipeline ?? null;
  } else if (pipeline === null || (Array.isArray(pipeline) && pipeline.length === 0)) {
    nextPipeline = null; // 恢复默认管道
  } else if (Array.isArray(pipeline)) {
    const bad = pipeline.filter(s => !VALID_STEP(s));
    if (bad.length) {
      return res.json({ code: 400, msg: `非法管道步骤：${bad.join('、')}（可用步骤：${DEFAULT_PIPELINE.join(' / ')}）` });
    }
    // V2.3 审查加固（P1-1）：必含核心步骤 parse+chunk——摘除 parse 则无文本产出、摘除 chunk 则无分块
    // 产出，两者均导致上传无法入库（执行层另有 chunks 空兜底落 failed，此处早拒绝误配置）
    const missing = ['parse', 'chunk'].filter(s => !pipeline.includes(s));
    if (missing.length) {
      return res.json({ code: 400, msg: `管道必须包含核心步骤：${missing.join('、')}（parse 产出文本、chunk 产出分块，缺一不可）` });
    }
    nextPipeline = JSON.stringify(pipeline);
  } else {
    return res.json({ code: 400, msg: 'pipeline 须为步骤名字符串数组（null/空数组=恢复默认管道）' });
  }
  db.prepare('UPDATE kbs SET name=?,description=?,enabled=?,chunk_size=?,chunk_overlap=?,chunk_separator=?,auto_metadata=?,pipeline=? WHERE id=?')
    .run(name || old.name, description ?? old.description, enabled ?? old.enabled,
      nextSize, nextOverlap, nextSep, autoMeta, nextPipeline, old.id);
  // V1.3 #6 2026-10-30：切片参数任一实际变化（与 old 逐项比对；数值归一比较防字符串/数字形态误判）
  // → fire-and-forget 召回评测回归：重跑该库全部评测集 + 通知 owner，异步执行不阻塞保存响应
  const chunkChanged = Number(nextSize) !== Number(old.chunk_size)
    || Number(nextOverlap) !== Number(old.chunk_overlap)
    || String(nextSep ?? '') !== String(old.chunk_separator ?? '');
  // V2.3 #5 2026-10-31：pipeline 变更与 chunk 参数变更同语义——仅影响【后续上传】的执行步骤/切片方式，
  // 不自动重切存量分块（存量需重切按既有流程重传文件）；故 pipeline 变更不并入下方回归触发条件
  if (chunkChanged) runKbRegression(old.id, { username: req.user.username, ip: req.ip }).catch(e => {
    try { db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('kb-regression', `库#${old.id} 变更触发回归失败：${e.message}`, now()); } catch { }
  });
  res.json({ code: 0, msg: '已保存' });
});

router.delete('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(old, req.user);
  if (deny) return res.json(deny);
  db.prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(req.params.id);
  db.prepare('DELETE FROM kb_files WHERE kb_id=?').run(req.params.id);
  db.prepare('DELETE FROM kbs WHERE id=?').run(req.params.id);
  if (old) db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '删除知识库', old.name, req.ip, now());
  res.json({ code: 0, msg: '已删除' });
});

// 文件列表（SELECT * 已含迁移列 source/error_msg/parsed_at/updated_at，前端直接可用，无需额外字段拼接）
// V1.1 审查加固 2026-10-30：补归属校验——此前无校验，任意登录用户可看他人库文件元数据；
// 本轮 error_msg（含解析器内部报错）入库后若继续敞开，/:id/logs 的收紧设计将被旁路，故与 logs 同权
router.get('/:id/files', (req, res) => {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  res.json({ code: 0, data: db.prepare('SELECT * FROM kb_files WHERE kb_id=? ORDER BY id DESC').all(req.params.id) });
});

// V1.1 #1 2026-10-30：解析日志——分页列表 + 四态汇总统计（前端「解析日志」页数据源）
// 权限比 files 列表更严（admin/owner 才可看）：日志含失败原因细节（可能带解析器内部报错信息），不向普通用户开放
// processing/pending 态在当前同步架构下恒为 0，为 #5 摄取管道异步化后的预留演进位（非缺陷）
router.get('/:id/logs', (req, res) => {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
  const total = db.prepare('SELECT COUNT(*) AS c FROM kb_files WHERE kb_id=?').get(kb.id).c;
  const list = db.prepare(`SELECT id,name,source,size,status,chunk_count,error_msg,parsed_at,created_at
    FROM kb_files WHERE kb_id=? ORDER BY id DESC LIMIT ? OFFSET ?`).all(kb.id, pageSize, (page - 1) * pageSize);
  // V1.1 审查加固 2026-10-30：stats 由 5 次独立 COUNT 合并为单条 GROUP BY（配合 idx_kb_files_kb 索引，防行数膨胀后同步驱动阻塞事件循环）
  const stats = { total, success: 0, failed: 0, processing: 0 };
  db.prepare('SELECT status, COUNT(*) AS c FROM kb_files WHERE kb_id=? GROUP BY status').all(kb.id).forEach(r => {
    if (r.status === 'success') stats.success = r.c;
    else if (r.status === 'failed') stats.failed = r.c;
    else if (r.status === 'processing' || r.status === 'pending') stats.processing += r.c; // 四态预设计：#5 管道异步化后的预留态
  });
  res.json({
    code: 0,
    data: {
      list, total, page, page_size: pageSize,
      stats,
    },
  });
});

// 上传并解析（V2.3 #5 2026-10-31 管道化）。两种方式：
// ① { name, content }            —— 直接粘贴文本（txt/md）
// ② { name, file_b64 }           —— 二进制文件（PDF/DOCX/XLSX/PPTX/TXT/MD），自动解析提取文本
// 摄取逻辑全部移入 lib/ingestion-pipeline.js（步骤注册表 + 执行器）：
//   默认管道 parse→ocr→clean→chunk→toc→（落库）→metadata/keywords/regression（后三者 fire-and-forget），
//   默认管道 + 同步模式下与改造前行为逐字节等价（详见该文件头注释的等价性清单）
// - 同步模式（默认）：await 全管道，成功 { code:0, data:{ id, chunks } }（与改造前逐字段兼容），
//   失败 400 + 改造前同款 msg（存量用例兼容）
// - 异步模式 ?async=1：INSERT pending 后 fire-and-forget 执行，立即返回
//   { code:0, data:{ id, status:'pending', async:true } }；终态轮询 GET /:id/files（单文件 status）或
//   GET /:id/logs（四态汇总；pending/processing 态自此不再是恒 0 预留位）
router.post('/:id/files', async (req, res) => {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  if (!kb) return res.json({ code: 404, msg: '知识库不存在' });
  const deny = denyIfNotAllowed(kb, req.user); // P5.30：防向他人知识库注入内容（归属校验留在路由层，不进管道）
  if (deny) return res.json(deny);
  const { name, content, file_b64, source } = req.body || {};
  if (!name) return res.json({ code: 400, msg: '请提供文件名' });
  // 参数校验（留在路由层，与改造前一致：file_b64 与 content 两者皆缺 → 400 且不落库留痕）。
  // Buffer.from(str,'base64') 对非法 base64 字符串是宽松解码不抛错；但对非字符串入参（数字/对象）
  // 会抛 TypeError——改造前该转换在 try 内（抛错走 catch → failed「文件解析失败：…」+ 400），
  // 此处必须同样兜住：Express 4 的全局错误中间件不捕获 async handler 的 rejected promise，
  // 裸抛会导致请求永久挂起。捕获后经 parseError 钩子交给管道 parse 步骤，复刻改造前 catch 行为
  let buf = null;
  let parseError = null;
  if (file_b64) {
    try { buf = Buffer.from(file_b64, 'base64'); }
    catch (e) { parseError = e; }
  }
  if (!parseError && !buf && typeof content !== 'string') return res.json({ code: 400, msg: '请提供文件内容（粘贴文本或上传文件）' });

  // 库级管道配置（kbs.pipeline：NULL/空/损坏 → null = 默认管道）
  const steps = parsePipelineConfig(kb.pipeline);
  const opts = { kb, name, buf, content, source, user: req.user, ip: req.ip, steps, parseError };

  // 异步模式：INSERT pending 拿 fileId 后 fire-and-forget，立即返回
  if (req.query.async === '1') {
    // V2.3 审查加固（S2-1）：每库在途上限——认证用户高频 async 上传可堆积海量后台管道（TOC LLM 调用等
    // 无队列背压），堆积至 ≥5 拒绝新的 async 上传（同步模式不受限——请求并发天然限流）防 DoS 自伤
    const inflight = db.prepare("SELECT COUNT(*) c FROM kb_files WHERE kb_id=? AND status IN ('pending','processing')").get(kb.id).c;
    if (inflight >= 5) {
      return res.json({ code: 429, msg: `该库摄取队列繁忙（在途 ${inflight} 个，上限 5），请稍后重试或改用同步上传`, data: { retry_after: 5 } });
    }
    const started = startPipeline(opts);
    if (started.fileId == null) {
      // 前置校验失败（步骤名非法等）：pending 行未落，同步报错（消息与同步模式一致）
      const r = await started.promise;
      return res.json({ code: 400, msg: r.msg });
    }
    started.promise.catch(e => {
      // 兜底：管道内部已对步骤失败落 failed 且永不 reject，此处仅兜执行器自身意外
      //（如 failPipeline 落库抛错）——置 failed + err_logs 留痕，保证 pending 行不会悬挂
      try {
        db.prepare(`UPDATE kb_files SET status='failed', error_msg=?, parsed_at=NULL WHERE id=?`)
          .run(String(e?.message || e || '未知原因').slice(0, 500), started.fileId);
      } catch { }
      try {
        db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)')
          .run('kb-ingestion', `库#${kb.id} 异步摄取失败：${e?.message || e}`, now());
      } catch { }
    });
    return res.json({ code: 0, data: { id: started.fileId, status: 'pending', async: true } });
  }

  // 同步模式（默认）：await 全管道（内部完成 pending→processing→success/failed 状态流转与落库）
  const r = await runIngestionPipeline(opts);
  if (!r.ok) return res.json({ code: 400, msg: r.msg }); // 失败文案逐字沿用改造前（存量用例兼容）
  res.json({ code: 0, data: { id: r.fileId, chunks: r.chunks } });
});

router.delete('/files/:fileId', (req, res) => {
  const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(req.params.fileId);
  const kb = f ? db.prepare('SELECT * FROM kbs WHERE id=?').get(f.kb_id) : null;
  const deny = denyIfNotAllowed(kb, req.user); // P5.30：文件级写操作同样校验库归属
  if (deny) return res.json(deny);
  db.prepare('DELETE FROM kb_chunks WHERE file_id=?').run(req.params.fileId);
  db.prepare('DELETE FROM kb_files WHERE id=?').run(req.params.fileId);
  res.json({ code: 0, msg: '已删除' });
});

// 重新解析（演示：仅刷新时间戳）
router.post('/files/:fileId/reparse', (req, res) => {
  const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(req.params.fileId);
  if (!f) return res.json({ code: 404, msg: '文件不存在' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(f.kb_id);
  const deny = denyIfNotAllowed(kb, req.user); // P5.30：同上
  if (deny) return res.json(deny);
  db.prepare("UPDATE kb_files SET status='success' WHERE id=?").run(f.id);
  res.json({ code: 0, msg: '重新解析完成' });
});

// 分块管理（P1 2026-10-28：列出/编辑/合并/删除单个 chunk）
router.get('/files/:fileId/chunks', (req, res) => {
  const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(req.params.fileId);
  if (!f) return res.json({ code: 404, msg: '文件不存在' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(f.kb_id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const rows = db.prepare('SELECT c.id, c.content, c.file_id, c.kb_id, c.keywords, c.metadata FROM kb_chunks c WHERE c.file_id=? ORDER BY c.id').all(req.params.fileId); // V1.2 #2：带出 metadata（分块编辑回显）
  res.json({ code: 0, data: { file: { id: f.id, name: f.name, kb_id: f.kb_id }, chunks: rows } });
});

// 手动补生成/重新生成关键词+问法（对存量分块，或内容编辑后刷新；无模型时友好提示）
router.post('/files/:fileId/generate-metadata', async (req, res) => {
  // V1.2 审查加固 2026-10-30：手动补抽取元数据（复刻 generate-keywords 交互）——先传文件后开
  // auto_metadata 的存量文件补抽取途径；库未开启开关时显式提示（防误以为已抽取）
  const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(req.params.fileId);
  if (!f) return res.json({ code: 404, msg: '文件不存在' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(f.kb_id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const r = await extractMetadataForFile(f.id);
  if (!r.ok) return res.json({ code: 400, msg: r.msg });
  if (r.skipped === 'no_provider') return res.json({ code: 0, data: { ...r, msg: '未配置可用模型供应商，已跳过抽取' } });
  if (r.skipped === 'disabled') return res.json({ code: 400, msg: '该库未开启「自动元数据」，请先在库设置中开启' });
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '补抽取元数据', `${kb.name} / ${f.name}（成功 ${r.extracted}/${r.total}）`, req.ip, now());
  res.json({ code: 0, data: r });
});

router.post('/files/:fileId/generate-keywords', async (req, res) => {
  const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(req.params.fileId);
  if (!f) return res.json({ code: 404, msg: '文件不存在' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(f.kb_id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const r = await generateForFile(f.id);
  if (!r.ok) return res.json({ code: 400, msg: r.msg });
  if (r.skipped === 'no_provider') return res.json({ code: 0, data: { ...r, msg: '未配置可用模型供应商，已跳过生成' } });
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '生成关键词', `${kb.name} / ${f.name}（成功 ${r.generated}/${r.total}）`, req.ip, now());
  res.json({ code: 0, data: r });
});

// 更新单个 chunk 内容（V1.2 #2 2026-10-30：同步接受 metadata 手工编辑——sanitizeMetadata 清洗后存 JSON 字符串；null/空对象存 NULL 即清除）
router.put('/chunks/:chunkId', (req, res) => {
  const c = db.prepare('SELECT * FROM kb_chunks WHERE id=?').get(req.params.chunkId);
  if (!c) return res.json({ code: 404, msg: '分块不存在' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(c.kb_id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const { content, metadata } = req.body || {};
  if (content == null) return res.json({ code: 400, msg: '请提供内容' });
  if (metadata !== undefined) {
    const clean = sanitizeMetadata(metadata);
    const metaSql = Object.keys(clean).length ? JSON.stringify(clean) : null;
    db.prepare('UPDATE kb_chunks SET content=?, metadata=? WHERE id=?').run(String(content || ''), metaSql, c.id);
  } else {
    db.prepare('UPDATE kb_chunks SET content=? WHERE id=?').run(String(content || ''), c.id);
  }
  // 更新文件 chunk_count（不做严格同步，简单 +1 即可）
  res.json({ code: 0, msg: '分块已更新' });
});

// 删除单个 chunk
router.delete('/chunks/:chunkId', (req, res) => {
  const c = db.prepare('SELECT * FROM kb_chunks WHERE id=?').get(req.params.chunkId);
  if (!c) return res.json({ code: 404, msg: '分块不存在' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(c.kb_id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  db.prepare('DELETE FROM kb_chunks WHERE id=?').run(c.id);
  res.json({ code: 0, msg: '已删除' });
});

// 合并相邻两个 chunk（sourceId 的内容合并到 targetId，然后删除 sourceId）
router.post('/chunks/merge', (req, res) => {
  const { sourceId, targetId } = req.body || {};
  if (!sourceId || !targetId) return res.json({ code: 400, msg: '请指定要合并的两个分块 ID' });
  const source = db.prepare('SELECT * FROM kb_chunks WHERE id=?').get(sourceId);
  const target = db.prepare('SELECT * FROM kb_chunks WHERE id=?').get(targetId);
  if (!source || !target) return res.json({ code: 404, msg: '分块不存在' });
  if (source.kb_id !== target.kb_id) return res.json({ code: 400, msg: '不能合并不同知识库的分块' });
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(source.kb_id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  db.prepare('UPDATE kb_chunks SET content=? WHERE id=?').run((source.content + '\n' + target.content).trim(), target.id);
  db.prepare('DELETE FROM kb_chunks WHERE id=?').run(source.id);
  res.json({ code: 0, msg: '已合并' });
});

// 可用 Rerank 模型列表（召回测试下拉用，2026-10-29 可视化升级）
router.get('/rerank-models', (req, res) => {
  res.json({ code: 0, data: rerankModels() });
});

// 召回测试（混合检索：BM25 + 向量加权 RRF 融合 + 可选 Rerank；P2 升级 async 双引擎，2026-10-29 支持权重/重排可视化参数）
router.post('/recall-test', async (req, res) => {
  const { kb_id, file_id, query, top_n, threshold, vector_weight, rerank_model, rerank_enabled, metadataFilter } = req.body || {};
  if (!query?.trim()) return res.json({ code: 400, msg: '请输入测试问题' });
  let kbId = kb_id || null;
  if (file_id) {
    const f = db.prepare('SELECT * FROM kb_files WHERE id=?').get(file_id);
    kbId = f ? f.kb_id : kbId;
  }
  // V1.1 读侧收口（V1.2 #2 2026-10-30 补齐）：召回测试可检索他人库内容，同样属读越权——
  // 与 logs/files 同模式先查 kb 校验归属；未指定库（全库检索）无归属可校验，仅管理员放行（fail-closed）
  if (kbId) {
    const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(kbId);
    const deny = denyIfNotAllowed(kb, req.user);
    if (deny) return res.json(deny);
  } else if (req.user.role !== 'admin') {
    return res.json({ code: 403, msg: '请选择知识库后测试（全库检索仅管理员可用）' });
  }
  // V1.2 #2 2026-10-30：元数据过滤参数——sanitizeMetadata 清洗后传 retrieve；空对象不传（与无过滤行为一致）
  const mFilter = sanitizeMetadata(metadataFilter);
  const hits = await retrieve(query, kbId, top_n || 5, threshold ?? 0.01, {
    vecWeight: vector_weight,               // 向量权重 0~1（默认 0.5，滑块实时调）
    rerankModel: rerank_model || null,      // 重排模型（下拉选择）
    rerankEnabled: rerank_enabled !== false, // 重排开关（对比效果用）
    ...(Object.keys(mFilter).length ? { metadataFilter: mFilter } : {}), // V1.2 #2：非空才下发（AND 语义，fail-closed）
  });
  res.json({ code: 0, data: { query, hits, count: hits.length, mode: 'hybrid' } });
});

// ---------- V1.3 #6 2026-10-30：知识库级召回评测集（保存/列表/重跑 diff/删除，全端点归属校验） ----------
// 背景：库变更（重传/切片参数调整/嵌入切换）后无量化对比是交付信心硬伤；与智能体级评测
// （agents.js，type='agent'）同表共存（evaluations.type='kb' + kb_id）。
// dataset 契约：[{ query, expect_terms: [标记词] }]；重跑 Top-1 命中判定与 diff 计算见 lib/kb-eval-regression.js

// 保存评测集（召回测试面板「保存为评测集」入口；dataset 校验：非空数组、每条 query 非空、
// expect_terms 归一为字符串数组截 8 项；整集截 50 条防超长重跑阻塞——沿用 agents.js 测评 slice 截断先例）
router.post('/:id/evaluations', (req, res) => {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const { name, dataset } = req.body || {};
  const safeName = String(name || '').trim().slice(0, 50); // 名称截 50 字符（防存储滥用）
  if (!safeName) return res.json({ code: 400, msg: '评测集名称不能为空' });
  if (!Array.isArray(dataset) || !dataset.length) return res.json({ code: 400, msg: '评测集 dataset 须为非空数组（[{query, expect_terms}]）' });
  const items = [];
  for (const it of dataset.slice(0, 50)) {
    const query = String(it?.query ?? '').trim();
    if (!query) return res.json({ code: 400, msg: '评测集每条数据须有非空 query' });
    const terms = (Array.isArray(it?.expect_terms) ? it.expect_terms : [])
      .map(t => String(t || '').trim()).filter(Boolean).slice(0, 8);
    items.push({ query, expect_terms: terms });
  }
  // score=NULL（从未重跑，列表显 '—'）+ result='[]'；type='kb' + kb_id 与智能体侧隔离
  const info = db.prepare(`INSERT INTO evaluations (name,kb_id,type,dataset,status,score,result,created_at)
    VALUES (?,?,?,?,'done',NULL,'[]',datetime('now','localtime'))`)
    .run(safeName, kb.id, 'kb', JSON.stringify(items));
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '保存知识库评测集', `${kb.name} / ${safeName}（${items.length} 条）`, req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid, count: items.length } });
});

// 评测集列表（该库全部，id DESC；score=NULL 表示从未重跑，前端显 '—'；附带 dataset 条数）
router.get('/:id/evaluations', (req, res) => {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const rows = db.prepare(`SELECT id,name,score,created_at,dataset FROM evaluations WHERE kb_id=? AND type='kb' ORDER BY id DESC`).all(kb.id);
  const data = rows.map(r => {
    let count = 0;
    try { const arr = JSON.parse(r.dataset || '[]'); if (Array.isArray(arr)) count = arr.length; } catch { count = 0; }
    return { id: r.id, name: r.name, score: r.score ?? null, created_at: r.created_at, dataset_count: count };
  });
  res.json({ code: 0, data });
});

// 重跑单个评测集并返回 diff（旧 score=null → diff='首次'；变化 ±0.02 内 → '持平'；否则 ±x.xx）
router.post('/:id/evaluations/:eid/rerun', async (req, res) => {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const ev = db.prepare('SELECT * FROM evaluations WHERE id=?').get(req.params.eid);
  // 归属校验：评测集必须存在于该库（防跨库 eid 越权重跑他人评测集）
  if (!ev || ev.type !== 'kb' || ev.kb_id !== kb.id) return res.json({ code: 404, msg: '评测集不存在或不属于该知识库' });
  const r = await rerunEvalSet(ev);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '知识库评测回归', `${kb.name} / ${ev.name}：${r.prev_score == null ? '首次' : r.prev_score} → ${r.score}（${r.diff}）`, req.ip, now());
  res.json({ code: 0, data: r });
});

// 删除评测集（知识库侧独立端点——agents.js 的 DELETE /evaluations/:id 是智能体侧路由且按 agent_id
// 归属校验，kb 型行无 agent_id 会被其 404 拦截，故此处按库归属校验后删，前端「评测集」页专用）
router.delete('/:id/evaluations/:eid', (req, res) => {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const ev = db.prepare('SELECT * FROM evaluations WHERE id=?').get(req.params.eid);
  if (!ev || ev.type !== 'kb' || ev.kb_id !== kb.id) return res.json({ code: 404, msg: '评测集不存在或不属于该知识库' });
  db.prepare('DELETE FROM evaluations WHERE id=?').run(ev.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '删除知识库评测集', `${kb.name} / ${ev.name}`, req.ip, now());
  res.json({ code: 0, msg: '已删除' });
});

// 知识图谱检索（GraphRAG）：给定查询文本，返回已知实体与关联关系上下文
router.post('/:id/graph-search', async (req, res) => {
  const { query, top_k } = req.body || {};
  if (!query?.trim()) return res.json({ code: 400, msg: '请输入查询内容' });
  // V1.1 读侧收口（V1.2 #2 2026-10-30 补齐）：图谱检索同样暴露库内容，与 logs/files 同模式校验归属
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const data = retrieveGraph(query, req.params.id, top_k || 5);
  res.json({ code: 0, data });
});

// V1.2 #2 2026-10-30：元数据筛选选项——返回该库全部分块的 distinct 元数据键值聚合（前端筛选下拉数据源）。
// metadata 为 JSON 文本，从 JS 侧解析聚合（SQL 不便按键展开）；损坏 JSON/非对象值跳过；owner/admin 可见（denyIfNotAllowed 同权）
router.get('/:id/meta-options', (req, res) => {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(req.params.id);
  const deny = denyIfNotAllowed(kb, req.user);
  if (deny) return res.json(deny);
  const rows = db.prepare("SELECT c.metadata FROM kb_chunks c WHERE c.kb_id=? AND c.metadata IS NOT NULL AND c.metadata != ''").all(kb.id);
  const byKey = new Map(); // 键 → Set(去重值集）
  for (const r of rows) {
    let meta = null;
    try { meta = JSON.parse(r.metadata); } catch { continue; } // 损坏 JSON 跳过
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    for (const [k, v] of Object.entries(meta)) {
      if (!k || !k.trim()) continue;
      if (!byKey.has(k)) byKey.set(k, new Set());
      const set = byKey.get(k);
      if (typeof v === 'string') { if (v) set.add(v); }
      else if (Array.isArray(v)) v.forEach(x => { if (typeof x === 'string' && x) set.add(x); }); // 数组值摊平进选项集
    }
  }
  // V1.2 审查加固 2026-10-30：返回 {keys, options} 双结构——原平铺写法在自定义键恰为 "keys" 时会覆盖
  // 键列表字段（sanitizeMetadata 键白名单不设限）；options 内为全部键的 distinct 值集，keys 为键名列表
  const options = {};
  for (const [k, set] of byKey) options[k] = [...set];
  res.json({ code: 0, data: { keys: [...byKey.keys()], options } });
});

module.exports = router;
