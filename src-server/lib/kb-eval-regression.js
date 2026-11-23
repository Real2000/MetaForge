/**
 * V1.3 #6 2026-10-30：知识库级召回评测回归（评测集重跑核心 + 库变更自动回归）
 * M4 AI-03（2026-11-23）：评分口径从「仅 Top-1 命中」升级为多指标——Recall@K / MRR / NDCG / hit@K，
 * 聚合指标落 evaluations.metrics（JSON）；score（Top-1 均分）保留为向后兼容字段（通知/趋势/前端得分徽章不变）。
 *
 * 背景：知识库变更（重传/切片参数调整/嵌入切换）后无量化对比是交付信心硬伤。智能体级评测
 * （evaluations type='agent'，agents.js CRUD）已有，本模块补知识库侧（type='kb' + kb_id）：
 *   - rerunEvalSet(ev)：单个评测集重跑——逐条检索 Top-K（K=10，跳重排保稳定），
 *     ① Top-1 命中判定（expect_terms 任一词出现在 hits[0].content，与旧口径逐字一致）
 *     ② 多指标：hit@K（任一命中）/ recall@K（期望词在 Top-K 的覆盖率）/ MRR（首个命中排名倒数）
 *        / NDCG@K（二值相关性折损累计，排名越靠前贡献越大）；
 *   - runKbRegression(kbId, actor)：库内全部评测集逐个重跑 + 逐集写 op_logs + 汇总写
 *     notifications（username=库 owner）——供两个触发点 fire-and-forget 调用：
 *     ① PUT /knowledge/:id 切片参数实际变化（knowledge.js）；② 上传文件成功后（新内容入库）。
 *     异步执行，不阻塞触发请求的响应。
 */
const { db, now } = require('../db');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { retrieve } = require('./retriever');

const EVAL_K = 10; // 多指标评估口径 K（Top-K 检索深度）

/** 单集分数变化摘要（通知 content 用）：首次评测 0.92 / 0.92 → 0.85（↓0.07）/ 0.90 → 0.90（持平） */
function trendText(r) {
  const fmt = v => (+v).toFixed(2); // 统一两位小数（0.5 → 0.50，与前端得分徽章一致）
  if (r.prev_score == null) return `首次评测 ${fmt(r.score)}`;
  if (r.diff === '持平') return `${fmt(r.prev_score)} → ${fmt(r.score)}（持平）`;
  return `${fmt(r.prev_score)} → ${fmt(r.score)}（${r.diff.startsWith('+') ? '↑' : '↓'}${r.diff.replace(/^[+-]/, '')}）`;
}

/**
 * 单条用例的排序指标（纯函数，供单测）：给定 Top-K 检索内容与期望词列表。
 * relFlags[i] = 第 i 位命中是否包含任一期望词（二值相关性）。
 *  - top1 / hitK / rank：首位命中、Top-K 内命中、首个命中排名（1 基，0=未命中）
 *  - recall：期望词在 Top-K 内容中的覆盖率（0~1）
 *  - mrr：1/rank（未命中 0）
 *  - ndcg：二值相关性 DCG/IDCG——IDCG 按命中条数 R=min(相关数, K) 理想排布折损累计
 *    （评测集无法穷举全集相关文档，以检索集内相关条数为 R 是评测界通行近似）
 */
function rankMetrics(contents, expectTerms) {
  const list = (Array.isArray(contents) ? contents : []).map(c => String(c || ''));
  const terms = (Array.isArray(expectTerms) ? expectTerms : []).map(t => String(t || '').trim()).filter(Boolean);
  const relFlags = list.map(c => terms.some(t => c.includes(t)));
  const firstHit = relFlags.indexOf(true);
  const rank = firstHit >= 0 ? firstHit + 1 : 0;
  const recall = terms.length
    ? terms.filter(t => list.some(c => c.includes(t))).length / terms.length
    : 0;
  let dcg = 0;
  relFlags.forEach((rel, i) => { if (rel) dcg += 1 / Math.log2(i + 2); });
  const r = relFlags.filter(Boolean).length;
  let idcg = 0;
  for (let i = 0; i < r; i++) idcg += 1 / Math.log2(i + 2);
  return {
    top1: relFlags[0] === true,
    hitK: r > 0,
    rank,
    recall: Math.round(recall * 100) / 100,
    mrr: rank ? Math.round((1 / rank) * 1000) / 1000 : 0,
    ndcg: idcg > 0 ? Math.round((dcg / idcg) * 1000) / 1000 : 0,
  };
}

/** 聚合多指标（items 为 rankMetrics 输出数组）：Top-1 均分沿用旧 score 口径；其余为均值（两位小数） */
function aggregateMetrics(items) {
  const n = items.length || 0;
  const mean = f => n ? Math.round((items.reduce((s, it) => s + (f(it) || 0), 0) / n) * 100) / 100 : 0;
  return {
    k: EVAL_K, cases: n,
    top1: mean(it => it.top1 ? 1 : 0),
    hit_at_k: mean(it => it.hitK ? 1 : 0),
    recall_at_k: mean(it => it.recall),
    mrr: mean(it => it.mrr),
    ndcg: mean(it => it.ndcg),
  };
}

