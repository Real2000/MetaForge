'use strict';
/**
 * AI-R2/AI-R1 重跑评分器（M12 资产化；原 .temp/aiq1-rerun-score.js）
 *
 * 运行（隔离库 + 生产网关真实模型）：
 *   AGENT_DATA_DIR=.temp/aiq1-rerun node scripts/eval-rerun.js --probe    # off 基线防饱和探针（零改写 LLM 成本）
 *   AGENT_DATA_DIR=.temp/aiq1-rerun node scripts/eval-rerun.js --score    # 全量：AI-01 20 对 + AI-10 10 问
 *   AGENT_DATA_DIR=.temp/aiq1-rerun node scripts/eval-rerun.js --score --only=ai01
 *
 * 判定口径（验收原文）：
 *   AI-01：off = 原句（含指代）直接检索 Top5；on = 消解改写后检索 Top5；增益 = on_rate − off_rate ≥ 25pp
 *   AI-10：off = 单路检索；on = multiQuery+HyDE；召回增益 ≥ 10pp 且延迟中位数增量 ≤ 800ms
 * 期望实体严格命中（对照原跑分教训：expect 不含「提前/支持」类通用词，只含消解实体）。
 *
 * 模型：env AIQ1_MODEL > 配置项 query_rewrite_model > 资产默认 dsv4.1（AI-R4 路由基建）。
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const A = require('./eval-assets');

const MODE = process.argv.includes('--score') ? 'score' : 'probe';
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || ''; // score 分段：ai01/ai10
const OUT = (process.argv.find(a => a.startsWith('--out=')) || '').split('=')[1] || '.temp/aiq1-rerun-result.json';

/** 改写模型解析：env > 配置项（AI-R4）> 资产默认 */
function resolveModel() {
  if (process.env.AIQ1_MODEL) return process.env.AIQ1_MODEL;
  try {
    const cfg = require(path.join(ROOT, 'src-server', 'lib', 'config'));
    const v = cfg && typeof cfg.get === 'function' ? cfg.get('query_rewrite_model') : '';
    if (v) return String(v);
  } catch { /* 配置层不可用 → 资产默认 */ }
  return A.MODEL_REWRITE;
}

