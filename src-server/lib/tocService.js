/**
 * TOC（目录）增强服务（2026-10-30）：
 * 上传文件后，调用 LLM 生成文档的目录结构（章节层级），
 * 切片后按章节标记每个分块的 chapter_id，
 * 检索时命中某个段落自动带上同章节上下文。
 *
 * 存储结构：
 *   kbs.toc: JSON[{title, level, chapterId}] — 整个文档的目录
 *   kb_chunks.chapter_id: INTEGER — 分块归属的章节ID
 */
const { db } = require('../db'); // 修复：lib/ 目录下应为 ../db（此前 './db' 导致模块加载失败被上游 catch 吞掉，TOC 从未生效）
const { chatOnce, getConfiguredProviders } = require('./llm');

/** 用 LLM 解析文本的目录结构 */
async function extractToc(text, chunkSize = 500) {
  if (getConfiguredProviders().length === 0) return null; // 无真实模型，跳过
  const prompt = `分析下面文档的章节结构，按层级列出所有标题（章、节、小节等），输出JSON数组。
只输出JSON，不要任何多余文字，不要代码块包裹。

示例格式：
[{"title":"第一章 总则","level":1},{"title":"第一条 目的","level":2},{"title":"第二条 适用范围","level":2},{"title":"第二章 考勤管理","level":1}]

要求：
- level 1 为章节（如"第一章"），level 2 为条/节，level 3 为小节
- 标题名不加编号，使用实际标题文字
- 至少3个字符以上的标题才纳入
- 无标题时输出空数组[]\n\n---\n\n${text.slice(0, 3000)}`;
  const r = await chatOnce([{ role: 'user', content: prompt }], { temperature: 0.1, max_reply: 800 });
  if (!r || r.mode === 'mock' || !r.full) return null;
  try {
    const m = r.full.match(/\[[\s\S]*?\]/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed)) return null;
    // 过滤和规范化
    return parsed
      .filter(item => item && item.title && typeof item.title === 'string' && item.title.trim().length >= 3)
      .map((item, idx) => ({
        title: item.title.trim(),
        level: typeof item.level === 'number' ? item.level : (item.level === 0 ? 0 : 1),
        chapterId: idx + 1,
        startChunkIdx: 0, // 由调用方填充
      }));
  } catch { return null; }
}

/** 对已生成的分块列表，分配 chapter_id（chunks 为 [{content}] 对象数组，原地写回 chapterId） */
function assignChapterIds(chunks, toc) {
  if (!toc || !toc.length) return;
  const sortedToc = [...toc].sort((a, b) => a.level - b.level || a.chapterId - b.chapterId);
  // 匹配策略：顺序扫描分块，文本包含某章节标题 → 切换章节；否则延续当前章节
  let currentCh = null;
  const chTextSet = sortedToc.map(t => t.title);
  for (let i = 0; i < chunks.length; i++) {
    const txt = typeof chunks[i] === 'object' ? String(chunks[i].content || '') : String(chunks[i]);
    let matchedCh = null;
    for (let j = chTextSet.length - 1; j >= 0; j--) {
      const ct = chTextSet[j];
      if (ct && ct.length >= 3 && txt.includes(ct)) { matchedCh = sortedToc[j].chapterId; break; }
    }
    if (matchedCh) currentCh = matchedCh;
    chunks[i] = { content: txt, chapterId: currentCh || null };
  }
}

module.exports = { extractToc, assignChapterIds };
