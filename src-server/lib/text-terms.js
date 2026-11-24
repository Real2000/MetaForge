/**
 * 文本分词单一事实源（PG-5 tsvector PoC，2026-11-24）
 *
 * 背景：BM25-lite 的「词 + 中文 2-gram」分词此前内联于 retriever.js（检索端）——PG-5 候选集
 * 方案要求**写侧**（摄取/编辑/合并/关键词生成/搬运回填）与**读侧**（检索）严格同口径，
 * 否则 tsv 索引词与检索查询词不一致（召回回归）。抽独立模块消除复制漂移：
 *   - retriever.js（读侧打分/查询词/候选集 tsquery）
 *   - ingestion-pipeline.js（摄取双写）、knowledge.js（编辑/合并双写）、keywordgen.js（关键词回填）
 *   - scripts/migrate-to-pg.js（存量回填）
 *
 * _idx 口径（与 retriever.retrieve 的索引文本构造严格一致）：content + 自动关键词/问法扩展。
 */
'use strict';

/** 小写 + 去符号 + 切空白词（\p{L}\p{N} 保字母数字——含 CJK；产物不含 tsquery 特殊字符） */
function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);
}

/** tokenize 词 + 中文相邻 2-gram（去重）——BM25-lite 检索词域（历史口径，黄金基线锚定勿改语义） */
function terms(s) {
  const set = new Set(tokenize(s));
  const joined = (s || '').replace(/\s+/g, '');
  for (let i = 0; i + 1 < joined.length; i++) set.add(joined.slice(i, i + 2));
  return [...set];
}

/** keywords JSON（{keywords:[], questions:[]}）→ 扩展文本——损坏 JSON/缺字段按空处理（与
 *  retriever._idx 构造的容错语义一致：仅用原文） */
function keywordsExt(keywordsJson) {
  if (!keywordsJson) return '';
  try {
    const meta = JSON.parse(keywordsJson);
    const extra = [...(meta.keywords || []), ...(meta.questions || [])].filter(Boolean).join('\n');
    return extra || '';
  } catch { return ''; }
}

/** 索引文本（_idx 同款）：content + keywords 扩展——写侧 tsv 与读侧 _idx 的统一口径 */
function idxText(content, keywordsJson) {
  const ext = keywordsExt(keywordsJson);
  return ext ? `${content || ''}\n${ext}` : String(content || '');
}

/** to_tsvector 入参串：预分词后空格连接——`simple` 配置不再二次分词，词边界完全由本模块
 *  决定（规避 PG 无中文分词器；与检索 tsquery 词域严格一致） */
function tsvText(content, keywordsJson) {
  return terms(idxText(content, keywordsJson)).join(' ');
}

module.exports = { tokenize, terms, keywordsExt, idxText, tsvText };
