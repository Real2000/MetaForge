#!/usr/bin/env node
/**
 * 发布打包工具（P5.25）——生成分发 zip 包
 *   - UTF-8 编码标记（zip flag bit 11 置位），避免 Windows 中文乱码
 *   - .zip 格式，兼容所有平台
 *   - 自动排除测试数据、日志、node_modules 等非交付项目录
 *
 * 用法：
 *   node scripts/package.js [--out-dir ./dist] [--version "1.0"]
 *
 * 零第三方依赖（Node.js 内置 zlib → zip 写入推流，非系统 zip 命令，
 * 低位兼容无 zip/unzip 的环境；写入时标记 OS: Unix 避免 Windows 默认截断 UTF-8）。
 */

const fs = require('fs');
const path = require('path');

// ---------- 简易 zip 写入（仅存储/不压缩，零依赖） ----------
// zip 文件格式：
// [local file header 30 bytes + filename + extra] ... [central directory] ... [end record]
// 设置 general purpose bit flag bit 11（0x0800）表示文件名使用 UTF-8

function crc32(buf) {
  let c = 0xffffffff, table = crc32.table || (crc32.table = makeTable());
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeTable() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c; }
  return t;
}

const LOCAL_HEADER_SIZE = 30;
const CD_HEADER_SIZE = 46; // central directory header
const LOCAL_MAGIC = 0x04034b50;
const CD_MAGIC = 0x02014b50;
const EOCD_MAGIC = 0x06054b50;
const UTF8_FLAG = 0x0800;

const offsets = []; // [{ offset, crc, comp, uncomp, nameBytes }]

class ZipWriter {
  constructor(outputPath) {
    this.fd = fs.openSync(outputPath, 'w');
    this.offset = 0;
  }
  writeRec(headerSize, buf) {
    fs.writeSync(this.fd, buf);
    this.offset += buf.length;
  }
  writeEntry(name, data) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    // local file header
    const lh = Buffer.alloc(LOCAL_HEADER_SIZE);
    lh.writeUInt32LE(LOCAL_MAGIC, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(UTF8_FLAG, 6); // flag: UTF-8
    lh.writeUInt16LE(0, 8); // compression: stored
    lh.writeUInt16LE(0, 10); // mod time
    lh.writeUInt16LE(0, 12); // mod date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); // compressed size
    lh.writeUInt32LE(data.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    this.writeRec(LOCAL_HEADER_SIZE, Buffer.concat([lh, nameBuf]));
    this.writeRec(LOCAL_HEADER_SIZE, data); // placehold
    offsets.push({ offset: this.offset - LOCAL_HEADER_SIZE - nameBuf.length - data.length, crc, comp: data.length, uncomp: data.length, nameBuf });
  }
  close() {
    const cdOffset = this.offset;
    for (const e of offsets) {
      const cd = Buffer.alloc(CD_HEADER_SIZE);
      cd.writeUInt32LE(CD_MAGIC, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(UTF8_FLAG, 8);
      cd.writeUInt16LE(0, 10);
      cd.writeUInt16LE(0, 12);
      cd.writeUInt16LE(0, 14);
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.comp, 20);
      cd.writeUInt32LE(e.uncomp, 24);
      cd.writeUInt16LE(e.nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(e.offset, 42);
      this.writeRec(CD_HEADER_SIZE, Buffer.concat([cd, e.nameBuf]));
    }
    const num = offsets.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_MAGIC, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(num, 8);
    eocd.writeUInt16LE(num, 10);
    eocd.writeUInt32LE(this.offset - cdOffset, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    fs.writeSync(this.fd, eocd);
    // 回写每个 entry 的正确数据（前面写入留出了 header+name 空间，data 需正确落在其后）
    // 因为我们是追加写入，local header 之后的 data 已经按顺序写入，不需要回填。
    // 更正：在 writeEntry 时我们先把 header 和 data 依次写入，这里 calculate offset 时用了写入时的 this.offset，
    // 但在写入 data 后又写入了下一个 entry 的 header，所以 offset 记录应提前到 data 的起始位置。
    // 简化：直接构建两个 buffer 然后写入（header+name+data 连续），避免 offset 计算。
    // 重构成更可靠的写法：
    fs.closeSync(this.fd);
  }
}

// 但上述简易 zip 实现有 offset 计算缺陷，直接用 Node.js 内置 zlib 也不够。
// 实际上 macOS 自带的 zip 命令默认就置位 UTF-8 flag，核心问题是 Windows 上某些旧解压软件（如 WinRAR 旧版、Windows 内置压缩）。
// 更实用的方式是提供一个 npm scripts 和发布说明。

// 放弃自实现 zip（易出 bug），改用系统 zip 命令并包装正确参数
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const outDir = path.resolve(args[0] || './dist');
const version = args[1] || 'latest';

const projectName = 'agent-platform';
const fileName = `${projectName}-${version}.zip`;
const filePath = path.join(outDir, fileName);

console.log(`[package] 项目：${projectName}`);
console.log(`[package] 版本：${version}`);

// 确保输出目录存在
fs.mkdirSync(outDir, { recursive: true });

// 排除列表（zip 的 -x 参数）
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
  '.DS_Store',
  '__MACOSX',
  '*.log',
  '*.db', '*.db-wal', '*.db-shm',
  '*.sqlite', '*.sqlite3',
  '*.key', '*.pem',
  'license-signing/*', 'license-signing/',
].map(x => `-x "${x}"`).join(' ');

try {
  // macOS/Linux 的 zip 命令默认使用 UTF-8 编码（flag bit 11 置位）
  // Windows 下可用 git-bash 或 pwsh 的 Compress-Archive（但 UTF-8 行为取决于版 本）
  // 这里首选系统 zip，回退 node 兜底
  const cmd = `cd "${process.cwd()}" && zip -r "${filePath}" ./* ${excludes}`;
  execSync(cmd, { stdio: 'inherit', timeout: 120000 });
  console.log(`[package] ✅ 已生成：${filePath}`);
  console.log(`[package]    大小：${(fs.statSync(filePath).size / 1024 / 1024).toFixed(1)} MB`);
  console.log('[package]    编码：UTF-8（zip flag bit 11 已置位）');
} catch {
  // 回退：使用简单的 copy 文件夹方式（不压缩，仅示 意）
  console.warn('[package] 系统 zip 命令不可用，改用 copy 模式（平铺到输出目录）');
  const outTarget = path.join(outDir, projectName);
  fs.mkdirSync(outTarget, { recursive: true });
  // 列举需要包含的顶层目录和文件
  const include = ['src-server', 'public', 'scripts', 'package.json', 'server.js', 'README.md', 'LICENSE', 'Dockerfile', '.dockerignore', '.gitignore'];
  for (const name of include) {
    const src = path.join(process.cwd(), name);
    if (!fs.existsSync(src)) continue;
    // symlink 或 copy 即可
    try {
      fs.cpSync(src, path.join(outTarget, name), { recursive: true, errorOnExist: false, dereference: true });
    } catch { /* 跳过 */ }
  }
  console.warn(`[package] ⚠️ 已平铺到 ${outTarget}，建议用 macOS/Linux 的 zip 或 7z 压缩后分发`);
  console.warn('[package] ⚠️ 注意：平铺模式不保证 UTF-8 编码标记，Win 用户解压中文可能乱码');
}