/**
 * 重跑单个知识库评测集（evaluations 行，type='kb'）。
 * 评分规则：逐条 dataset → retrieve(query, kb_id, EVAL_K, 0, { rerankEnabled:false })（跳重排保稳定、
 * 防重排模型抖动导致回归误报）；Top-1 命中判定与旧口径逐字一致（expect_terms 任一词出现在 hits[0].content，
 * 含父子/章节上下文增强后的内容，即最终喂给 LLM 的 RAG 片段）；无命中/空结果计 0 分。
 * score = Top-1 平均分（0~1，两位小数）——向后兼容字段（通知/趋势/前端徽章沿用）；
 * metrics = 多指标聚合 JSON（evaluations.metrics 列，AI-03）：hit@K / recall@K / MRR / NDCG；
 * result 逐条明细在旧字段（query/hit/expected/score/top_file）基础上增补 rank/recall/mrr/ndcg/hit_k（前端兼容）。
 * diff 与重跑前旧 score 比较：旧分 null → '首次'，变化 ±0.02 内 → '持平'，否则 '+x.xx' / '-x.xx'。
 */
async function rerunEvalSet(ev) {
  let items = [];
  try { items = JSON.parse(ev.dataset || '[]'); } catch { items = []; }
  if (!Array.isArray(items)) items = [];
  const detail = [];
  const metricsItems = [];
  let hitCount = 0;
  for (const it of items) {
    const query = String(it?.query ?? '').trim();
    const expectTerms = Array.isArray(it?.expect_terms)
      ? it.expect_terms.map(t => String(t || '').trim()).filter(Boolean) : [];
    let hit = false;
    let topFile = null;
    let per = { top1: false, hitK: false, rank: 0, recall: 0, mrr: 0, ndcg: 0 };
    if (query) {
      try {
        const hits = await retrieve(query, ev.kb_id, EVAL_K, 0, { rerankEnabled: false });
        const contents = hits.map(h => String(h.content || ''));
        topFile = hits[0]?.file ?? null;
        per = rankMetrics(contents, expectTerms);
        hit = per.top1; // Top-1 命中与旧口径逐字一致（expect_terms 任一词出现在首位内容）
      } catch { /* 单条检索异常按未命中计，不中断整个评测（回归的健壮性优先） */ }
    }
    if (hit) hitCount++;
    metricsItems.push(per);
    detail.push({
      query, hit, expected: expectTerms, score: hit ? 1 : 0, top_file: topFile,
      // AI-03 增补字段（旧字段全部保留，前端/基线导入零破坏）
      rank: per.rank, recall: per.recall, mrr: per.mrr, ndcg: per.ndcg, hit_k: per.hitK,
    });
  }
  const score = items.length ? +(hitCount / items.length).toFixed(2) : 0;
  const metrics = aggregateMetrics(metricsItems);
  const prev = ev.score ?? null;
  let diff = '首次';
  if (prev != null) {
    const delta = +((score - prev).toFixed(2));
    diff = Math.abs(delta) <= 0.02 ? '持平' : (delta > 0 ? '+' + delta.toFixed(2) : delta.toFixed(2));
  }
  dal.runq(`UPDATE evaluations SET score=?, result=?, metrics=?, status='done' WHERE id=?`, [score, JSON.stringify(detail), JSON.stringify(metrics), ev.id]);
  return { score, prev_score: prev, diff, metrics, detail };
}

/**
 * 库级自动回归（触发点入口）：该库全部评测集（type='kb'）逐个重跑，逐集写 op_logs
 * （action='知识库评测回归'，detail 含库名/评测集名/新旧分+多指标），并汇总写一条 notifications
 * （username=库 owner，title=知识库「库名」召回评测回归，content=每集分数变化摘要）。
 * 该库无评测集时静默跳过（不产生空通知噪音）；kb 不存在同样跳过（防删除竞态）。
 * actor={username, ip} 可选（触发者信息，写 op_logs 用，缺省归到库 owner）。
 */
async function runKbRegression(kbId, actor) {
  const kb = dal.getq('SELECT * FROM kbs WHERE id=?', [kbId]);
  if (!kb) return { ran: 0 };
  const evals = dal.q(`SELECT * FROM evaluations WHERE kb_id=? AND type='kb' ORDER BY id`, [kb.id]);
  if (!evals.length) return { ran: 0 };
  const username = actor?.username || kb.owner;
  const ip = actor?.ip || '';
  const lines = [];
  for (const ev of evals) {
    const r = await rerunEvalSet(ev);
    lines.push(`${ev.name}：${trendText(r)}（hit@${r.metrics.hit_at_k} / 召回@${r.metrics.recall_at_k} / MRR ${r.metrics.mrr} / NDCG ${r.metrics.ndcg}）`);
    dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [username, '知识库评测回归', `${kb.name} / ${ev.name}：${r.prev_score == null ? '首次' : r.prev_score} → ${r.score}（${r.diff}）；hit@${r.metrics.hit_at_k} / 召回@${r.metrics.recall_at_k} / MRR ${r.metrics.mrr} / NDCG ${r.metrics.ndcg}`, ip, now()]);
  }
  dal.runq('INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES (?,?,?,?,?,0,?)', [kb.owner, `知识库「${kb.name}」召回评测回归`, lines.join('；'), 'system', '#/knowledge', now()]);
  return { ran: evals.length };
}

module.exports = { rerunEvalSet, runKbRegression, rankMetrics, aggregateMetrics, EVAL_K };
