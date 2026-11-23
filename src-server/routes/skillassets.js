/** 技能资产（2026-10-20 P3 技能资产化）：可复用的「提示词+工具」组合
 *  前台「技能」页浏览/创建/管理；对话输入 @技能名 即调用（chat.js /stream 解析注入）。
 *  可见性：status=1 已发布（全员可见可 @ 引用），status=0 私有（仅本人）。
 *  技能名限制中文/字母/数字/下划线/中划线且 ≤20 字（@解析按标记精确匹配需要短名）。
 *
 *  D1-4 可执行技能包（2026-11-21）扩展：
 *    - manifest（入口/参数/权限/依赖规范），非空且含 entry 的技能可被沙箱执行；
 *    - 安装（inline 或 URL）→ 供应链校验（内容哈希 / HMAC 签名 / 权限声明风险）；
 *    - 运行（沙箱 + 按用户注入 secrets + 输出脱敏）→ skill_runs 审计；
 *    - 技能密钥（owner×skill 隔离，加密落盘、掩码回显）；
 *    - 版本与卸载（同 owner+name 覆盖安装即版本升级；卸载级联清密钥与运行记录）。
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { TOOL_DEFS, AGENT_TOOL_DENY } = require('../lib/tools');
const sp = require('../lib/skill-package');
const secrets = require('../lib/skill-secrets');
const { runSkill, runHistory } = require('../lib/skill-runner');
const { loadSecrets } = require('../lib/secrets');

const router = express.Router();
router.use(auth);

const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{1,20}$/;

function normSkill(row, username) {
  let tools = [];
  try { tools = JSON.parse(row.tools || '[]'); } catch { }
  const manifest = sp.normalizeManifest(row.manifest);
  return {
    ...row, tools, mine: row.owner === username,
    manifest,
    executable: sp.isExecutable(manifest),
    perm_risk: sp.permRisk(manifest),
    permissions: sp.summarizePermissions(manifest),
    secret_names: manifest.secrets || [],
  };
}

/** 平台签名密钥（供应链签名校验用；取全局 secrets 的 SKILL_SIGNING_KEY，未配置则视为未签名） */
function signingKey() {
  try { return loadSecrets()['SKILL_SIGNING_KEY'] || ''; } catch { return ''; }
}

/** 解析安装包载荷：{ url } 远程拉取 或 直接内联 { manifest, entry_code, files } */
async function resolvePackage(body) {
  const { url, manifest, entry_code, files, hash, declaredHash, signature } = body || {};
  if (url) {
    if (!/^https?:\/\//i.test(String(url))) throw new Error('仅支持 http(s) 安装地址');
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`拉取安装包失败：HTTP ${r.status}`);
    let doc;
    try { doc = await r.json(); } catch { throw new Error('安装包需为 JSON（V1 支持 JSON 清单；zip 见后续迭代）'); }
    return {
      manifest: doc.manifest || doc, entry_code: doc.entry_code, files: doc.files,
      declaredHash: doc.hash || doc.declaredHash, signature: doc.signature, sourceUrl: url,
    };
  }
  return { manifest, entry_code, files, declaredHash: declaredHash || hash, signature, sourceUrl: '' };
}

// 技能列表：本人全部（含私有）在前 + 他人已发布在后
router.get('/', (req, res) => {
  const rows = dal.q('SELECT * FROM skill_assets WHERE owner=? OR status=1 ORDER BY owner=? DESC, id DESC', [req.user.username, req.user.username]);
  res.json({ code: 0, data: rows.map(r => normSkill(r, req.user.username)) });
});

// 技能详情（含 manifest / 权限摘要）
router.get('/:id', (req, res) => {
  const row = dal.getq('SELECT * FROM skill_assets WHERE id=? AND (owner=? OR status=1)', [req.params.id, req.user.username]);
  if (!row) return res.json({ code: 404, msg: '技能不存在或不可见' });
  res.json({ code: 0, data: normSkill(row, req.user.username) });
});

