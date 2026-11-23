/**
 * 长期记忆语义召回（M4 AI-05，2026-11-23）
 *
 * 动机：原注入为固定 `ORDER BY type ASC, confidence DESC LIMIT 20` 全量注入——与当前问题无关的
 * 记忆也挤进 system prompt：① 稀释关键上下文；② 无关记忆干扰回答（计划表取证：注入量应下降 ≥50%）。
 *
 * 改造（对齐 Dify 记忆按相关性注入）：
 *   1. 记忆 fact 与当前 query 同构嵌入 → cosine 相关性排序 → 仅注入 Top-K（默认 8）；
 *   2. 评分 = 相似度 × 置信度权重 × 时间衰减（长期未用/低置信记忆降权，衰减基点 last_used_at）；
 *   3. 写入侧同义合并：新 fact 与既有记忆 cosine > 0.92 视为同义——更新既有行（措辞取新）而非新增近义重复。
 *
 * 0 阻断（对齐 AI-01 改写 / AI-06 压缩的降级哲学）：
 *   - 嵌入优先 bge-m3 网关（与 kb_chunks 同供应商/同引擎标签），不可用自动降级本地哈希；
 *   - 任何异常回落旧行为（固定排序 LIMIT），绝不阻断对话；
 *   - 记忆超量（>64 条）只取最近 64 条参与召回（保证单批嵌入成本可控且引擎一致）。
 *
 * 向量格式与 kb_chunks 完全一致（复用 retriever.encodeVec/parseVec：engine tag B3/H + 小端 float32 BLOB），
 * 双引擎规则同 retriever AI-02：查询与全部参与记忆同引擎，杜绝混维。
 */
const { db, now } = require('../db');
const { embed, bgeEmbed, parseVec, encodeVec } = require('./retriever');

const RECALL_LIMIT = 64;   // 参与召回的最大记忆条数（单批嵌入上限 1+63）
const DEFAULT_TOP_K = 8;   // 默认注入条数（原 20 → 8，注入量 -60%）
// 写入侧同义合并阈值（按嵌入引擎区分）：bge-m3 语义嵌入下无关句基准相似度本身有 0.2~0.5，
// 阈值须高（0.92）；本地哈希为稀疏 n-gram 袋，无关句 ~0.1、近义句 ~0.86，阈值须低（0.75）——
// 单一阈值要么误合（哈希引擎）要么漏合（语义引擎），故按 engine 取值
const MERGE_SIM = { B3: 0.92, H: 0.75 };
const DECAY_HALF_LIFE_DAYS = 90; // 时间衰减：90 天半衰期，下限 0.2（偏好类记忆不失效，只降权）

/** 解析库内时间（'YYYY-MM-DD HH:MM:SS'，Asia/Shanghai 本地态）为毫秒；失败返回 0 */
function parseTs(s) {
  if (!s) return 0;
  const t = new Date(String(s).replace(' ', 'T'));
  return Number.isFinite(t.getTime()) ? t.getTime() : 0;
}

/** 时间衰减因子：days<0（未来时间/时钟漂移）按 1 处理；下限 0.2 保证长期偏好仍可被强相关 query 拉回 */
function decayFactor(tsStr) {
  const t = parseTs(tsStr);
  if (!t) return 1; // 无时间基点（老数据/异常值）不惩罚，按满权重
  const days = (Date.now() - t) / 86400000;
  if (days <= 0) return 1;
  return Math.max(0.2, Math.exp(-days * Math.LN2 / DECAY_HALF_LIFE_DAYS));
}

/** 批量嵌入（DI 注入点：测试可传 fakeEmbed 跳过网关/本地引擎）。
 *  返回 { vecs: Float32Array[], engine: 'B3'|'H' }；texts 为空返回 { vecs: [], engine: 'H' }。
 *  引擎选择与 retriever 一致：优先 bge-m3 网关，失败/无供应商 → 本地哈希（全批同引擎）。 */
async function embedBatch(texts, opts = {}) {
  const list = (texts || []).map(t => String(t || '')).filter(t => t.trim());
  if (!list.length) return { vecs: [], engine: 'H' };
  if (typeof opts.fakeEmbed === 'function') {
    return { vecs: list.map(t => new Float32Array(opts.fakeEmbed(t))), engine: 'H' };
  }
  try {
    const got = await bgeEmbed(list);
    if (got && got.length === list.length) return { vecs: got.map(v => new Float32Array(v)), engine: 'B3' };
  } catch { /* 网关失败降级本地 */ }
  return { vecs: list.map(t => embed(t)), engine: 'H' };
}

