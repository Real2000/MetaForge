/**
 * 生成「扫描版样本」最小合法 PDF（V2.3 #5 摄取管道 OCR 降级用例 fixture）
 * 用法：node test/fixtures/gen-scan-pdf.js（幂等可重跑）
 * 说明：单页 + Helvetica Type1 字体 + 三行 ASCII 文本（Tj 文本算子），
 *       结构完整（xref 偏移精确计算），可被 pdf-parse（pdf.js 内核）正常提取；
 *       用 ASCII 是因为 Type1 Helvetica 内嵌 CJK 需字体文件，超出最小样本需要。
 */
const fs = require('fs');
const path = require('path');

const lines = [
  'Employee Handbook Chapter 1',
  'All staff must follow the attendance policy.',
  'Late arrival is deducted by times each month.',
];
// 内容流：三行文本依次 Tj 输出（Tf 设字号、Td 移动到起始坐标、每次 Tj 后下移 18pt）
let content = 'BT /F1 12 Tf 72 720 Td\n';
for (const l of lines) content += `(${l}) Tj 0 -18 Td\n`;
content += 'ET';

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];

let pdf = '%PDF-1.4\n';
const offsets = [0];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(pdf)); // 记录每个对象起始字节偏移（xref 用）
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefPos = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

const out = path.join(__dirname, 'scan-sample.pdf');
fs.writeFileSync(out, Buffer.from(pdf, 'latin1'));
console.log('生成完成：' + out + '（' + Buffer.byteLength(pdf) + ' 字节）');