router.post('/', (req, res) => {
  const { name, description, icon, prompt, tools, status, manifest, runtime, version } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.json({ code: 400, msg: '技能名称不能为空' });
  if (!NAME_RE.test(n)) return res.json({ code: 400, msg: '名称仅支持中文/字母/数字/下划线/中划线，且不超过 20 字（@调用需要短名）' });
  if (!String(prompt || '').trim() && !sp.isExecutable(manifest)) return res.json({ code: 400, msg: '提示词不能为空——除非提供可执行 manifest（entry/entry_code）' });
  if (dal.getq('SELECT id FROM skill_assets WHERE owner=? AND name=?', [req.user.username, n])) {
    return res.json({ code: 400, msg: '你已有同名技能' });
  }
  // manifest 校验（D1-4）
  const vm = sp.validateManifest(manifest);
  if (!vm.ok) return res.json({ code: 400, msg: 'manifest 校验失败：' + vm.errors.join('；') });
  const m = vm.manifest;
  const toolIds = (Array.isArray(tools) ? tools : []).filter(t => TOOL_DEFS[t] && !AGENT_TOOL_DENY.has(t));
  const info = dal.runq('INSERT INTO skill_assets (owner,name,description,icon,prompt,tools,status,manifest,runtime,version,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)', [req.user.username, n, String(description || '').slice(0, 200), String(icon || '✨').slice(0, 4),
      String(prompt || '').slice(0, 4000), JSON.stringify(toolIds), status ? 1 : 0,
      JSON.stringify(m), String(runtime || m.runtime || 'node'), String(version || m.version || '1.0.0'), now()]);
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '创建技能', `${n}（${vm.executable ? '可执行，入口 ' + (m.entry || 'entry_code') + '，权限 ' + (m.permissions.join('/') || '无') : toolIds.length ? '工具：' + toolIds.join('/') : '纯提示词'}，${status ? '已发布' : '私有'}）`, req.ip, now()]);
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

router.put('/:id', (req, res) => {
  const old = dal.getq('SELECT * FROM skill_assets WHERE id=? AND owner=?', [req.params.id, req.user.username]);
  if (!old) return res.json({ code: 404, msg: '技能不存在（只能编辑自己的技能）' });
  const { name, description, icon, prompt, tools, status, manifest, runtime, version } = req.body || {};
  const n = String(name ?? old.name).trim();
  if (!NAME_RE.test(n)) return res.json({ code: 400, msg: '名称仅支持中文/字母/数字/下划线/中划线，且不超过 20 字' });
  const vm = sp.validateManifest(manifest ?? old.manifest);
  if (!vm.ok) return res.json({ code: 400, msg: 'manifest 校验失败：' + vm.errors.join('；') });
  const m = vm.manifest;
  if (!String(prompt ?? (old.prompt || '')).trim() && !vm.executable) return res.json({ code: 400, msg: '提示词不能为空（除非是可执行技能）' });
  const dup = dal.getq('SELECT id FROM skill_assets WHERE owner=? AND name=? AND id != ?', [req.user.username, n, old.id]);
  if (dup) return res.json({ code: 400, msg: '你已有同名技能' });
  const toolIds = (Array.isArray(tools) ? tools : JSON.parse(old.tools || '[]')).filter(t => TOOL_DEFS[t] && !AGENT_TOOL_DENY.has(t));
  dal.runq('UPDATE skill_assets SET name=?,description=?,icon=?,prompt=?,tools=?,status=?,manifest=?,runtime=?,version=? WHERE id=?', [n, String(description ?? old.description).slice(0, 200), String(icon ?? old.icon).slice(0, 4),
      String(prompt ?? old.prompt).slice(0, 4000), JSON.stringify(toolIds),
      status == null ? old.status : (status ? 1 : 0),
      JSON.stringify(m), String(runtime ?? m.runtime ?? old.runtime ?? 'node'), String(version ?? m.version ?? old.version ?? '1.0.0'), old.id]);
  res.json({ code: 0, msg: '已保存' });
});

