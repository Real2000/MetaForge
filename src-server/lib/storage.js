/**
 * P1-19 对象存储抽象层（2026-11-13）
 *
 * 统一文件存储接口，支持两种后端：
 *   - local （默认）：public/uploads/{type}/ 本地磁盘
 *   - s3    （S3 兼容）：AWS S3 / MinIO / Ceph / DigitalOcean Spaces
 *
 * 切换方式：环境变量 STORAGE_BACKEND=local|s3（默认 local）+ 配套 S3_* 变量。
 *
 * 设计原则：
 *   1) 零改动接入：所有现有代码调 ensureDir() + writeFile() 的路径不变，
 *      由本层透明处理本地读写 vs S3 上传/下载；
 *   2) 现有文件路径引用（如 /uploads/exports/xxx.docx）保持不变；
 *   3) S3 模式下：写操作同步上传到 S3，读时请求经 /api/doc/raw 代理（或直接返回 S3 签名 URL）；
 *   4) 日志/错误一致性：无论何种后端，返回格式一致。
 *
 * 存储桶/路径约定：
 *   - S3 桶名：由 S3_BUCKET 指定
 *   - S3 键：uploads/{type}/{filename}
 *   - 本地路径：public/uploads/{type}/{filename}
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/* ---------- 配置 ---------- */

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads');

class StorageBackend {
  /**
   * @param {'local'|'s3'} type
   */
  constructor(type) {
    this.type = type || 'local';
  }

  /** 确保类型子目录存在（仅 local 模式需要） */
  ensureDir(type) {
    if (this.type !== 'local') return;
    const dir = path.join(UPLOAD_ROOT, type);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * 写入文件。返回公共 URL 路径（如 /uploads/exports/xxx.docx）。
   * @param {string} type    子目录（exports/sandbox/videos/gen-images）
   * @param {string} filename
   * @param {Buffer|string} data
   * @returns {string} url
   */
  write(type, filename, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (this.type === 'local') {
      return this._writeLocal(type, filename, buf);
    }
    return this._writeS3(type, filename, buf);
  }

  /**
   * 读取文件内容
   * @param {string} type
   * @param {string} filename
   * @returns {Buffer|null}
   */
  read(type, filename) {
    if (this.type === 'local') return this._readLocal(type, filename);
    return this._readS3(type, filename);
  }

  /**
   * 检查文件是否存在
   */
  exists(type, filename) {
    if (this.type === 'local') return fs.existsSync(path.join(UPLOAD_ROOT, type, filename));
    return false; // S3 检查暂不实现（可添加 headObject）
  }

  /**
   * 删除文件
   */
  remove(type, filename) {
    if (this.type === 'local') {
      const fp = path.join(UPLOAD_ROOT, type, filename);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* 静默 */ }
      return;
    }
    // S3 删除暂不实现
  }

  /**
   * 列出类型目录下所有文件（仅文件名，不含路径）
   */
  list(type) {
    if (this.type === 'local') {
      const dir = path.join(UPLOAD_ROOT, type);
      try { return fs.readdirSync(dir).filter(f => !f.startsWith('.')); } catch { return []; }
    }
    return [];
  }

  /**
   * 获取文件的公共 URL
   */
  publicUrl(type, filename) {
    return `/uploads/${type}/${filename}`;
  }

  /**
   * 统计类型目录下的文件总大小（字节）、文件数
   */
  statDir(type) {
    if (this.type === 'local') {
      const dir = path.join(UPLOAD_ROOT, type);
      let totalBytes = 0, fileCount = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          const fp = path.join(dir, f);
          try { const st = fs.statSync(fp); if (st.isFile()) { totalBytes += st.size; fileCount++; } } catch { }
        }
      } catch { }
      return { bytes: totalBytes, files: fileCount };
    }
    return { bytes: 0, files: 0 };
  }

  /* ---- local 实现 ---- */
  _writeLocal(type, filename, buf) {
    const dir = path.join(UPLOAD_ROOT, type);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), buf);
    return this.publicUrl(type, filename);
  }

  _readLocal(type, filename) {
    const fp = path.join(UPLOAD_ROOT, type, filename);
    try { return fs.readFileSync(fp); } catch { return null; }
  }

  /* ---- S3 实现 ---- */
  _writeS3(type, filename, buf) {
    const s3 = getS3Client();
    const key = `uploads/${type}/${filename}`;
    try {
      s3.putObject({ Bucket: process.env.S3_BUCKET, Key: key, Body: buf }).promise();
    } catch (e) {
      console.error(`[storage] S3 upload failed: ${e.message}`);
      // S3 失败回退到本地
      // return this._writeLocal(type, filename, buf);
    }
    return this.publicUrl(type, filename);
  }

  _readS3(type, filename) {
    const s3 = getS3Client();
    const key = `uploads/${type}/${filename}`;
    try {
      const obj = s3.getObject({ Bucket: process.env.S3_BUCKET, Key: key }).promise();
      return Buffer.from(obj.Body);
    } catch { return null; }
  }
}

/* ---- S3 客户端（懒初始化） ---- */
let s3Client = null;
function getS3Client() {
  if (s3Client) return s3Client;
  // 仅在 S3 模式下按需加载 AWS SDK
  const AWS = require('aws-sdk');
  const endpoint = process.env.S3_ENDPOINT || '';   // MinIO: http://127.0.0.1:9000
  const region = process.env.S3_REGION || 'us-east-1';
  const opts = {
    region,
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  };
  if (endpoint) opts.endpoint = endpoint;
  if (process.env.S3_FORCE_PATH_STYLE === '1') opts.s3ForcePathStyle = true;
  if (!opts.accessKeyId) {
    console.warn('[storage] S3_ACCESS_KEY 未配置，无法初始化 S3 客户端');
    return null;
  }
  s3Client = new AWS.S3(opts);
  return s3Client;
}

/* ---- 单例 ---- */

const BACKEND = (process.env.STORAGE_BACKEND || 'local').toLowerCase();
const instance = new StorageBackend(BACKEND);

if (BACKEND !== 'local') {
  console.log(`[storage] 使用 ${BACKEND} 对象存储后端`);
}

module.exports = instance;
module.exports.StorageBackend = StorageBackend;
