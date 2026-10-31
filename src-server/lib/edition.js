/** 版本分级 + License 授权控制（V2.2 #8 2026-10-31）
 *  两套商业化体系正交并存，勿混：
 *  - License（本模块）：私有化部署的版本分级（community/professional/enterprise），
 *    决定「这套部署有什么功能」——对标 MaxKB 专业版永久授权买断模式；
 *  - users.plan（lib/plans.js）：SaaS 套餐配额，决定「这个用户有多少配额」。
 *
 *  设计原则「不锁死不裸奔」：License 缺失/损坏 JSON/验签失败/格式非法/过期 → 显式降级 community
 *  并 console.warn 原因，不抛错不阻塞启动（社区版基础功能全可用，专业/企业特性关闭）。
 *
 *  验签：Ed25519（Node 22 内置 crypto，零第三方依赖）。签发私钥只存在签发机
 *  （scripts/issue-license.js 自动生成/读取），绝不入库/仓库；本模块仅内置公钥。
 *  对 canonical 序列化串（customer/edition/expires_at/issued_at/license_key 五字段按字母序键的
 *  JSON.stringify）做 crypto.verify(null, data, publicKey, signature)。
 *
 *  【生产密钥轮换】在签发机执行 node scripts/issue-license.js --private-key <新路径> ...（首次自动
 *  生成新密钥对并打印公钥 hex）→ 把公钥 hex 替换下方 PUBLIC_KEY_HEX 常量（或免改代码：部署机设
 *  环境变量 LICENSE_PUBKEY_HEX 覆盖）→ 新签发 License 全部走新钥；旧 License 到期后自然收敛失效。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 【内置公钥】Ed25519 公钥（32 字节 hex）——当前为开发/联调测试钥；生产部署请按上方「密钥轮换」替换
const PUBLIC_KEY_HEX = '1578bab46a80278b79e4f871e063ecaeb7b64cf16eb6596f88cf719b819fedb4';

// License 参与签名的五个字段（canonical 序列化按字母序：customer/edition/expires_at/issued_at/license_key）
const SIGNED_FIELDS = ['customer', 'edition', 'expires_at', 'issued_at', 'license_key'];

// 版本决策表：features 为该版本可用特性集（高版本包含低版本全部特性—— License 决定部署级功能开关）
const EDITIONS = {
  community: {
    name: '社区版',
    features: ['agents', 'kb', 'workflow', 'mcp', 'openapi'],
  },
  professional: {
    name: '专业版',
    features: ['agents', 'kb', 'workflow', 'mcp', 'openapi', 'dingtalk', 'ldap', 'unlimited'],
  },
  enterprise: {
    name: '企业版',
    features: ['agents', 'kb', 'workflow', 'mcp', 'openapi', 'dingtalk', 'ldap', 'unlimited', 'tenant', 'audit_flow', 'priority_support'],
  },
};

// Ed25519 原始 32 字节公钥 → SPKI KeyObject（固定 12 字节 DER 前缀封装，node:crypto 标准姿势，零依赖）
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function publicKeyFromHex(hex) {
  const raw = Buffer.from(String(hex || '').trim(), 'hex');
  if (raw.length !== 32) throw new Error('License 公钥长度非法（期望 32 字节 hex，实际 ' + raw.length + ' 字节）');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** 当前生效公钥 hex：环境变量 LICENSE_PUBKEY_HEX 覆盖内置（测试与生产轮换共用此口，refreshLicense() 后生效） */
function getPublicKeyHex() {
  return String(process.env.LICENSE_PUBKEY_HEX || PUBLIC_KEY_HEX).trim();
}

/** dataDir 与 db.js 同款环境变量逻辑（db.js 位于 src-server/、本模块位于 src-server/lib/，故相对路径多退一层） */
function resolveDataDir() {
  return process.env.AGENT_DATA_DIR || path.join(__dirname, '..', '..', 'data');
}

/** canonical 序列化：受签名字段按字母序键构造对象后 JSON.stringify（签发/验证两端共用，防实现漂移） */
function canonicalOf(lic) {
  const o = {};
  for (const k of [...SIGNED_FIELDS].sort()) o[k] = lic ? lic[k] : undefined;
  return JSON.stringify(o);
}

/** 本地日期 'YYYY-MM-DD'（到期比较用；不用 toISOString——UTC 偏移会跨日误判） */
function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- 模块级缓存（License 文件更新/公钥环境变量变更后调 refreshLicense() 热加载，无 TTL 陈旧问题）----
let cache = null;

