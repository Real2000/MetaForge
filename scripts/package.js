#!/usr/bin/env node
/**
 * 发布打包工具（P0-5 改进版）——生成分发 zip 包
 *   - UTF-8 编码标记（zip flag bit 11 置位），避免 Windows 中文乱码
 *   - .zip 格式，兼容所有平台
 *   - 自动排除测试数据、日志、node_modules 等非交付项目录
 *
 * 用法：
 *   node scripts/package.js [--out-dir ./dist] [--version "1.0"]
 *
 * 策略：优先系统 zip（macOS/Linux 原生支持 UTF-8 flag），不可用时回退 Node 原生的
 * 完整 zip 写入（无需任何第三方依赖，相比之前自实现 zip 类更可靠）。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
let outDir = path.resolve('./dist');
let version = 'latest';

// 支持 --out-dir ./dist 和 --version v1.0 命名参数，也支持无标记顺序参数（兼容旧用法）
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir') {
    outDir = path.resolve(args[++i] || './dist');
  } else if (args[i] === '--version') {
    version = args[++i] || 'latest';
  }
}
// 如果没有标记参数，用传统顺序参数回退（第1个=目录，第2个=版本）
if (!args.some(a => a.startsWith('--'))) {
  outDir = path.resolve(args[0] || './dist');
  version = args[1] || 'latest';
}

const projectName = 'agent-platform';
const fileName = `${projectName}-${version}.zip`;
const filePath = path.join(outDir, fileName);

console.log(`[package] 项目：${projectName}`);
console.log(`[package] 版本：${version}`);

// 确保输出目录存在
fs.mkdirSync(outDir, { recursive: true });

// ---- 简单 zip 写入器（零第三方依赖） ----
// zip 标准：local file header (30+name+extra bytes) + file data + central directory + end record
// flag bit 11 (0x0800) 表示文件名 UTF-8
function crc32(buf) {
  let c = 0xffffffff, t = crc32.table || (crc32.table = makeCrc32Table());
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeCrc32Table() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c; }
  return t;
}
function writeZip(zipPath, entries) {
  // entries: [{ name, data }] 其中 data 为 Buffer
  const lhSize = 30;
  let offset = 0;
  const headers = [];
  const bf = []; // 所有写入的 buffer 段
  const push = buf => { bf.push(buf); offset += buf.length; };
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const c = crc32(e.data);
    const h = Buffer.alloc(lhSize);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6); // flag: UTF-8
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(0, 12);
    h.writeUInt32LE(c, 14);
    h.writeUInt32LE(e.data.length, 18);
    h.writeUInt32LE(e.data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    headers.push({ nameBuf, c, compSize: e.data.length, uncSize: e.data.length, fileOffset: offset + 30 + nameBuf.length });
    push(Buffer.concat([h, nameBuf]));
    push(e.data);
  }
  const cdOffset = offset;
  for (const h of headers) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(h.c, 16);
    cd.writeUInt32LE(h.compSize, 20);
    cd.writeUInt32LE(h.uncSize, 24);
    cd.writeUInt16LE(h.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(h.fileOffset, 42);
    push(Buffer.concat([cd, h.nameBuf]));
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(headers.length, 8);
  eocd.writeUInt16LE(headers.length, 10);
  eocd.writeUInt32LE(offset - cdOffset, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  push(eocd);
  fs.writeFileSync(zipPath, Buffer.concat(bf));
}

// ---- 列举文件并打包 ----
try {
  // 尝试系统 zip（macOS/Linux 默认置位 UTF-8 flag bit 11）
  const excludes = [
    'node_modules/*', 'node_modules/',
    '.git/*', '.git/',
    '.temp/*', '.temp/',
    'data/*', 'data/',
    'backups/*', 'backups/',
    'test/*', 'test/',
    'docs/*', 'docs/',
    'uploads/*', 'uploads/',
    'public/uploads/*', 'public/uploads/',
    'public/downloads/*', 'public/downloads/',
    '.DS_Store', '__MACOSX',
    '*.log', '*.db', '*.db-wal', '*.db-shm',
    '*.sqlite', '*.sqlite3', '*.key', '*.pem',
    'license-signing/*', 'license-signing/',
  ].map(x => `-x "${x}"`).join(' ');
  const cmd = `cd "${process.cwd()}" && zip -r "${filePath}" ./* ${excludes}`;
  execSync(cmd, { stdio: 'pipe', timeout: 120000 });
  console.log(`[package] ✅ 已生成：${filePath}`);
  console.log(`[package]    大小：${(fs.statSync(filePath).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[package]    编码：UTF-8（zip flag bit 11 已置位）`);
} catch {
  // 回退：Node 原生 zip 写入（零第三方依赖）
  console.warn('[package] ⚠️ 系统 zip 不可用，改用 Node 原生 zip 写入');
  const entries = getFilesForZip(process.cwd(), process.cwd());
  writeZip(filePath, entries);
  console.log(`[package] ✅ 已生成：${filePath}`);
  console.log(`[package]    大小：${(fs.statSync(filePath).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[package]    编码：UTF-8（zip flag bit 11 已置位）`);
}

/** 递归扫描文件（跳过排除列表） */
function getFilesForZip(dir, baseDir) {
  const exclude = new Set([
    'node_modules', '.git', '.temp', 'data', 'backups', 'test', 'docs', 'uploads',
    'public/uploads', 'public/downloads', '__MACOSX',
  ]);
  const excludeExt = new Set(['.log', '.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3', '.key', '.pem']);
  const excludeFile = new Set(['.DS_Store']);
  const entries = [];
  function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const fp = path.join(d, name);
      if (exclude.has(name) || excludeFile.has(name)) continue;
      const rel = path.relative(baseDir, fp);
      const st = fs.statSync(fp);
      if (st.isFile()) {
        if (excludeExt.has(path.extname(name).toLowerCase())) continue;
        if (st.size === 0) continue; // 空文件跳过
        entries.push({ name: rel, data: fs.readFileSync(fp) });
      } else if (st.isDirectory()) {
        walk(fp);
      }
    }
  }
  walk(dir);
  return entries;
}
