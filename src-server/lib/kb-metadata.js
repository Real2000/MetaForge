/**
 * 分块元数据管理（V1.2 #2 2026-10-30）：
 * 知识库开启 auto_metadata 时，上传文件解析分块后对每个"可检索单元"（子分片，或无父子结构的
 * 独立分片）调用已配置模型抽取固定 schema 元数据，存入 kb_chunks.metadata（JSON 对象）。
 * 约定键：dept（部门名，字符串或数组）/ level（密级：公开|内部|机密）/ doc_type（文档类型）。
 * 约束：best-effort——库未开启 auto_metadata / 无已配置供应商 / 单块解析失败均静默跳过，
 * 不阻塞上传与检索主流程（复刻 keywordgen.js 模式）。
 * 合并写入：已有 metadata（人工编辑）优先，LLM 仅填充缺失键，不覆盖人工数据。
 */
const { db } = require('../db');
const { chatOnce, getConfiguredProviders } = require('./llm');

const CONCURRENCY = 4;   // 并发抽取数（避免打爆网关限流，与 keywordgen 同口径）
const MAX_CHUNKS = 300;  // 单文件抽取上限（防超大文件一次性消耗过多 token）
const META_KEYS = ['dept', 'level', 'doc_type'];           // LLM 抽取的固定 schema 键
const LEVEL_WHITELIST = ['内部', '机密'];                     // LLM 只能标降级密级（防诱导标公开反向提权，公开须人工标注）
const META_JSON_LIMIT = 2048;                              // 单块 metadata JSON 总长上限（字符）
// V1.2 审查加固 2026-10-30：无部门用户的 fail-closed 哨兵值（含 NUL 控制字符）——sanitizeMetadata 剥离全部控制
// 字符，落库元数据值永远无法构造出等于哨兵的字符串，防「无部门用户精确命中被打了哨兵值的块」的穿透
const NO_DEPT_SENTINEL = '\u0000__no_dept__';
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/g; // 控制字符（含 NUL）——键名与值一律剥离

/** 剥离控制字符（V1.2 审查加固：防哨兵值/控制字符穿透 fail-closed 语义） */
function stripCtrl(s) { return String(s || '').replace(CTRL_RE, ''); }

/**
 * 元数据清洗（路由写入与 LLM 抽取共用）：
 * 仅保留字符串/字符串数组值；键白名单不设限，但键名/值剥控制字符后截 32 字符、数组截 8 项（去重）；
 * 全等哨兵值的条目显式丢弃（双保险）；总 JSON 超 2KB 时按插入序丢弃尾部键；始终返回纯对象。
 */
function sanitizeMetadata(obj) {
  // 字符串入参容忍（JSON 文本），解析失败视为空对象
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return {}; }
  }
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = stripCtrl(k).trim().slice(0, 32);
    if (!key) continue;
    if (typeof v === 'string') {
      const s = stripCtrl(v).trim();
      if (s && s !== NO_DEPT_SENTINEL) out[key] = s.slice(0, 32);
    } else if (Array.isArray(v)) {
      const arr = [...new Set(v.filter(x => typeof x === 'string' && x.trim() && x !== NO_DEPT_SENTINEL).map(x => stripCtrl(x).trim().slice(0, 32)))].slice(0, 8);
      if (arr.length) out[key] = arr;
    } // 其余类型（数字/嵌套对象等）直接丢弃——检索过滤只支持字符串语义
  }
  // 总量护栏：超限按插入序丢弃尾部键（保证落库 JSON 恒 ≤2KB）
  let keys = Object.keys(out);
  while (keys.length && JSON.stringify(out).length > META_JSON_LIMIT) {
    delete out[keys.pop()];
  }
  return out;
}

