function graphTerms(text) {
  if (!text) return [];
  const result = new Set();
  // 基本中文分词：取单个汉字和常用双字词（滑动窗口）
  const s = String(text);
  for (const c of s) {
    if (/[\u4e00-\u9fff]/.test(c)) result.add(c);
  }
  for (let i = 0; i < s.length - 1; i++) {
    const pair = s.slice(i, i + 2);
    if (/^[\u4e00-\u9fff]{2}$/.test(pair)) result.add(pair);
  }
  // 英文按空格/Tab/标点切分
  for (const t of s.split(/[\s,，。、；：！？\t\n\r.?!;:]/)) {
    const clean = t.replace(/[^\w]/g, '').trim().toLowerCase();
    if (clean && clean.length >= 2) result.add(clean);
  }
  return [...result];
}