router.delete('/:id', (req, res) => {
  const old = dal.getq('SELECT id FROM skill_assets WHERE id=? AND owner=?', [req.params.id, req.user.username]);
  if (!old) return res.json({ code: 404, msg: '技能不存在（只能删除自己的技能）' });
  // 级联清理：密钥 + 运行记录（避免孤立数据）
  secrets.purgeSkill(req.user.username, old.id);
  dal.runq('DELETE FROM skill_runs WHERE skill_id=? AND owner=?', [old.id, req.user.username]);
  dal.runq('DELETE FROM skill_assets WHERE id=? AND owner=?', [old.id, req.user.username]);
  res.json({ code: 0, msg: '已卸载' });
});

/* ---------------- D1-4：安装技能包（inline / URL） ---------------- */
router.post('/install', async (req, res) => {
  let pkg;
  try { pkg = await resolvePackage(req.body || {}); }
  catch (e) { return res.json({ code: 400, msg: e.message }); }

  // 组装 manifest：内联字段（entry_code/files）合并进 manifest 对象
  const base = (pkg.manifest && typeof pkg.manifest === 'object') ? { ...pkg.manifest } : {};
  if (pkg.entry_code && !base.entry_code) base.entry_code = String(pkg.entry_code);
  if (pkg.files && typeof pkg.files === 'object' && !base.files) base.files = pkg.files;

  const vm = sp.validateManifest(base);
  if (!vm.ok) return res.json({ code: 400, msg: '安装包 manifest 校验失败：' + vm.errors.join('；') });
  const m = vm.manifest;
  if (!sp.isExecutable(m)) return res.json({ code: 400, msg: '安装包不含可执行入口（entry / entry_code），无法作为可执行技能安装' });
  const name = m.name || ('pkg' + Date.now().toString(36));
  if (!NAME_RE.test(name)) return res.json({ code: 400, msg: `技能名不合法：${name}（中文/字母/数字/下划线/中划线，≤20 字）` });

  // 供应链校验：内容哈希 + 签名（未声明视为"未校验"，仍允许安装但标记 verified=0）
  const sc = sp.verifySupplyChain(m, { declaredHash: pkg.declaredHash, signature: pkg.signature, key: signingKey() });
  if (sc.integrity === false) return res.json({ code: 400, msg: '供应链校验失败：' + sc.notes.join('；') });
  if (sc.signature_ok === false) return res.json({ code: 400, msg: '签名验证失败，拒绝安装：' + sc.notes.join('；') });

  const risk = sp.permRisk(m);
  const perms = sp.summarizePermissions(m);
  const manifestJson = JSON.stringify(m);

  // 同 owner+name：覆盖安装 = 版本升级（保留可见性，更新 manifest/版本/来源）
  const exist = dal.getq('SELECT id FROM skill_assets WHERE owner=? AND name=?', [req.user.username, name]);
  let id, upgraded = false;
  if (exist) {
    dal.runq('UPDATE skill_assets SET description=?,prompt=?,manifest=?,runtime=?,version=?,source_url=?,package_hash=?,verified=? WHERE id=?', [m.description || '', `【可执行技能：${name}】${m.description || ''}`.slice(0, 4000), manifestJson,
        m.runtime, m.version, pkg.sourceUrl || '', sc.hash, sc.verified ? 1 : 0, exist.id]);
    id = exist.id; upgraded = true;
  } else {
    const info = dal.runq('INSERT INTO skill_assets (owner,name,description,icon,prompt,tools,status,manifest,runtime,version,source_url,package_hash,verified,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)', [req.user.username, name, String(m.description || '').slice(0, 200), '📦',
        `【可执行技能：${name}】${m.description || ''}`.slice(0, 4000), '[]', 0, manifestJson,
        m.runtime, m.version, pkg.sourceUrl || '', sc.hash, sc.verified ? 1 : 0, now()]);
    id = Number(info.lastInsertRowid);
  }
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, upgraded ? '升级技能包' : '安装技能包', `${name} v${m.version}（风险 ${risk}，权限 ${m.permissions.join('/') || '无'}，${sc.verified ? '已校验' : '未签名'}）`, req.ip, now()]);
  res.json({ code: 0, msg: upgraded ? '技能包已升级' : '技能包已安装', data: { id, name, version: m.version, upgraded, hash: sc.hash, verified: sc.verified, integrity: sc.integrity, signature_ok: sc.signature_ok, risk, permissions: perms, notes: sc.notes } });
});