/** 解析模型输出为元数据对象。容忍 ```json 代码块包裹与杂讯；level 白名单外丢弃（LLM 只能标降级密级）；空串键不写入；解析失败返回 null */
function parseMetaText(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const out = {};
    for (const k of META_KEYS) {
      const v = j ? j[k] : undefined;
      if (typeof v !== 'string') continue;
      const s = stripCtrl(v).trim();
      if (!s) continue; // 空串键不写入（视为该维度无信息）
      if (k === 'level' && !LEVEL_WHITELIST.includes(s)) continue; // V1.2 审查加固：LLM 标「公开」丢弃——文档内容可诱导 LLM 把机密标公开（fail-closed 反向提权），公开必须人工标注
      out[k] = s.slice(0, 32);
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/** 为单个分块抽取元数据。无已配置供应商/演示模式/失败返回 null（调用方静默跳过） */
async function genForChunk(content) {
  if (getConfiguredProviders().length === 0) return null; // 无真实模型（含演示模式）
  const prompt = `为下面的文本片段抽取元数据，严格只输出 JSON（不要任何多余文字、不要代码块）：
{"dept":"部门名或空","level":"内部|机密或空","doc_type":"制度|流程|合同|报告|手册|其他"}
要求：dept 为该片段内容主要适用的部门名称（通用内容输出空串）；level 仅在内容明显含敏感信息时标注 内部 或 机密 二选一（公开级或无法判断均输出空串，公开级由人工标注）；doc_type 从 制度/流程/合同/报告/手册/其他 中选最贴近的一项。

片段：${String(content || '').slice(0, 1200)}`;
  const r = await chatOnce([{ role: 'user', content: prompt }], { temperature: 0.1, max_reply: 200 });
  if (!r || r.mode === 'mock' || !r.full) return null;
  return parseMetaText(r.full);
}

/**
 * 对指定文件的全部可检索单元抽取元数据（上传后 fire-and-forget / 手动补生成均可调用）。
 * 库未开启 auto_metadata 返回 skipped='disabled'；无已配置供应商返回 skipped='no_provider'。
 * 合并写入：先读现值，已有 metadata（人工编辑）优先，LLM 仅填充缺失键。
 */
async function extractMetadataForFile(fileId) {
  const file = db.prepare('SELECT id, kb_id, name FROM kb_files WHERE id=?').get(fileId);
  if (!file) return { ok: false, msg: '文件不存在' };
  const kb = db.prepare('SELECT id, auto_metadata FROM kbs WHERE id=?').get(file.kb_id);
  if (!kb || !kb.auto_metadata) return { ok: true, extracted: 0, skipped: 'disabled' };
  if (getConfiguredProviders().length === 0) return { ok: true, extracted: 0, skipped: 'no_provider' };
  // 可检索单元：无子分片引用的块（与 keywordgen 同口径——父分片是拼接容器，跳过避免重复消耗）
  const rows = db.prepare(`
    SELECT c.id, c.content, c.metadata FROM kb_chunks c
    WHERE c.file_id = ? AND c.content IS NOT NULL AND length(trim(c.content)) >= 8
      AND NOT EXISTS (SELECT 1 FROM kb_chunks p WHERE p.parent_id = c.id)
  `).all(fileId);
  if (!rows.length) return { ok: true, extracted: 0, skipped: 'no_chunks' };
  const targets = rows.slice(0, MAX_CHUNKS);
  const upd = db.prepare('UPDATE kb_chunks SET metadata=? WHERE id=?');
  let extracted = 0, failed = 0, idx = 0;
  const worker = async () => {
    while (idx < targets.length) {
      const row = targets[idx++];
      try {
        const meta = await genForChunk(row.content);
        if (!meta) { failed++; continue; }
        // 合并写入：已有 metadata（人工编辑）优先，LLM 仅填充缺失键。
        // V1.2 审查加固 2026-10-30：UPDATE 前重读现值再合并——抽取耗时秒级，期间用户经 chunks PUT 手工编辑
        // 同一块时，若按任务开始时的快照合并会覆盖用户刚保存的人工值（读-改-写竞态）
        let existing = {};
        try {
          const fresh = db.prepare('SELECT metadata FROM kb_chunks WHERE id=?').get(row.id);
          if (fresh && fresh.metadata && fresh.metadata !== '{}') {
            const e = JSON.parse(fresh.metadata);
            if (e && typeof e === 'object' && !Array.isArray(e)) existing = e;
          }
        } catch { /* 现值损坏 JSON 视为无元数据，LLM 结果整体写入 */ }
        const clean = sanitizeMetadata({ ...meta, ...existing }); // existing 在后覆盖 meta：人工值优先
        if (Object.keys(clean).length) {
          upd.run(JSON.stringify(clean), row.id);
          extracted++;
        } else failed++;
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { ok: true, file: file.name, total: targets.length, extracted, failed, truncated: rows.length > MAX_CHUNKS };
}

/**
 * V1.2 #2 2026-10-30（审查加固后迁入 lib，供 chat/share/openapi/workflow 四链路共用，避免循环依赖）：
 * 解析智能体的知识库元数据过滤声明（agents.kb_metadata_filter，JSON 对象，AND 语义）。
 * 值支持 "$user.dept" 占位符——chat 时替换为请求用户 dept 文本名；无用户链路（分享页/开放 API）或
 * 用户无 dept 时该键置哨兵值（落库元数据值经 sanitizeMetadata 已无控制字符，永不命中——fail-closed 防误授权）；
 * 非占位符键照常生效（固定值过滤在无用户链路同样适用）。无效 JSON/null/空对象返回 null（不过滤）。
 */
function resolveKbFilter(agent, user) {
  if (!agent || !agent.kb_metadata_filter) return null;
  let f = null;
  try { f = JSON.parse(agent.kb_metadata_filter); } catch { return null; }
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    out[k] = v === '$user.dept'
      ? ((user && user.dept) ? user.dept : NO_DEPT_SENTINEL) // 无用户/无部门 → 恒不命中（fail-closed，不兑底放开）
      : v;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { extractMetadataForFile, sanitizeMetadata, parseMetaText, resolveKbFilter, NO_DEPT_SENTINEL, MAX_CHUNKS };