/** 旧行为兜底排序（type ASC / confidence DESC / id DESC），供异常与空 query 路径复用 */
function legacyOrder(rows) {
  return rows
    .slice()
    .sort((a, b) => (a.type || '').localeCompare(b.type || '') || (b.confidence || 1) - (a.confidence || 1) || b.id - a.id);
}

/**
 * 按当前 query 语义相关性召回记忆（Top-K）。
 * @param {number} agentId   智能体 ID
 * @param {string} username  归属用户
 * @param {string} query     当前用户输入（空串 → 旧行为裁剪，不做嵌入）
 * @param {object} opts      { topK(默认8), trace(回写诊断对象), force(测试：跳过嵌入直接衰减排序?不——统一走嵌入), fakeEmbed }
 * @returns {Promise<Array<{id,fact,type,confidence,sim,score}>>}  注入用的记忆列表
 * 任何内部异常 → 回落 legacyOrder(rows).slice(0, 20)（与改造前行为等价，0 阻断）。
 */
async function recallMemories(agentId, username, query, opts = {}) {
  const topK = Math.max(1, Math.min(20, Math.floor(Number.isFinite(+opts.topK) ? +opts.topK : DEFAULT_TOP_K) || DEFAULT_TOP_K));
  const rows = db.prepare(`SELECT id, fact, type, confidence, embedding, created_at, last_used_at
    FROM agent_memories WHERE agent_id=? AND username=? ORDER BY id DESC LIMIT ?`).all(agentId, username, RECALL_LIMIT);
  const setTrace = (obj) => { if (opts.trace && typeof opts.trace === 'object') opts.trace.memory = obj; };
  if (!rows.length) { setTrace({ considered: 0, injected: 0 }); return []; }
  const q = String(query || '').trim();
  if (!q) {
    const legacy = legacyOrder(rows).slice(0, topK).map(r => ({ id: r.id, fact: r.fact, type: r.type, confidence: r.confidence }));
    setTrace({ considered: rows.length, injected: legacy.length, mode: 'legacy_no_query' });
    return legacy;
  }
  try {
    const parsed = rows.map(r => parseVec(r.embedding));
    const upd = db.prepare('UPDATE agent_memories SET embedding=? WHERE id=?');
    let engine = null;
    let qVec = null;
    let vecs = null;
    // 引擎一致性决策（与 retriever.retrieve 同模式三分支）
    if (parsed.every(p => p.engine === 'B3')) {
      const got = await bgeEmbed([q]);
      if (got) { engine = 'B3'; qVec = new Float32Array(got[0]); vecs = parsed.map(p => p.v); }
    }
    if (!qVec) {
      const missIdx = rows.map((_, i) => i).filter(i => parsed[i].engine !== 'B3');
      if (missIdx.length) {
        const got = await bgeEmbed([q, ...missIdx.map(i => rows[i].fact)]);
        if (got && got.length === missIdx.length + 1) {
          engine = 'B3';
          qVec = new Float32Array(got[0]);
          vecs = rows.map((r, i) => {
            const k = missIdx.indexOf(i);
            if (k >= 0) {
              try { upd.run(encodeVec(got[k + 1], 'B3'), r.id); } catch { }
              return new Float32Array(got[k + 1]);
            }
            return parsed[i].v; // 其余已有 B3 缓存
          });
        }
      }
    }
    if (!qVec) {
      // 本地哈希兜底：查询与全部记忆同引擎重算，懒缓存写回（与 kb_chunks 同模式）
      engine = 'H';
      qVec = embed(q);
      vecs = rows.map((r, i) => {
        if (parsed[i].engine === 'H') return parsed[i].v;
        const v = embed(r.fact);
        try { upd.run(encodeVec(v, 'H'), r.id); } catch { }
        return v;
      });
    }
    // 评分：sim × 置信度权重（0.5~1.0 区间，confidence 缺省 1.0 满权）× 时间衰减
    const scored = rows.map((r, i) => {
      let sim = 0;
      try {
        if (qVec.length === vecs[i].length) {
          let s = 0;
          for (let k = 0; k < qVec.length; k++) s += qVec[k] * vecs[i][k];
          sim = s;
        }
      } catch { sim = 0; }
      const conf = Number.isFinite(+r.confidence) ? Math.min(1, Math.max(0, +r.confidence)) : 1;
      return {
        id: r.id, fact: r.fact, type: r.type, confidence: r.confidence,
        sim: Math.round(sim * 1000) / 1000,
        score: sim * (0.5 + 0.5 * conf) * decayFactor(r.last_used_at || r.created_at),
      };
    }).sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, topK);
    // 命中回写 last_used_at（衰减基点前移——被用到的记忆保持活跃，单条 UPDATE IN 批量）
    if (picked.length) {
      try {
        const ph = picked.map(() => '?').join(',');
        db.prepare(`UPDATE agent_memories SET last_used_at=? WHERE id IN (${ph})`).run(now(), ...picked.map(p => p.id));
      } catch { /* 回写失败不影响召回 */ }
    }
    setTrace({
      engine, considered: rows.length, injected: picked.length,
      top_sim: scored.length ? scored[0].sim : 0,
    });
    return picked;
  } catch (e) {
    // 异常兜底：旧行为（type ASC / confidence DESC LIMIT 20），语义不变，0 阻断
    setTrace({ considered: rows.length, injected: 0, mode: 'fallback', error: String(e && e.message).slice(0, 120) });
    return legacyOrder(rows).slice(0, 20).map(r => ({ id: r.id, fact: r.fact, type: r.type, confidence: r.confidence }));
  }
}