/** 降级原因 → 人话（warn 日志 / 启动横幅用） */
function reasonDescription(r) {
  return ({
    missing: '未找到 license.json',
    badjson: 'JSON 解析失败',
    badpubkey: '公钥配置异常（hex 非法，检查 LICENSE_PUBKEY_HEX 或内置公钥）',
    badsig: '验签失败（内容被篡改或公钥不匹配）',
    badformat: 'License 字段格式非法',
    badedition: 'edition 档位非法',
    expired: '已过期',
  })[r] || r;
}

/** 读 + 验签 + 判到期：任何失败显式降级 community（不抛错——启动链路绝不因 License 卡死） */
function loadLicense() {
  const file = path.join(resolveDataDir(), 'license.json');
  // V2.2 审查加固（安全 F1）：公钥经环境变量覆盖时显著告警——该口子同时是「shell 权限者自签 License」
  // 的通道（照签发文档跑命令即可解锁全部特性），留审计痕迹+心理威慑；生产部署机禁设该变量（仅签发机轮换用）
  if (process.env.LICENSE_PUBKEY_HEX) {
    console.warn('[edition] 公钥经环境变量 LICENSE_PUBKEY_HEX 覆盖——请确认这是签发机轮换操作，生产部署机不应设置该变量');
  }
  let lic = null;
  let reason = 'ok';
  // V2.2 审查加固（Y1）：公钥配置异常（env 覆盖打错字/内置公钥被改坏）独立分类 badpubkey——
  // 原实现在验签 try-catch 内构建公钥、异常被吞误报 badsig，管理员换公钥会被误导去排查 License 文件
  let pubKey = null;
  try { pubKey = publicKeyFromHex(getPublicKeyHex()); } catch { reason = 'badpubkey'; }
  try {
    if (!fs.existsSync(file)) {
      reason = 'missing';
    } else if (!pubKey) {
      lic = null; // 公钥非法：不读文件不验签（fail-closed 降级），reason 保持 'badpubkey'
    } else {
      lic = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 验签：Ed25519 对 canonical 串；签名非 hex 等异常一律按「验签失败」处理（fail-closed）
      const canonical = canonicalOf(lic);
      const sigOk = typeof lic.signature === 'string' && lic.signature.length > 0 && (() => {
        try {
          return crypto.verify(null, Buffer.from(canonical, 'utf8'), pubKey, Buffer.from(lic.signature, 'hex'));
        } catch { return false; }
      })();
      if (!sigOk) { reason = 'badsig'; lic = null; }
      else if (!EDITIONS[lic.edition]) { reason = 'badedition'; lic = null; }
      else if (typeof lic.customer !== 'string' || !lic.customer.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(lic.expires_at || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(lic.issued_at || ''))) {
        reason = 'badformat'; lic = null; // 签名有效但字段形态非法（防御：签发端 bug / 手工改字段后重签）
      }
      else if (String(lic.expires_at) < localDateStr()) { reason = 'expired'; lic = null; } // 到期日当天仍有效（< 今天才算过期）
    }
  } catch { if (reason !== 'badpubkey') reason = 'badjson'; lic = null; }

  const edition = lic ? lic.edition : 'community';
  if (reason !== 'ok') {
    // 降级不抛错：console.warn 原因，社区版基础功能照常（「不锁死不裸奔」）
    console.warn(`[edition] License 降级为社区版（原因：${reasonDescription(reason)}，文件：${file}）——不阻塞启动，基础功能可用`);
  }
  // 剩余天数：纯日期差（今天 0 天 → 「将于 0 天后到期」即今天到期）
  const daysLeft = lic ? Math.round((Date.parse(lic.expires_at) - Date.parse(localDateStr() + 'T00:00:00Z')) / 86400000) : null;
  cache = {
    edition,
    name: EDITIONS[edition].name,
    licensed: !!lic,          // 是否持有效 License（false = 社区版降级态）
    reason,                   // ok/missing/badjson/badpubkey/badsig/badformat/badedition/expired（诊断用）
    customer: lic ? lic.customer : null,
    expires_at: lic ? lic.expires_at : null,
    days_left: daysLeft,
    license_key: lic && lic.license_key ? String(lic.license_key).slice(0, 8) + '…' : null, // 前缀展示（防完整 key 泄露）
  };
  return { ...cache };
}

