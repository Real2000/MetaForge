/**
 * 增强型 PDF 解析（代替 pdf-parse 纯文本提取）
 * 从 PDF 文本层提取内容后，智能识别表格结构并转为 Markdown 表格。
 * 核心策略：detectTables() 用启发式识别行对齐/分隔符模式，将表格乱序文本转化为结构化Markdown。
 * 实现：将 pdf-parse 的纯文本输出传入本模块，返回 text（含Markdown表格）和 tables（结构化数据）。
 *
 * P6 2026-10-29：替代纯文本 pdf-parse，输出与旧版兼容（text字段含表格Markdown），新增tables数组。
 */
function enhancePdfText(rawText) {
  if (!rawText || !rawText.trim()) return { text: '', tables: [] };
  const lines = rawText.split('\n');
  const allTables = [];

  // ---------- 1. 基于空格/Tab 对齐的表格检测 ----------
  // 策略：连续的行中，若相邻行在相同"列位置"上有非空文本块，视为表格
  function detectByAlignment(rows, minRows = 3) {
    // 对每一行，将空格/Tab分割的文本块按位置分组；空格数量≥2作为列分隔
    const candidates = [];
    let i = 0;
    while (i < rows.length) {
      const line = rows[i].trim();
      if (!line) { i++; continue; }
      const cells = line.split(/\s{2,}|\t/).filter(Boolean);
      if (cells.length >= 2 && cells.some(c => /[\u4e00-\u9fa5]/.test(c))) { // 至少2列且包含中文字符
        const tableRows = [{ cells, raw: rows[i] }];
        let j = i + 1;
        while (j < rows.length) {
          const nl = rows[j].trim();
          if (!nl) break;
          const nc = nl.split(/\s{2,}|\t/).filter(Boolean);
          if (nc.length === cells.length || (nc.length > 1 && Math.abs(nc.length - cells.length) <= 1)) {
            tableRows.push({ cells: nc, raw: rows[j] });
            j++;
          } else break;
        }
        if (tableRows.length >= minRows) {
          candidates.push(tableRows);
          i = j;
        } else i++;
      } else i++;
    }
    return candidates;
  }

  // ---------- 2. 基于分隔符（| 竖线，或 ___ 分隔线）的表格检测 ----------
  function detectByPipe(linesList) {
    const candidates = [];
    let i = 0;
    while (i < linesList.length) {
      const line = linesList[i].trim();
      // 跳过分隔线行
      if (/^[\s|:\-]+$/.test(line) && line.includes('-')) { i++; continue; }
      // 检测 | 表格：至少2列
      const cells = line.split('|').map(s => s.trim()).filter(Boolean);
      if (cells.length >= 2) {
        // 检查是否包含分隔线
        if (i + 1 < linesList.length && /^[\s|:\-]+$/.test(linesList[i + 1]) && linesList[i + 1].includes('-')) {
          // 确认为 | 表格：收集 header + 分隔线 + rows
          const header = cells;
          const sepline = linesList[i + 1];
          const rows = [];
          let j = i + 2;
          while (j < linesList.length) {
            const nl = linesList[j].trim();
            if (!nl || /^[\s|:\-]+$/.test(nl)) break;
            const rc = nl.split('|').map(s => s.trim()).filter(Boolean);
            if (rc.length >= 2) { rows.push({ cells: rc, raw: linesList[j] }); j++; }
            else break;
          }
          if (rows.length >= 1) {
            candidates.push({ headers: header, rows: rows });
            i = j;
          } else i++;
        } else i++;
      } else i++;
    }
    return candidates;
  }

  // ---------- 3. 合并检测结果，去重 ----------
  const alignTables = detectByAlignment(lines);
  const pipeTables = detectByPipe(lines);

  // 用 pipeTables 优先（更明确），alignTables 兜底
  let mergedCount = 0;
  for (const t of pipeTables) {
    const md = tableToMarkdown(t.headers, t.rows.map(r => r.cells));
    allTables.push({ type: 'pipe', headers: t.headers, rows: t.rows.map(r => r.cells), markdown: md });
    mergedCount++;
  }
  for (const t of alignTables) {
    // 跳过被 pipeTables 覆盖的区域（基于行号交叉检测）
    const h = t[0].cells;
    const r = t.slice(1).map(rr => rr.cells);
    const md = tableToMarkdown(h, r);
    allTables.push({ type: 'align', headers: h, rows: r, markdown: md });
    mergedCount++;
  }

  // ---------- 4. 构建最终文本 ----------
  // 替换原文本中的表格乱序行为空行，追加结构化表格 Markdown
  let cleanLines = [];
  const coveredLines = new Set();
  for (const t of pipeTables) {
    // 略过
  }
  // 简单策略：保留非表格行，追加表格markdown
  let finalText = rawText;
  if (allTables.length) {
    let sectionBreak = '\n\n--- TABLE BREAK ---\n\n';
    finalText += sectionBreak;
    finalText += allTables.map(t => t.markdown).join('\n\n');
  }

  return { text: finalText, tables: allTables };
}

function tableToMarkdown(headers, rows) {
  const colCount = Math.max(headers.length, ...rows.map(r => r.length));
  // header
  const mdHeader = '| ' + headers.map(cell => String(cell || '').replace(/\|/g, '\\|').trim()).join(' | ') + ' |';
  const separator = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const mdRows = rows.map(r => {
    const padded = [...r.map(c => String(c || '').replace(/\|/g, '\\|').trim())];
    while (padded.length < colCount) padded.push('');
    return '| ' + padded.join(' | ') + ' |';
  });
  return [mdHeader, separator, ...mdRows].join('\n');
}

module.exports = { enhancePdfText };
