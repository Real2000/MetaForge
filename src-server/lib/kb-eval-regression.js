/**
 * V1.3 #6 2026-10-30：知识库级召回评测回归（评测集重跑核心 + 库变更自动回归）
 *
 * 背景：知识库变更（重传/切片参数调整/嵌入切换）后无量化对比是交付信心硬伤。智能体级评测
 * （evaluations type='agent'，agents.js CRUD）已有，本模块补知识库侧（type='kb' + kb_id）：
 *   - rerunEvalSet(ev)：单个评测集重跑——逐条 Top-1 命中判定（expect_terms 任一词出现在 Top-1
 *     命中内容即 1 分）、平均分 0~1 两位小数、与旧分 diff（±0.02 内算持平）、结果落库；
 *   - runKbRegression(kbId, actor)：库内全部评测集逐个重跑 + 逐集写 op_logs + 汇总写
 *     notifications（username=库 owner）——供两个触发点 fire-and-forget 调用：
 *     ① PUT /knowledge/:id 切片参数实际变化（knowledge.js）；② 上传文件成功后（新内容入库）。
 *     异步执行，不阻塞触发请求的响应。
 */
const { db, now } = require('../db');
const { retrieve } = require('./retriever');

/** 单集分数变化摘要（通知 content 用）：首次评测 0.92 / 0.92 → 0.85（↓0.07）/ 0.90 → 0.90（持平） */
function trendText(r) {
  const fmt = v => (+v).toFixed(2); // 统一两位小数（0.5 → 0.50，与前端得分徽章一致）
  if (r.prev_score == null) return `首次评测 ${fmt(r.score)}`;
  if (r.diff === '持平') return `${fmt(r.prev_score)} → ${fmt(r.score)}（持平）`;
  return `${fmt(r.prev_score)} → ${fmt(r.score)}（${r.diff.startsWith('+') ? '↑' : '↓'}${r.diff.replace(/^[+-]/, '')}）`;
}

/**
 * 重跑单个知识库评测集（evaluations 行，type='kb'）。
 * 评分规则：逐条 dataset → retrieve(query, kb_id, 3, 0, { rerankEnabled:false })（跳重排保稳定、
 * 防重排模型抖动导致回归误报）；Top-1 命中判定 = expect_terms 任一词出现在 hits[0].content
 * （含父子/章节上下文增强后的内容，即最终喂给 LLM 的 RAG 片段）；无命中/空结果计 0 分。
 * score = 平均分（0~1，两位小数）；diff 与重跑前旧 score 比较：旧分 null → '首次'，
 * 变化 ±0.02 内 → '持平'，否则 '+x.xx' / '-x.xx'。
 * result 落库存逐条明细（query/hit/expected/score/top_file）。
 */
async function rerunEvalSet(ev) {
  let items = [];
  try { items = JSON.parse(ev.dataset || '[]'); } catch { items = []; }
  if (!Array.isArray(items)) items = [];
  const detail = [];
  let hitCount = 0;
  for (const it of items) {
    const query = String(it?.query ?? '').trim();
    const expectTerms = Array.isArray(it?.expect_terms)
      ? it.expect_terms.map(t => String(t || '').trim()).filter(Boolean) : [];
    let hit = false;
    let topFile = null;
    if (query) {
      try {
        const hits = await retrieve(query, ev.kb_id, 3, 0, { rerankEnabled: false });
        const top1 = hits[0] ? String(hits[0].content || '') : '';
        topFile = hits[0]?.file ?? null;
        hit = expectTerms.some(t => top1.includes(t)); // 任一标记词出现在 Top-1 即命中
      } catch { /* 单条检索异常按未命中计，不中断整个评测（回归的健壮性优先） */ }
    }
    if (hit) hitCount++;
    detail.push({ query, hit, expected: expectTerms, score: hit ? 1 : 0, top_file: topFile });
  }
  const score = items.length ? +(hitCount / items.length).toFixed(2) : 0;
  const prev = ev.score ?? null;
  let diff = '首次';
  if (prev != null) {
    const delta = +((score - prev).toFixed(2));
    diff = Math.abs(delta) <= 0.02 ? '持平' : (delta > 0 ? '+' + delta.toFixed(2) : delta.toFixed(2));
  }
  db.prepare(`UPDATE evaluations SET score=?, result=?, status='done' WHERE id=?`)
    .run(score, JSON.stringify(detail), ev.id);
  return { score, prev_score: prev, diff, detail };
}

/**
 * 库级自动回归（触发点入口）：该库全部评测集（type='kb'）逐个重跑，逐集写 op_logs
 * （action='知识库评测回归'，detail 含库名/评测集名/新旧分），并汇总写一条 notifications
 * （username=库 owner，title=知识库「库名」召回评测回归，content=每集分数变化摘要）。
 * 该库无评测集时静默跳过（不产生空通知噪音）；kb 不存在同样跳过（防删除竞态）。
 * actor={username, ip} 可选（触发者信息，写 op_logs 用，缺省归到库 owner）。
 */
async function runKbRegression(kbId, actor) {
  const kb = db.prepare('SELECT * FROM kbs WHERE id=?').get(kbId);
  if (!kb) return { ran: 0 };
  const evals = db.prepare(`SELECT * FROM evaluations WHERE kb_id=? AND type='kb' ORDER BY id`).all(kb.id);
  if (!evals.length) return { ran: 0 };
  const username = actor?.username || kb.owner;
  const ip = actor?.ip || '';
  const lines = [];
  for (const ev of evals) {
    const r = await rerunEvalSet(ev);
    lines.push(`${ev.name}：${trendText(r)}`);
    db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
      .run(username, '知识库评测回归', `${kb.name} / ${ev.name}：${r.prev_score == null ? '首次' : r.prev_score} → ${r.score}（${r.diff}）`, ip, now());
  }
  db.prepare('INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES (?,?,?,?,?,0,?)')
    .run(kb.owner, `知识库「${kb.name}」召回评测回归`, lines.join('；'), 'system', '#/knowledge', now());
  return { ran: evals.length };
}

module.exports = { rerunEvalSet, runKbRegression };