/** 当前版本快照（含 License 元信息；首次调用触发加载，此后走缓存） */
function currentEdition() {
  return cache ? { ...cache } : loadLicense();
}

/** 热加载：License 文件更新 / LICENSE_PUBKEY_HEX 环境变量变更后调用（清缓存重读重验） */
function refreshLicense() {
  return loadLicense();
}

/** 特性开关：当前版本是否含某特性（License 决定部署级功能可用性） */
function hasFeature(feature) {
  return (EDITIONS[currentEdition().edition].features || []).includes(feature);
}

/** Express 中间件：无权返回 body code=403（HTTP 200，与 plans.js 402 软约束同风格，前端统一按 code 分支处理）；
 *  后续钉钉/租户/审核流上线时在对应路由挂 requireFeature('dingtalk')/requireFeature('tenant') 即生效 */
function requireFeature(feature) {
  return (req, res, next) => {
    if (hasFeature(feature)) return next();
    const cur = currentEdition();
    // 升级引导指向该特性所属最低版本（决策表按低→高序声明，find 首个命中即最低档）
    const target = Object.values(EDITIONS).find((e) => e.features.includes(feature));
    res.json({
      code: 403,
      msg: `该功能需要${target ? target.name : '更高版本'}授权（当前：${cur.name}）`,
      data: { upgrade_hint: true, feature, edition: cur.edition },
    });
  };
}

/** 启动横幅文本：如「专业版（License 到期 2027-10-31，剩余 365 天）」/「社区版（未配置 License）」 */
function editionBanner() {
  const cur = currentEdition();
  if (cur.licensed) return `${cur.name}（License 到期 ${cur.expires_at}，剩余 ${cur.days_left} 天）`;
  return cur.reason === 'missing' ? '社区版（未配置 License）' : `社区版（License 无效已降级：${reasonDescription(cur.reason)}）`;
}

/** 到期提醒：剩余 30 天内每日一次向全体管理员写站内通知（当日同标题去重；写库失败只 warn 不抛错）。
 *  V2.2 审查加固（R1）：首行 refreshLicense() 重读文件重验——否则每 24h 调度读的都是启动时刻快照，
 *  长期运行进程中过期 License 永不降级、30 天提醒窗口冻结（过期降级是五路径中唯一需要运行态生效的）；
 *  V2.2 审查加固（Y5）：通知发给全部启用管理员而非硬编码 'admin'（多管理员/自定义用户名部署才有人可见） */
function checkExpiryNotice() {
  try {
    const cur = refreshLicense(); // R1 修复：重读重验，运行态过期即时降级
    if (!cur.licensed || cur.days_left == null || cur.days_left < 0 || cur.days_left > 30) return false;
    const { db, now } = require('../db'); // 懒加载：本模块被无 DB 场景（纯函数测试）引用时不触发建库
    const title = `License 将于 ${cur.days_left} 天后到期`;
    // 收件人：全体启用管理员（Y5：硬编码 admin 在多管理员/自定义用户名部署下无人可见）
    const admins = db.prepare("SELECT username FROM users WHERE role='admin' AND status=1").all();
    if (!admins.length) return false;
    // 当日去重：同一天多次调度（重启/手动触发）不重复打扰
    const dup = db.prepare(`SELECT id FROM notifications WHERE username=? AND title=? AND created_at >= datetime('now','localtime','start of day')`).get(admins[0].username, title);
    if (dup) return false;
    const content = `${cur.name} License 将于 ${cur.expires_at}（${cur.days_left} 天后）到期，请联系供应商续期并替换 data/license.json；到期后平台将降级为社区版（基础功能可用，高级特性关闭）。`;
    const ins = db.prepare('INSERT INTO notifications (username,title,content,type,link,is_read,created_at) VALUES (?, ?, ?, \'system\', \'\', 0, ?)');
    for (const a of admins) ins.run(a.username, title, content, now());
    return true;
  } catch (e) {
    console.warn('[edition] 到期提醒写入失败（不影响运行）：' + e.message);
    return false;
  }
}

// V2.3 审查加固（P2-4/S2-4）：publicKeyFromHex / localDateStr 一并导出——scripts/verify-license.js 复用而非照抄，
// 消灭 SPKI 封装与日期算式的双实现漂移（轮换自检工具与服务端验签必须同源）
module.exports = { EDITIONS, currentEdition, hasFeature, requireFeature, refreshLicense, checkExpiryNotice, getPublicKeyHex, editionBanner, canonicalOf, reasonDescription, publicKeyFromHex, localDateStr };
