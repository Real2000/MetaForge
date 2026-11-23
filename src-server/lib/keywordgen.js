/**
 * 自动关键词/问法生成（2026-10-29）：
 * 上传文件解析分块后，对每个"可检索单元"（子分片，或无父子结构的独立分片）调用已配置模型生成
 * 3-5 个关键词 + 2-3 个问法，存入 kb_chunks.keywords（JSON {keywords:[], questions:[]}）。
 * 检索时 BM25 通道同时索引关键词与问法文本（retriever.js _idx 扩展），用户"换个说法"提问也能命中。
 * 约束：best-effort——无已配置供应商/演示模式/单块解析失败均静默跳过，不阻塞上传与检索主流程。
 */
const { db } = require('../db');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { chatOnce, getConfiguredProviders } = require('./llm');

const CONCURRENCY = 4;   // 并发生成数（避免打爆网关限流）
const MAX_CHUNKS = 300;  // 单文件生成上限（防超大文件一次性消耗过多 token）

/** 解析模型输出为 {keywords, questions}。容忍 ```json 代码块包裹与杂讯，解析失败返回 null */
function parseMeta(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const kw = (Array.isArray(j.keywords) ? j.keywords : []).map(s => String(s || '').trim()).filter(Boolean).slice(0, 6);
    const qs = (Array.isArray(j.questions) ? j.questions : []).map(s => String(s || '').trim()).filter(Boolean).slice(0, 4);
    if (!kw.length && !qs.length) return null;
    return { keywords: kw, questions: qs };
  } catch { return null; }
}

/** 为单个分块生成关键词+问法。无已配置供应商/演示模式/失败返回 null（调用方静默跳过） */
async function genForChunk(content) {
  if (getConfiguredProviders().length === 0) return null; // 无真实模型（含演示模式）
  const prompt = `为下面的文本片段生成检索辅助元数据，严格只输出 JSON（不要任何多余文字、不要代码块）：
{"keywords":["关键词1","关键词2"],"questions":["问法1","问法2"]}
要求：keywords 为 3-5 个核心关键词（含同义词/行业术语）；questions 为 2-3 个用户可能就此内容提问的说法。

片段：${String(content || '').slice(0, 1200)}`;
  const r = await chatOnce([{ role: 'user', content: prompt }], { temperature: 0.2, max_reply: 300 });
  if (!r || r.mode === 'mock' || !r.full) return null;
  return parseMeta(r.full);
}

/** 对指定文件的全部可检索单元生成关键词（上传后 fire-and-forget / 手动补生成均可调用） */
async function generateForFile(fileId) {
  const file = dal.getq('SELECT id, kb_id, name FROM kb_files WHERE id=?', [fileId]);
  if (!file) return { ok: false, msg: '文件不存在' };
  if (getConfiguredProviders().length === 0) return { ok: true, generated: 0, skipped: 'no_provider' };
  // 可检索单元：无子分片引用的块（即全部子分片 + 无父子结构的独立分块；父分片是拼接容器，跳过避免重复消耗）
  const rows = dal.q(`
    SELECT c.id, c.content FROM kb_chunks c
    WHERE c.file_id = ? AND c.content IS NOT NULL AND length(trim(c.content)) >= 8
      AND NOT EXISTS (SELECT 1 FROM kb_chunks p WHERE p.parent_id = c.id)
  `, [fileId]);
  if (!rows.length) return { ok: true, generated: 0, skipped: 'no_chunks' };
  const targets = rows.slice(0, MAX_CHUNKS);
  let generated = 0, failed = 0, idx = 0;
  const worker = async () => {
    while (idx < targets.length) {
      const row = targets[idx++];
      try {
        const meta = await genForChunk(row.content);
        if (meta) { dal.runq('UPDATE kb_chunks SET keywords=? WHERE id=?', [JSON.stringify(meta), row.id]); generated++; } else failed++;
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { ok: true, file: file.name, total: targets.length, generated, failed, truncated: rows.length > MAX_CHUNKS };
}

module.exports = { generateForFile, genForChunk, parseMeta, MAX_CHUNKS };
