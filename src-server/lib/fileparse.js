/**
 * 文件解析公共库（P5.14 文件一等变量）
 *
 * 从 knowledge.js 上传逻辑提取的公共函数：PDF / DOCX / XLSX / TXT / MD → 纯文本
 * 供两处共用：知识库上传（切片入库）+ 工作流文件上传（wf_files 表，节点间流转）
 * P5.28：新增 XLSX/XLS/CSV 解析（星辰「整理文件」场景——Excel 信息提取；xlsx 库逐 sheet 转 Markdown 表格文本）
 * P6 2026-10-29：PDF 解析从纯文本升级为增强型——自动检测表格结构并转为 Markdown 表格文本（enhancedPdfText.js）
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
      const rawText = parsed?.text || '';
      // P6 2026-10-29：用增强型 PDF 文本解析替换纯文本 — 自动检测表格转为 Markdown
      const { enhancePdfText } = require('./enhancedPdfText');
      const enhanced = enhancePdfText(rawText);
      text = enhanced.text;
      // 元数据注入：tables 字段通过 parsed 对象的附加属性传递（调用方可选使用）
      if (enhanced.tables.length) { parsed._tables = enhanced.tables; parsed._hasTables = true; }
    } finally {
      try { await parser.destroy(); } catch { }
    }
  } else if (ext === 'docx') {
    const mammoth = require('mammoth');
    const parsed = await mammoth.extractRawText({ buffer: buf });
    text = parsed.value || '';
  } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    // P5.28：表格类逐 sheet 提取为「Markdown 表格」文本（模型可直接做汇总/透视/脑图大纲）
    // P1-5 2026-11-03：exceljs 替换已弃用的 xlsx 包（xlsx 已从 package.json 移除，require 会报 MODULE_NOT_FOUND）
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const parts = [];
    for (let si = 0; si < Math.min(wb.worksheets.length, 10); si++) {
      const ws = wb.getWorksheet(si + 1);
      if (!ws) continue;
      const sheetName = ws.name || ('Sheet' + (si + 1));
      const rows = [];
      let rowIndex = 0;
      ws.eachRow({ includeEmpty: false }, (row) => {
        if (++rowIndex > 200) return; // 每 sheet 最多 200 行
        const cells = [];
        row.eachCell({ includeEmpty: false }, (cell) => {
          cells.push(cell.value != null ? String(cell.value).replace(/\|/g, '\\|') : '');
        });
        rows.push('| ' + cells.join(' | ') + ' |');
      });
      if (!rows.length) continue;
      parts.push(`### Sheet: ${sheetName}\n` + rows.join('\n'));
    }
    text = parts.join('\n\n') || '（空表格）';
  } else if (ext === 'pptx') {
    // P2 2026-10-28：PPTX 解析——用 jszip 解压后提取各 slide XML 的纯文本，按幻灯片分页切片
    let zip;
    try {
      const JSZip = require('jszip');
      zip = await JSZip.loadAsync(buf);
    } catch (e) {
      throw new Error(`PPT 文件解析失败（可能是文件损坏）：${e.message}`);
    }
    const slideFiles = Object.keys(zip.files).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort();
    if (!slideFiles.length) {
      throw new Error('PPT 文件中未找到任何幻灯片内容（可能不是有效的 PPTX 文件或文件已损坏）');
    }
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
  // PDF 纯文本表格增强：识别由空格/制表符对齐的表格结构并转为 Markdown 表格
  if (ext === 'pdf') text = enhanceTableText(text);
  text = (text || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  return { ext, text };
}

/**
 * 从纯文本中识别由空格/制表符对齐的表格并转为 Markdown 表格格式。
 * 检测逻辑：
 *   1. 连续 3 行以上、每行由 3+ 列组成（按 2+ 空格/制表符分隔）
 *   2. 首行推测为表头
 *   3. 列数量一致时转为 | 表格语法
 * 零新依赖、轻量启发式。典型覆盖：程序输出/类 CSV 文本/对齐报表。
 * 对于复杂表格（跨行/合并单元格）能力有限，建议专门解析器如 camelot。
 */
function enhanceTableText(str) {
  const lines = (str || '').split('\n');
  if (lines.length < 3) return str;
  const cellRe = /\S+(?:\s{2,}|\t)\S+/; // 至少两列，列间 2+ 空格或 tab
  let inBlock = false;
  const blocks = []; // [{start, end, cols}]
  let start = -1, header = -1, lastColCount = 0;
  for (let i = 0; i <= lines.length; i++) {
    const line = i < lines.length ? lines[i] : null;
    const cols = line && cellRe.test(line) ? line.split(/\s{2,}|\t+/).filter(Boolean).length : 0;
    if (cols > 1) {
      if (!inBlock) { start = i; header = i; inBlock = true; lastColCount = cols; }
    } else {
      if (inBlock && i - start >= 3 && lastColCount > 1) {
        blocks.push({ start, end: i, cols: lastColCount });
      }
      inBlock = false; start = -1; lastColCount = 0;
    }
  }
  if (blocks.length === 0) return str;
  // 从后往前替换，保持行号不变
  let result = lines.slice();
  for (let b = blocks.length - 1; b >= 0; b--) {
    const { start: s, end: e } = blocks[b];
    const rows = lines.slice(s, e).map(l => l.split(/\s{2,}|\t+/).filter(Boolean));
    // 取列数众数作为标准列数
    const colCounts = rows.map(r => r.length);
    const mode = colCounts.sort((a, z) => colCounts.filter(c => c === a).length - colCounts.filter(c => c === z).length).pop();
    const validRows = rows.filter(r => r.length === mode);
    if (validRows.length < 3) continue;
    const headerLine = '| ' + validRows[0].map(c => c.trim()).join(' | ') + ' |';
    const sepLine = '| ' + validRows[0].map(() => '---').join(' | ') + ' |';
    const dataLines = validRows.slice(1).map(r => '| ' + r.map(c => c.trim()).join(' | ') + ' |');
    const replacement = [headerLine, sepLine, ...dataLines].join('\n');
    result.splice(s, e - s, replacement);
  }
  return result.join('\n');
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

module.exports = { FILE_EXTS, parseFileBuffer, fileToRich, fileToText, enhanceTableText };