/* ---------------- D1-4：运行可执行技能 ---------------- */
router.post('/:id/run', async (req, res) => {
  const skill = dal.getq('SELECT * FROM skill_assets WHERE id=? AND (owner=? OR status=1)', [req.params.id, req.user.username]);
  if (!skill) return res.json({ code: 404, msg: '技能不存在或不可见' });
  if (!sp.isExecutable(skill.manifest)) return res.json({ code: 400, msg: '该技能不是可执行技能（纯提示词技能请在对话中 @调用）' });
  const args = (req.body && typeof req.body.args === 'object' && req.body.args) || {};
  const out = await runSkill(skill, { owner: req.user.username, args, timeoutMs: req.body?.timeoutMs });
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '运行技能', `${skill.name}（${out.status}${out.durationMs != null ? '，' + out.durationMs + 'ms' : ''}）`, req.ip, now()]);
  if (out.status === 'denied') return res.json({ code: 400, msg: out.error || '执行被拒绝', data: out });
  res.json({ code: 0, data: out });
});

/** 运行历史（仅 owner） */
router.get('/:id/runs', (req, res) => {
  const skill = dal.getq('SELECT id FROM skill_assets WHERE id=? AND owner=?', [req.params.id, req.user.username]);
  if (!skill) return res.json({ code: 404, msg: '技能不存在（只能查看自己的技能运行记录）' });
  res.json({ code: 0, data: runHistory(skill.id, req.user.username, Number(req.query.limit) || 20) });
});

/* ---------------- D1-4：技能密钥（owner×skill 隔离，掩码回显） ---------------- */
router.get('/:id/secrets', (req, res) => {
  const skill = dal.getq('SELECT id FROM skill_assets WHERE id=? AND owner=?', [req.params.id, req.user.username]);
  if (!skill) return res.json({ code: 404, msg: '技能不存在（只能管理自己技能的密钥）' });
  res.json({ code: 0, data: secrets.listSecrets(req.user.username, skill.id) });
});

router.post('/:id/secrets', (req, res) => {
  const skill = dal.getq('SELECT id FROM skill_assets WHERE id=? AND owner=?', [req.params.id, req.user.username]);
  if (!skill) return res.json({ code: 404, msg: '技能不存在（只能管理自己技能的密钥）' });
  const { name, value } = req.body || {};
  const r = secrets.setSecret(req.user.username, skill.id, name, value);
  if (!r.ok) return res.json({ code: 400, msg: r.msg });
  dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '配置技能密钥', `${skill.name} / ${r.name}（${r.action}）`, req.ip, now()]);
  res.json({ code: 0, msg: r.action === 'created' ? '密钥已保存' : '密钥已更新', data: { name: r.name } });
});

router.delete('/:id/secrets/:name', (req, res) => {
  const skill = dal.getq('SELECT id FROM skill_assets WHERE id=? AND owner=?', [req.params.id, req.user.username]);
  if (!skill) return res.json({ code: 404, msg: '技能不存在（只能管理自己技能的密钥）' });
  secrets.deleteSecret(req.user.username, skill.id, req.params.name);
  res.json({ code: 0, msg: '已删除' });
});

module.exports = router;
