/**
 * 文件解析公共库（P5.14 文件一等变量）
 *
 * 从 knowledge.js 上传逻辑提取的公共函数：PDF / DOCX / XLSX / TXT / MD → 纯文本
 * 供两处共用：知识库上传（切片入库）+ 工作流文件上传（wf_files 表，节点间流转）
 * P5.28：新增 XLSX/XLS/CSV 解析（星辰「整理文件」场景——Excel 信息提取；xlsx 库逐 sheet 转 Markdown 表格文本）
 */
const FILE_EXTS = ['pdf', 'docx', 'xlsx', 'xls', 'csv', 'txt', 'md', 'markdown', 'pptx']; // 白名单

/** 解析文件 buffer → { ext, text }；不支持的扩展名抛错（调用方返回 400） */
async function parseFileBuffer(name, buf) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  if (!FILE_EXTS.includes(ext)) {
    throw new Error(`暂不支持 .${ext} 格式，支持：${FILE_EXTS.map(e => e.toUpperCase()).join(' / ')}`);
  }
  let text = '';
  if (ext === 'pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buf });
    try {
      const parsed = await parser.getText();
      text = parsed?.text || '';
    } finally {
      try { await parser.destroy(); } catch { }
    }
  } else if (ext === 'docx') {
    const mammoth = require('mammoth');
    const parsed = await mammoth.extractRawText({ buffer: buf });
    text = parsed.value || '';
  } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    // P5.28：表格类逐 sheet 提取为「Markdown 表格」文本（模型可直接做汇总/透视/脑图大纲）
    const XLSX = require('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const parts = [];
    for (const sheetName of wb.SheetNames.slice(0, 10)) { // 最多 10 个 sheet 防爆炸
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }).slice(0, 200); // 每 sheet 最多 200 行
      if (!rows.length) continue;
      parts.push(`### Sheet: ${sheetName}\n` + rows.map(r => '| ' + r.map(c => String(c ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |').join('\n'));
    }
    text = parts.join('\n\n') || '（空表格）';
  } else if (ext === 'pptx') {
    // P2 2026-10-28：PPTX 解析——用 jszip 解压后提取各 slide XML 的纯文本，按幻灯片分页切片
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buf);
    const slideFiles = Object.keys(zip.files).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort();
    const slideTexts = [];
    for (const sf of slideFiles) {
      const xmlData = await zip.files[sf].async('text');
      // 提取所有 <a:t> 标签内的文本（PowerPoint 的文本内容存储方式）
      const texts = [];
      const tagRe = /<a:t[^>]*>([^<]*)<\/a:t>/g;
      let m;
      while ((m = tagRe.exec(xmlData)) !== null) {
        const t = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        if (t) texts.push(t);
      }
      // 每条消息间用一个空行隔开（保留自然段落感）
      slideTexts.push(texts.join('\n'));
    }
    text = slideTexts.map((s, i) => `### 幻灯片 ${i + 1}\n\n${s}`).join('\n\n---\n\n');
    if (!text.trim()) text = '（空演示文稿）';
  } else { // txt / md / markdown
    text = buf.toString('utf-8');
  }
  text = (text || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  return { ext, text };
}

/** 富文件对象（Runner 运行态）：results 里 start.file 变量的值形态 */
function fileToRich(row) {
  return {
    __file: row.id,
    id: row.id,
    name: row.name,
    ext: row.ext || '',
    size: Number(row.size) || 0,
    text: row.text_content || '',
    url: `/api/files/${row.id}/download`,
  };
}

/** 富对象 → LLM 可读文本表示（render 注入格式；code 节点可正则取 id：#(\d+)） */
function fileToText(f) {
  const kb = f.size >= 1048576 ? (f.size / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(f.size / 1024)) + 'KB';
  return `[📄 文件 #${f.id}：${f.name}（${kb}，解析 ${f.text.length} 字）]\n${f.text}`;
}

module.exports = { FILE_EXTS, parseFileBuffer, fileToRich, fileToText };