async function main() {
  const { db } = require(path.join(ROOT, 'src-server', 'db'));
  const { retrieve } = require(path.join(ROOT, 'src-server', 'lib', 'retriever'));
  const kb = db.prepare('SELECT id FROM kbs WHERE name=?').get(A.KB_NAME);
  if (!kb) throw new Error('评测库不存在——先跑 scripts/eval-kb-build.js');
  const kbId = kb.id;
  const chunks = db.prepare('SELECT COUNT(*) c FROM kb_chunks WHERE kb_id=?').get(kbId).c;
  const MODEL_REWRITE = resolveModel();
  console.log(`[rerun] kb#${kbId}（${chunks} 块）模式=${MODE} 改写模型=${MODE === 'score' ? MODEL_REWRITE : '(未用)'}`);

  const R = { mode: MODE, kb_chunks: chunks, model_rewrite: MODEL_REWRITE, started_at: new Date().toISOString(), ai01: null, ai10: null };

  /* ---------- off 检索（两阶段共用）：原句直查，Top-N 含期望实体为命中 ---------- */
  const offHit = async (q, expect) => {
    try {
      const hits = await retrieve(q, kbId, A.TOP_N, 0.001, { rerankEnabled: false, multiQuery: false });
      return hits.some(h => expect.test(h.content || ''));
    } catch { return false; }
  };

  if (MODE === 'probe') {
    // —— 防饱和探针：20 对 + 10 问 off 基线命中统计（零改写 LLM 成本）——
    const t0 = Date.now();
    let p01Hit = 0; const p01Detail = [];
    for (const p of A.AI01_PAIRS) {
      const hit = await offHit(p.q, p.expect);
      if (hit) p01Hit++;
      p01Detail.push({ q: p.q, hit });
    }
    let q10Hit = 0;
    for (const item of A.AI10_QUERIES) { if (await offHit(item.q, item.expect)) q10Hit++; }
    R.probe = {
      duration_s: +((Date.now() - t0) / 1000).toFixed(1),
      ai01_off_rate: +(p01Hit / A.AI01_PAIRS.length * 100).toFixed(0),
      ai10_off_rate: +(q10Hit / A.AI10_QUERIES.length * 100).toFixed(0),
      ai01_detail: p01Detail,
      saturated: (p01Hit / A.AI01_PAIRS.length * 100) >= 80,
      note: 'off 命中 ≥80% 视为基线仍饱和（干扰不足）；预期显著低于 100% 才有 on 侧增益空间',
    };
    console.log(`[probe] AI-01 off 基线 ${p01Hit}/${A.AI01_PAIRS.length}（${R.probe.ai01_off_rate}%），AI-10 off ${q10Hit}/${A.AI10_QUERIES.length}（${R.probe.ai10_off_rate}%），${R.probe.duration_s}s`);
    for (const d of p01Detail) console.log(`  ${d.hit ? '✅' : '❌'} off ${d.q}`);
  } else {
    // ================= AI-01：20 对 on/off 对照（真实消解改写） =================
    const { rewriteQuery } = require(path.join(ROOT, 'src-server', 'lib', 'query-rewrite'));
    let onHit = 0, offHit01 = 0; const ai01Detail = [];
    for (const p of A.AI01_PAIRS) {
      const history = p.h.map(([q, a]) => ({ role: 'user', content: q }, { role: 'assistant', content: a })).flat();
      const hitOff = await offHit(p.q, p.expect);
      let rewritten = null, hitOn = false;
      try {
        rewritten = await rewriteQuery(p.q, history, { model: MODEL_REWRITE, timeoutMs: 60000 });
        const hits = await retrieve(rewritten || p.q, kbId, A.TOP_N, 0.001, { rerankEnabled: false, multiQuery: false });
        hitOn = hits.some(h => p.expect.test(h.content || ''));
      } catch { /* 回落原句已在 off 体现 */ }
      onHit += hitOn ? 1 : 0; offHit01 += hitOff ? 1 : 0;
      ai01Detail.push({ q: p.q, rewritten: String(rewritten || '').slice(0, 70), hitOn, hitOff });
      console.log(`  [ai01] ${hitOn && !hitOff ? '📈' : hitOn && hitOff ? '✅' : '❌'} off=${hitOff} on=${hitOn} 「${p.q}」→ ${String(rewritten || '').slice(0, 50)}`);
    }
    R.ai01 = {
      target: 'AI-01 多轮指代召回提升 ≥25pp',
      pairs: A.AI01_PAIRS.length, on_hit: onHit, off_hit: offHit01,
      on_rate: +(onHit / A.AI01_PAIRS.length * 100).toFixed(0),
      off_rate: +(offHit01 / A.AI01_PAIRS.length * 100).toFixed(0),
      gain_pp: +(((onHit - offHit01) / A.AI01_PAIRS.length) * 100).toFixed(0),
      pass: ((onHit - offHit01) / A.AI01_PAIRS.length * 100) >= 25,
      detail: ai01Detail,
    };
    console.log(`[ai01] on ${onHit}/${A.AI01_PAIRS.length}（${R.ai01.on_rate}%） vs off ${offHit01}/${A.AI01_PAIRS.length}（${R.ai01.off_rate}%），增益 ${R.ai01.gain_pp}pp ${R.ai01.pass ? '✅' : '❌'}`);

    if (ONLY && ONLY !== 'ai10') { R.finished_at = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(R, null, 1)); console.log(`\n==== 重跑score（仅 ai01）完成 → ${OUT} ====`); process.exit(0); }

    // ================= AI-10：10 问多路+HyDE on/off 对照 + 延迟中位数 =================
    let onHit10 = 0, offHit10 = 0; const offMs = [], onMs = []; const ai10Detail = [];
    for (const item of A.AI10_QUERIES) {
      let t = Date.now();
      const hitOff = await offHit(item.q, item.expect);
      offMs.push(Date.now() - t);
      offHit10 += hitOff ? 1 : 0;
      t = Date.now();
      let hitOn = false;
      try {
        const hits = await retrieve(item.q, kbId, A.TOP_N, 0.001, { rerankEnabled: false, multiQuery: true, hyde: true });
        hitOn = hits.some(h => item.expect.test(h.content || ''));
      } catch { /* */ }
      onMs.push(Date.now() - t);
      onHit10 += hitOn ? 1 : 0;
      ai10Detail.push({ q: item.q, hitOn, hitOff, on_ms: onMs[onMs.length - 1], off_ms: offMs[offMs.length - 1] });
      console.log(`  [ai10] off=${hitOff}(${offMs[offMs.length - 1]}ms) on=${hitOn}(${onMs[onMs.length - 1]}ms) 「${item.q}」`);
    }
    const median = (arr) => { const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
    R.ai10 = {
      target: 'AI-10 开启后召回 +10pp 且延迟 +≤800ms',
      queries: A.AI10_QUERIES.length, on_hit: onHit10, off_hit: offHit10,
      recall_off: +(offHit10 / A.AI10_QUERIES.length * 100).toFixed(0),
      recall_on: +(onHit10 / A.AI10_QUERIES.length * 100).toFixed(0),
      gain_pp: +(((onHit10 - offHit10) / A.AI10_QUERIES.length) * 100).toFixed(0),
      latency_off_median_ms: median(offMs), latency_on_median_ms: median(onMs),
      latency_delta_ms: median(onMs) - median(offMs),
      pass: ((onHit10 - offHit10) / A.AI10_QUERIES.length * 100 >= 10) && (median(onMs) - median(offMs) <= 800),
      detail: ai10Detail,
    };
    console.log(`[ai10] on ${onHit10}/${A.AI10_QUERIES.length}（${R.ai10.recall_on}%） vs off ${offHit10}/${A.AI10_QUERIES.length}（${R.ai10.recall_off}%），增益 ${R.ai10.gain_pp}pp；延迟中位 off ${R.ai10.latency_off_median_ms}ms → on ${R.ai10.latency_on_median_ms}ms（Δ${R.ai10.latency_delta_ms}ms）${R.ai10.pass ? '✅' : '❌'}`);
  }

  R.finished_at = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(R, null, 1));
  console.log(`\n==== 重跑${MODE}完成 → ${OUT} ====`);
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => { console.error('重跑失败：', (e && e.stack) || e); process.exit(1); });
}

module.exports = { resolveModel, main };