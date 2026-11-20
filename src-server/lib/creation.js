/**
 * 创作资产 V1 纯逻辑（D1-3，2026-11-20）
 *
 * 「素材库 + 项目 + 分镜」三件套的复用与合规判定，保持纯函数、可单测：
 *  - tokenize / assetReuseScore / matchAssets：生成时「优先引用已有资产」的匹配打分
 *    （不依赖向量模型，走中英分词 + 标签/名称/提示词重叠度，离线可用、零外部依赖）
 *  - reuseStats：素材复用率 = 已引用资产的镜头数 / 镜头总数（验收：第二个作品 ≥ 50%）
 *  - complianceOf：真人素材 / 数字人合规标记分级（真人素材与数字人单独合规评估）
 */

const CJK = /[\u4e00-\u9fff]/;

/** 中英混合分词：拉丁词按非字母数字切分；CJK 连续串取二元组（bigram），兼顾召回与零依赖 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Set();
  // 拉丁/数字词
  for (const w of s.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!w) continue;
    if (CJK.test(w)) {
      // 含中文：先抽拉丁片段，再对中文串做 bigram（单字也保留）
      let latin = w.replace(/[\u4e00-\u9fff]+/g, ' ');
      for (const lw of latin.split(/\s+/)) if (lw) tokens.add(lw);
      const cjk = w.replace(/[^一-龥]+/g, '');
      if (cjk.length === 1) tokens.add(cjk);
      for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk.slice(i, i + 2));
    } else {
      tokens.add(w);
    }
  }
  return tokens;
}

/** 归一化标签：字符串（逗号/顿号/空格分隔）或数组 → 去重小写数组 */
function normTags(tags) {
  let arr = [];
  if (Array.isArray(tags)) arr = tags;
  else if (typeof tags === 'string') arr = tags.split(/[,，、\s]+/);
  return [...new Set(arr.map(x => String(x).trim().toLowerCase()).filter(Boolean))];
}

/** 素材「可用文本」：名称 + 提示词 + 标签拼接 */
function assetHaystack(asset) {
  const a = asset || {};
  return `${a.name || ''} ${a.prompt || ''} ${normTags(a.tags).join(' ')}`;
}

/**
 * 复用相关度打分：查询 token 与素材文本 token 的重叠数（标签命中额外加权）。
 * @returns {number} 非负整数，越大越相关
 */
function assetReuseScore(asset, text) {
  const q = tokenize(text);
  if (!q.size) return 0;
  const hay = tokenize(assetHaystack(asset));
  let score = 0;
  for (const tk of q) if (hay.has(tk)) score++;
  // 标签精确命中加权（标签是人工策展的高信号）
  const qLower = String(text || '').toLowerCase();
  for (const tag of normTags(asset.tags)) if (tag && qLower.includes(tag)) score += 2;
  return score;
}

/**
 * 从候选素材中挑选「优先引用」列表（生成时先复用、后生成）。
 * @param {object[]} assets  候选素材（同项目/全局）
 * @param {string}   text    生成提示词/镜头描述
 * @param {object}   opts    { limit=5, minScore=1, kinds=[] }
 * @returns {Array<{asset, score}>} 按分数降序
 */
function matchAssets(assets, text, opts = {}) {
  const limit = opts.limit || 5;
  const minScore = opts.minScore == null ? 1 : opts.minScore;
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? new Set(opts.kinds) : null;
  return (assets || [])
    .filter(a => a && (!kinds || kinds.has(a.kind)))
    .map(a => ({ asset: a, score: assetReuseScore(a, text) }))
    .filter(x => x.score >= minScore)
    .sort((x, y) => y.score - x.score || (y.asset.id || 0) - (x.asset.id || 0))
    .slice(0, limit);
}

/** 素材复用率：已引用已有资产（asset_id 非空）的镜头占比 */
function reuseStats(shots) {
  const list = Array.isArray(shots) ? shots : [];
  const total = list.length;
  const reused = list.filter(s => s && s.asset_id != null && s.asset_id !== '').length;
  return { total, reused, rate: total ? +(reused / total).toFixed(4) : 0 };
}

/**
 * 合规分级：真人素材与数字人需单独合规评估（返回 P0/P1/OK 级别 + 说明 + 建议动作）。
 * @param {{real_person?:number|boolean, digital_human?:number|boolean}} flags
 */
function complianceOf(flags = {}) {
  const real = !!Number(flags.real_person);
  const dh = !!Number(flags.digital_human);
  if (real && dh) return { level: 'P0', code: 'real_person+digital_human', note: '真人肖像 + 数字人克隆（高风险）', action: '需取得本人书面授权与用途说明，人工复核后方可用于对外发布' };
  if (real) return { level: 'P1', code: 'real_person', note: '含真人肖像素材', action: '使用前确认肖像权授权范围，避免未授权商用' };
  if (dh) return { level: 'P1', code: 'digital_human', note: '含数字人/合成形象', action: '按《生成式AI服务管理》标注合成标识，禁止用于误导性场景' };
  return { level: 'OK', code: 'none', note: '无真人/数字人合规风险', action: '' };
}

module.exports = { tokenize, normTags, assetHaystack, assetReuseScore, matchAssets, reuseStats, complianceOf };
