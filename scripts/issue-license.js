/** License 命令行签发工具（V2.2 #8 2026-10-31）——只在签发机运行，私钥绝不进仓库/不部署到服务器
 *  用法：node scripts/issue-license.js --private-key ~/license-signing/prod.key --customer "客户公司" --edition professional --days 365
 *    --private-key  私钥路径（默认 ~/license-signing/license-private.key）；文件不存在时自动生成 Ed25519 密钥对：
 *                   私钥写入该路径（chmod 600），公钥 hex 打印到 stderr——请更新到
 *                   src-server/lib/edition.js 的 PUBLIC_KEY_HEX（或部署机设环境变量 LICENSE_PUBKEY_HEX）
 *    --customer     客户标识（必填，展示与防串货）
 *    --edition      community / professional / enterprise（默认 professional）
 *    --days         有效期天数（必填；测试过期场景可传负数）
 *    --out          License JSON 输出路径（不传则打印到 stdout，便于管道）
 *  零第三方依赖（process.argv 手动解析）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// argv 手动解析：--key value 成对出现（value 不以 -- 开头）；裸开关暂未用到，按 true 收集
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

const VALID_EDITIONS = ['community', 'professional', 'enterprise'];
const args = parseArgs(process.argv.slice(2));

const edition = String(args.edition || 'professional');
if (!VALID_EDITIONS.includes(edition)) fail(`--edition 非法：${edition}（可选 ${VALID_EDITIONS.join(' / ')}）`);
const customer = String(args.customer || '').trim();
if (!customer) fail('--customer 不能为空（License 客户标识，用于展示与防串货）');
const days = Number(args.days);
if (!Number.isFinite(days)) fail('--days 需为数字（有效期天数；测试过期场景可用负数）');
const keyPath = path.resolve(args['private-key'] || path.join(process.env.HOME || process.cwd(), 'license-signing', 'license-private.key'));

// 护栏：阻止在仓库目录内签发（私钥绝不进仓库）
const repoGit = path.join(process.cwd(), '.git');
const cwd = process.cwd();
if (fs.existsSync(repoGit) && keyPath.startsWith(cwd + path.sep)) {
  // 若用户指定了仓库内的路径才阻止；HOME 路径下自动生成的密钥在仓库外则放行
  if (!keyPath.startsWith(path.join(process.env.HOME || '~', 'license-signing'))) {
    fail(`私钥路径（${keyPath}）在当前仓库内！请将签发工具和私钥移到仓库外的独立签发机目录（如 ~/license-signing/）。`);
  }
}

// ---- 私钥加载 / 首次自动生成 ----
let privateKey;
if (fs.existsSync(keyPath)) {
  try { privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8')); }
  catch (e) { fail(`私钥文件解析失败（${keyPath}）：${e.message}`); }
} else {
  const { publicKey, privateKey: kp } = crypto.generateKeyPairSync('ed25519');
  privateKey = kp;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, kp.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  console.error(`🔑 已生成新密钥对：${keyPath}（新建文件已设 600 权限，请妥善保管，绝不提交仓库/上传服务器）`);
  console.error('   公钥 hex（请更新到 src-server/lib/edition.js 的 PUBLIC_KEY_HEX，或部署机设环境变量 LICENSE_PUBKEY_HEX）：');
  console.error(`   ${pubHex}`);
}

// ---- 签发（issued_at 当天起算，expires_at = 当天 + days；到期日当天仍有效）----
function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const issued_at = localDateStr();
const expires = new Date();
expires.setDate(expires.getDate() + days);
const expires_at = localDateStr(expires);
const license_key = crypto.randomBytes(16).toString('hex'); // 32 位随机 hex（展示仅前缀）

// canonical：五字段按字母序键（customer/edition/expires_at/issued_at/license_key）——签发端手工展开保持独立实现
const canonical = JSON.stringify({ customer, edition, expires_at, issued_at, license_key });
const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('hex');
const license = { customer, edition, issued_at, expires_at, license_key, signature };

// 护栏：与验证端 canonicalOf 交叉校验（两端同规则；漂移在此暴露而不是签出废票）
const { canonicalOf } = require('../src-server/lib/edition');
if (canonicalOf(license) !== canonical) fail('canonical 序列化与验证端（lib/edition.js canonicalOf）不一致，请检查两端字段排序');

const out = JSON.stringify(license, null, 2);
if (args.out) {
  const outFile = path.resolve(String(args.out));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, out + '\n', { mode: 0o644 });
  console.error(`✅ 已签发 ${edition} License → ${outFile}（客户：${customer}，有效期至 ${expires_at}）`);
  console.error('   部署方式：将 license.json 放到部署机数据目录（data/license.json）后重启或热加载。');
} else {
  console.error(`✅ 已签发 ${edition} License（客户：${customer}，有效期至 ${expires_at}）——JSON 输出到 stdout`);
  console.log(out);
}
