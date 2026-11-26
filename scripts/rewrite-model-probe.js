'use strict';
/**
 * AI-R4 改写模型探测（M12，2026-11-26）：按「响应形态 + 延迟」自动挑选非 reasoning 快模型
 *
 * 背景：AI-Q1 实测（2026-11-25）确认当前网关文本模型全为 reasoning 形态——一次改写约 30s+
 *（~900 token 思考固定开销），而 chat 内联改写预算 8s，必然超时回落。D-11 触发条件：
 * 网关出现「单次改写 P50 ≤8s 且输出非思考形态」的模型即触发 AI-R1 复跑。
 *
 * 本脚本把该判据工程化：
 *   1. 从 providers（平台/租户可见）收集文本模型候选（过滤 TTS/图像/视频/嵌入等专用模型）；
 *   2. 对每个候选发一次真实改写请求（与 query-rewrite 同 prompt 形态），记录耗时与输出形态；
 *   3. 判定 eligible = 成功 && 输出落 content（非思考）&& 耗时 ≤ 8s && 净化后能提取出查询；
 *   4. 默认 dry-run 打印；--apply 把最快适格模型写入配置项 query_rewrite_model（生产写库需确认）。
 *
 * 运行：
 *   node scripts/rewrite-model-probe.js                 # 探测（会真实调用网关模型，产生少量配额）
 *   node scripts/rewrite-model-probe.js --apply         # 探测并应用最优模型到配置
 *   node scripts/rewrite-model-probe.js --models=dsv4.1,glm5.2   # 手工指定候选
 *   node scripts/rewrite-model-probe.js --timeout=45000  # 单模型观测宽限（默认 45s，判据仍是 ≤8s）
 *
 * 口径说明：单次实测近似 P50（reasoning 模型 30s+，多轮采样成本不成比例；接近 8s 边界的候选
 * 需复测时用 --models 单独多跑几轮）。
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const ARG = process.argv.slice(2);
const argOf = (name, def = '') => { const hit = ARG.find(a => a.startsWith(`--${name}=`)); return hit ? hit.split('=').slice(1).join('=') : def; };
const APPLY = ARG.includes('--apply');
const TENANT = Number(argOf('tenant', '0')) || 0;
const TIMEOUT_MS = Math.max(5000, Number(argOf('timeout', '45000')) || 45000);
const MANUAL = argOf('models', '').split(',').map(s => s.trim()).filter(Boolean);
const ELIGIBLE_MS = 8000; // D-11 判据：单次改写 ≤8s（对齐 chat 内联改写预算）

/** 非文本模型过滤：与 src-server/lib/llm.js NON_TEXT_MODEL_RE 同口径（smoke 锚定两处一致，防漂移） */
const NON_TEXT_MODEL_RE = /tts|asr|speech|whisper|embedding|rerank|image|video|audio|voice|ocr|t2v|a2v|realtime|sensevoice|minimax[\s-]?h\d|ref2va|bge/i;

/** 真实改写请求样例（带历史 + 指代问题——与 query-rewrite 生产 prompt 同形态） */
const PROBE_MESSAGES = [
  { role: 'system', content: '你是检索查询改写器。把用户最新问题改写为自包含、可独立检索的查询语句，只输出改写后的查询本身一行，不加解释。' },
  { role: 'user', content: '【对话历史】\n用户：年假和病假有什么区别\n助手：年假需提前三天申请；病假需返岗后两个工作日内补交证明\n\n【最新问题】前者需要提前多久\n【改写查询】' },
];

