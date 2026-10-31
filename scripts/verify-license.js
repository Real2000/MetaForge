/** License 独立验证工具（V2.3 2026-10-31）——生产公钥轮换后的部署机自检，不依赖服务进程与数据目录
 *  用法：
 *    node scripts/verify-license.js --file data/license.json
 *    node scripts/verify-license.js --file data/license.json --pubkey <新公钥hex>
 *      --file    License JSON 路径（必填；独立读取该指定文件——绝不调用 lib/edition.js 的
 *                refreshLicense/currentEdition，那两个读的是服务数据目录的 data/license.json）
 *      --pubkey  验签公钥 hex（可选；不传则用 lib/edition.js getPublicKeyHex()，
 *                即环境变量 LICENSE_PUBKEY_HEX 覆盖值或内置公钥）
 *  轮换自检场景（配套 docs/License密钥轮换指南.md）：
 *    签发机生成新钥并签发 License → 部署机替换公钥（改 PUBLIC_KEY_HEX 常量或设 LICENSE_PUBKEY_HEX）→
 *    将 license.json 放入 data/ → 先用本工具以 --pubkey 新hex 验证签名链路无误 →
 *    再重启或 POST /api/edition/reload 生效（生效前后各验一次更稳）。
 *  验签/字段校验/到期判断与 src-server/lib/edition.js loadLicense 同口径（复用其导出的
 *  canonicalOf/getPublicKeyHex/reasonDescription/publicKeyFromHex/localDateStr——V2.3 审查加固
 *  P2-4/S2-4：后两个纯函数已导出复用，消灭照抄双实现漂移）。
 *  退出码：0 = 有效 / 1 = 无效（便于部署脚本串联：`verify ... && 重启` 才继续上线动作）。
 *  零第三方依赖（process.argv 手动解析，风格对齐 scripts/issue-license.js）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EDITIONS, canonicalOf, getPublicKeyHex, reasonDescription, publicKeyFromHex, localDateStr } = require('../src-server/lib/edition');

// argv 手动解析：--key value 成对出现（value 不以 -- 开头）；裸开关按 true 收集（照抄 scripts/issue-license.js）
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
      else out[a.slice(2)] = true;
    }
  }
  return out;
}

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

// ---- 以下两段原为照抄 src-server/lib/edition.js 的双实现，V2.3 审查加固（P2-4/S2-4）后已改为直接复用导出函数 ----

// ---- 参数与公钥来源 ----
const args = parseArgs(process.argv.slice(2));
if (!args.file || args.file === true) fail('用法：node scripts/verify-license.js --file <license.json路径> [--pubkey <hex>]（详见文件头注释）');
if (args.pubkey === true) fail('--pubkey 需要跟公钥 hex 值（32 字节 = 64 个十六进制字符）');
// V2.3 审查加固（P1-1）：显式传空串直接拦截而非静默回退默认公钥——轮换场景 shell 变量未定义时
// `--pubkey "$NEW_HEX"` 展开为空，若回退 env/内置旧钥会「验旧钥绿灯放行」伪造自检通过（已实证误报路径）
if (args.pubkey !== undefined && !String(args.pubkey).trim()) fail('--pubkey 不能为空（若要使用环境变量/内置公钥请省略该参数）');
const file = path.resolve(String(args.file));
const pubHex = String(args.pubkey || getPublicKeyHex()).trim(); // --pubkey 优先，缺省走 getPublicKeyHex()（env 覆盖或内置）
const pubSource = args.pubkey ? '命令行 --pubkey 参数' : (process.env.LICENSE_PUBKEY_HEX ? '环境变量 LICENSE_PUBKEY_HEX' : 'edition.js 内置公钥');

// ---- 独立验证（与 lib/edition.js loadLicense 同判定序：存在性 → 公钥 → JSON → 验签 → 档位 → 字段形态 → 到期）----
let reason = 'ok';
let lic = null;

if (!fs.existsSync(file)) {
  reason = 'missing';
} else {
  // 公钥非法独立分类 badpubkey（区别于 badsig——换钥排障时先确认钥本身没配错）
  let pubKey = null;
  try { pubKey = publicKeyFromHex(pubHex); } catch { reason = 'badpubkey'; }
  if (!pubKey) {
    // 公钥非法：不读文件不验签（fail-closed 降级），reason 保持 'badpubkey'——口径同 loadLicense
  } else {
    try {
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
    } catch { reason = 'badjson'; lic = null; }
  }
}

// ---- 人类可读结果 + 退出码 ----
console.error(`验签文件：${file}`);
console.error(`验签公钥：${pubHex.slice(0, 8)}…${pubHex.slice(-8)}（来源：${pubSource}）`);
if (lic) {
  // 剩余天数：纯日期差（今天 0 天 → 「剩余 0 天」即今天到期）——算式同 lib/edition.js
  const daysLeft = Math.round((Date.parse(lic.expires_at) - Date.parse(localDateStr() + 'T00:00:00Z')) / 86400000);
  console.log(`✅ ${EDITIONS[lic.edition].name}，客户 ${lic.customer}，到期 ${lic.expires_at}，剩余 ${daysLeft} 天`);
  process.exit(0);
} else {
  console.error(`❌ License 无效（部署将降级为社区版）——降级原因：${reasonDescription(reason)}`);
  process.exit(1);
}