/**
 * 记忆写入（含向量缓存与同义合并）——chat.js extractMemory 的落库段。
 * 去重三段：① 精确重复/互为子串（沿用改造前语义）；② 同义合并 cosine > MERGE_SIM → 更新既有行
 * （fact 取新措辞、置信度上调 0.05 封顶 1.0、last_used_at 前移）；③ 其余 INSERT（带 embedding）。
 * opts.fakeEmbed 供测试注入确定性嵌入。
 * 返回 { inserted, merged, skipped }。
 */
async function recordMemories({ agentId, username, facts, source = 'chat', opts = {} }) {
  const list = (Array.isArray(facts) ? facts : []).map(f => String(f || '').trim().slice(0, 40)).filter(Boolean);
  if (!list.length) return { inserted: 0, merged: 0, skipped: 0 };
  const existing = db.prepare('SELECT id, fact, type, confidence, embedding FROM agent_memories WHERE agent_id=? AND username=? ORDER BY id').all(agentId, username);
  let inserted = 0, merged = 0, skipped = 0;
  const pending = [];
  for (const f of list) {
    // ① 精确/子串去重（改造前语义逐字保留）
    if (existing.some(e => e.fact.includes(f) || f.includes(e.fact)) || pending.some(p => p.includes(f) || f.includes(p))) {
      skipped++;
      continue;
    }
    pending.push(f);
  }
  if (!pending.length) return { inserted, merged, skipped };
  // ② 同义合并：新 fact 与既有记忆批量同构嵌入后比对
  const { vecs: newVecs, engine } = await embedBatch(pending.concat(existing.map(e => e.fact)), opts);
  const nv = newVecs.slice(0, pending.length);
  const ev = newVecs.slice(pending.length);
  const ins = db.prepare('INSERT INTO agent_memories (agent_id,username,fact,type,confidence,source,created_at,embedding,last_used_at) VALUES (?,?,?,?,1.0,?,?,?,?)');
  const updMerge = db.prepare('UPDATE agent_memories SET fact=?, confidence=MIN(1.0, COALESCE(confidence,1.0)+0.05), last_used_at=?, embedding=? WHERE id=?');
  for (let i = 0; i < pending.length; i++) {
    const f = pending[i];
    const fv = nv[i];
    const mergeSim = MERGE_SIM[engine] || MERGE_SIM.H; // 引擎感知阈值（缺省取哈希口径，保守）
    let mergeTarget = -1;
    for (let j = 0; j < ev.length; j++) {
      if (!fv || !ev[j] || fv.length !== ev[j].length) continue;
      let s = 0;
      for (let k = 0; k < fv.length; k++) s += fv[k] * ev[j][k];
      if (s > mergeSim) { mergeTarget = j; break; }
    }
    if (mergeTarget >= 0) {
      // 同义合并：措辞取新（更完整/更新鲜），既有行 id/归属不动
      try {
        updMerge.run(f, now(), encodeVec(fv, engine), existing[mergeTarget].id);
        merged++;
      } catch { skipped++; }
      continue;
    }
    try {
      ins.run(agentId, username, f, /偏好|喜欢|不喜欢|希望|想要/.test(f) ? 'preference' : 'fact', source, now(), encodeVec(fv, engine), now());
      inserted++;
    } catch { skipped++; }
  }
  return { inserted, merged, skipped };
}

module.exports = { recallMemories, recordMemories, embedBatch, decayFactor, legacyOrder, MERGE_SIM, DEFAULT_TOP_K };