/** 收集模型候选：providers 可见集去重 + 非文本过滤；--models 手工指定时直接用 */
function collectModels() {
  if (MANUAL.length) return MANUAL.filter(m => !NON_TEXT_MODEL_RE.test(m));
  const { getConfiguredProviders } = require(path.join(ROOT, 'src-server', 'lib', 'llm'));
  const providers = getConfiguredProviders(TENANT);
  const out = [];
  const seen = new Set();
  for (const p of providers) {
    let models = [];
    try { models = JSON.parse(p.models || '[]'); } catch { models = []; }
    for (const m of models) {
      const name = String(m || '').trim();
      if (!name || seen.has(name) || NON_TEXT_MODEL_RE.test(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** 单模型探测：一次真实改写调用；形态按 content（非思考）/ full-only（思考）/ empty 分类 */
async function probeOne(model) {
  const { chatOnce } = require(path.join(ROOT, 'src-server', 'lib', 'llm'));
  const { sanitize, extractQueryLike } = require(path.join(ROOT, 'src-server', 'lib', 'query-rewrite'));
  const t0 = Date.now();
  let ms = 0, ok = false, form = 'error', query = '', err = '';
  try {
    const r = await chatOnce(PROBE_MESSAGES, { model, temperature: 0, max_reply: 2000, hardTimeoutMs: TIMEOUT_MS });
    ms = Date.now() - t0;
    if (!r || r.mode === 'mock') {
      form = 'mock'; err = '无真实模型（网关未配置/不可用）';
    } else {
      ok = true;
      const content = String(r.content || '').trim();
      const full = String(r.full || '').trim();
      // 形态判定：content 非空 = 非思考形态（可直接消费）；content 空而 full 有 = reasoning 思考形态
      form = content ? 'content' : (full ? 'thinking' : 'empty');
      const src = content || (full.split('\n').map(x => x.trim()).filter(Boolean).pop() || '');
      query = sanitize(extractQueryLike(src) || src) || '';
    }
  } catch (e) {
    ms = Date.now() - t0;
    err = String((e && e.message) || e).slice(0, 160);
    form = /timeout|abort/i.test(err) ? 'timeout' : 'error';
  }
  const eligible = ok && form === 'content' && ms <= ELIGIBLE_MS && !!query;
  return { model, ok, ms, form, eligible, query: query.slice(0, 80), error: err };
}

async function main() {
  const models = collectModels();
  if (!models.length) {
    console.log('[probe] 无可探测的文本模型（providers 未配置或全为专用模型）');
    return { ok: false, models: [] };
  }
  console.log(`[probe] 候选 ${models.length} 个（tenant=${TENANT}，单模型宽限 ${TIMEOUT_MS}ms，判据 ≤${ELIGIBLE_MS}ms + content 形态）`);
  const results = [];
  for (const m of models) {
    process.stdout.write(`  [probe] ${m} ... `);
    const r = await probeOne(m);
    results.push(r);
    console.log(`${r.ok ? '✅' : '❌'} ${r.ms}ms 形态=${r.form}${r.eligible ? ' 【适格】' : ''}${r.query ? ` → ${r.query}` : ''}${r.error ? `（${r.error}）` : ''}`);
  }
  const eligible = results.filter(r => r.eligible).sort((a, b) => a.ms - b.ms);
  const verdict = eligible.length
    ? `存在 ${eligible.length} 个适格模型，最快：${eligible[0].model}（${eligible[0].ms}ms）`
    : '无适格模型（D-11 触发条件未满足——AI-R1 维持条件触发、如实归档）';
  console.log(`\n[probe] 结论：${verdict}`);

  const out = {
    probed_at: new Date().toISOString(),
    tenant: TENANT,
    eligible_ms: ELIGIBLE_MS,
    verdict,
    best: eligible.length ? eligible[0].model : null,
    results,
  };
  const outPath = path.join(ROOT, '.temp', 'rewrite-model-probe.json');
  try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify(out, null, 1)); console.log(`[probe] 明细 → ${outPath}`); } catch (e) { console.warn('[probe] 明细落盘失败：', e.message); }

  if (APPLY) {
    if (!eligible.length) {
      console.log('[probe] --apply 跳过：无适格模型可应用');
    } else {
      const cfg = require(path.join(ROOT, 'src-server', 'lib', 'config'));
      const prev = cfg.get('query_rewrite_model') || '';
      cfg.set('query_rewrite_model', eligible[0].model);
      console.log(`[probe] 已应用配置 query_rewrite_model：${prev || '(空)'} → ${eligible[0].model}`);
    }
  } else if (eligible.length) {
    console.log(`[probe] 如需应用：node scripts/rewrite-model-probe.js --apply（或手工 POST /api/config 设置 query_rewrite_model=${eligible[0].model}）`);
  }
  return out;
}

if (require.main === module) {
  main().then(r => process.exit(r && r.ok === false ? 1 : 0)).catch(e => { console.error('探测失败：', (e && e.stack) || e); process.exit(1); });
}

module.exports = { collectModels, probeOne, NON_TEXT_MODEL_RE, ELIGIBLE_MS };