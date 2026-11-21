/**
 * D2-3 桌面端升级通道 · 内核（纯逻辑，零依赖）
 * ---------------------------------------------------------------
 * 把「客户端自动更新」的决策逻辑从路由/客户端里抽出来，便于单测：
 *   - 版本解析与比较（semver-lite，支持 v 前缀 / 预发布后缀）
 *   - 发布选择：按 平台/架构/通道 匹配 + 版本高于当前 → 得出是否可更新 / 是否强制
 *   - 包完整性：sha256 计算与校验
 *   - 指标：更新成功率、崩溃率（验收：更新成功率 ≥ 95%、崩溃率 < 0.5%）
 *
 * 无 DB / 无网络 / 无文件：路由只做落库与传输，客户端只做下载与替换。
 */
'use strict';
const crypto = require('crypto');

const CHANNELS = ['stable', 'beta'];

/** 解析版本号 → { major, minor, patch, pre }；无法解析返回 null */
function parseVersion(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

/**
 * 版本比较：a > b → 1；a < b → -1；相等 → 0。
 * 语义化比较（主次修订），预发布版本 < 同号正式版本；无法解析时按字符串比较兜底。
 */
function cmpVersion(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) {
    const sa = String(a == null ? '' : a), sb = String(b == null ? '' : b);
    return sa === sb ? 0 : (sa > sb ? 1 : -1);
  }
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  if (pa.pre && !pb.pre) return -1;   // 1.2.3-beta < 1.2.3
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre !== pb.pre) return pa.pre > pb.pre ? 1 : -1;
  return 0;
}

/** 规范化版本号：去 v 前缀，保留 三段[-预发布]；无法解析原样返回 */
function normalizeVersion(v) {
  const p = parseVersion(v);
  if (!p) return String(v == null ? '' : v).trim();
  return `${p.major}.${p.minor}.${p.patch}${p.pre ? '-' + p.pre : ''}`;
}

/** 计算 sha256（hex 小写）；入参 Buffer 或 string */
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 校验 sha256；expect 为空视为「不校验」返回 true（兼容未签名历史流程） */
function verifySha256(buf, expect) {
  const e = String(expect || '').trim().toLowerCase();
  if (!e) return true;
  return sha256(buf) === e;
}

/** 平台/架构匹配：发布记录 platform/arch 为 'any' 或缺省时视为通配 */
function platformMatch(release, { platform, arch } = {}) {
  const r = release || {};
  const rp = String(r.platform || 'any');
  const ra = String(r.arch || 'any');
  if (platform && rp !== 'any' && rp !== platform) return false;
  if (arch && ra !== 'any' && ra !== arch) return false;
  return true;
}

/**
 * 选择最佳可用发布：
 *   过滤 status=active（或缺省）+ 平台/架构匹配 + 通道一致（发布 channel 'any' 或缺省视为通配）
 *   → 取版本最高者 → 与 current 比较得出 update_available / mandatory。
 * mandatory：发布标记强制，或 current 低于发布的 min_version。
 * @returns { latest, update_available, mandatory, release }
 */
function pickRelease(releases, { platform, arch, channel = 'stable', current = '0.0.0' } = {}) {
  const list = (releases || []).filter(r =>
    (!r.status || r.status === 'active')
    && platformMatch(r, { platform, arch })
    && (!r.channel || r.channel === 'any' || r.channel === channel)
  );
  let best = null;
  for (const r of list) {
    if (!best || cmpVersion(r.version, best.version) > 0) best = r;
  }
  if (!best) return { latest: null, update_available: false, mandatory: false, release: null };
  const upToDate = cmpVersion(best.version, current) <= 0;
  let must = !!best.mandatory;
  if (best.min_version && cmpVersion(current, best.min_version) < 0) must = true;
  return { latest: best.version, update_available: !upToDate, mandatory: !upToDate && must, release: best };
}

/**
 * 更新/崩溃指标。
 *   更新成功率 = success / 全部更新尝试（success+failed+rollback），无数据 → null
 *   崩溃率 = 崩溃设备数 / 更新涉及设备数，无数据 → null
 * @param {Array} updateRows  bridge_updates 行 [{status, device_id}]
 * @param {Array} crashRows   bridge_crashes 行 [{device_id}]
 */
function updateStats(updateRows, crashRows) {
  const rows = updateRows || [];
  const crashes = crashRows || [];
  const total = rows.length;
  const success = rows.filter(r => r.status === 'success').length;
  const failed = rows.filter(r => r.status === 'failed').length;
  const rollback = rows.filter(r => r.status === 'rollback').length;
  const successRate = total ? +(success / total * 100).toFixed(1) : null;
  const devices = new Set(rows.map(r => r.device_id).filter(x => x != null));
  const crashDevices = new Set(crashes.map(r => r.device_id).filter(x => x != null));
  const denom = devices.size || Math.max(total, crashes.length);
  const crashRate = denom ? +(crashDevices.size / denom * 100).toFixed(2) : null;
  return {
    total, success, failed, rollback,
    successRate,                 // % 或 null
    crashes: crashes.length, crashDevices: crashDevices.size,
    crashRate,                   // % 或 null
    meetsSuccessTarget: successRate == null ? null : successRate >= 95,
    meetsCrashTarget: crashRate == null ? null : crashRate < 0.5,
  };
}

/** 行 → 展示对象（前端安全消费） */
function releaseView(r) {
  if (!r) return null;
  return {
    id: r.id, version: normalizeVersion(r.version),
    platform: r.platform || 'any', arch: r.arch || 'any', channel: r.channel || 'stable',
    file_name: r.file_name || '', sha256: r.sha256 || '', size: r.size || 0,
    notes: r.notes || '', mandatory: !!r.mandatory, min_version: r.min_version || '',
    status: r.status || 'active', created_at: r.created_at || '',
  };
}

module.exports = {
  CHANNELS, parseVersion, cmpVersion, normalizeVersion, sha256, verifySha256,
  platformMatch, pickRelease, updateStats, releaseView,
};
