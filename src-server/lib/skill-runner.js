/**
 * D1-4 可执行技能运行器（2026-11-21）
 *
 * 把「技能记录」串成一次受控沙箱执行：
 *   manifest 校验 → 权限声明（网络白名单）→ 按用户注入 secrets → 沙箱子进程执行 → 输出脱敏 → 审计落库。
 *
 * 安全要点：
 *   - 代码永远在 sandbox.runIsolated 的独立子进程中执行（崩溃/逃逸面限于一进程）；
 *   - secrets 仅在运行期解密注入 globalThis.SKILL_SECRETS，绝不落日志、绝不回显；
 *   - 输出经 skill-secrets.scrub 二次脱敏（防技能把凭据回显进 stdout/stderr）。
 */
const { db, now } = require('../db');
const { runIsolated } = require('./sandbox');
const sp = require('./skill-package');
const secrets = require('./skill-secrets');

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 执行一个可执行技能。
 * @param {object} skill  skill_assets 行（需含 id / manifest / owner）
 * @param {object} opts   { owner, args, timeoutMs }
 * @returns {Promise<object>} { status, stdout, stderr, durationMs, runId, permissions, error? }
 *   status: success | failed | timeout | denied
 */
async function runSkill(skill, opts = {}) {
  const owner = opts.owner || skill.owner;
  const v = sp.validateManifest(skill.manifest);
  if (!v.executable) {
    return { status: 'denied', error: '该技能不是可执行技能（manifest 缺少 entry / entry_code）', stdout: '', stderr: '' };
  }
  if (!v.ok) {
    return { status: 'denied', error: 'manifest 校验失败：' + v.errors.join('；'), stdout: '', stderr: '' };
  }
  const m = v.manifest;

  // 解析执行体：优先内联 entry_code，否则从包内文件读 entry
  let code = m.entry_code;
  const auxFiles = {};
  if (!code) {
    const pkgFiles = m.files || {};
    if (pkgFiles[m.entry] != null) {
      code = String(pkgFiles[m.entry]);
      for (const [k, val] of Object.entries(pkgFiles)) {
        if (k !== m.entry) auxFiles[k] = String(val);
      }
    } else {
      // 兜底：未随包提供 entry 文件时，把 entry 当内联代码（便于手工/测试场景）
      code = m.entry;
    }
  }
  if (!String(code).trim()) {
    return { status: 'denied', error: `入口代码为空（entry=${m.entry || '-'}），请检查包内容`, stdout: '', stderr: '' };
  }

  // 按声明注入 secrets（仅注入技能声明的密钥名，收敛暴露面；未声明则注入该技能全部已配密钥）
  const all = secrets.getSecretsForRun(owner, skill.id);
  const declared = m.secrets.length ? m.secrets : Object.keys(all);
  const inject = {};
  for (const n of declared) if (all[n] !== undefined) inject[n] = all[n];
  const maskValues = Object.values(inject).filter(Boolean);

  const netAllow = sp.netAllowOf(m);
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);

  // 审计行（running 态先落库，终态回写）
  const info = db.prepare("INSERT INTO skill_runs (skill_id, owner, status, created_at) VALUES (?,?, 'running', ?)")
    .run(skill.id, owner, now());
  const runId = Number(info.lastInsertRowid);

  let result;
  try {
    result = await runIsolated({
      code,
      files: Object.keys(auxFiles).length ? auxFiles : undefined,
      globals: { SKILL_ARGS: opts.args || {}, SKILL_SECRETS: inject },
      netAllow,
      mask: maskValues,
      timeoutMs,
      memMb: 128,
      owner,
      agentId: null,
      sessionId: null,
    });
  } catch (e) {
    db.prepare('UPDATE skill_runs SET status=?, stderr_excerpt=? WHERE id=?').run('failed', String(e.message).slice(0, 1000), runId);
    return { status: 'failed', error: '执行异常：' + e.message, stdout: '', stderr: '', runId };
  }

  const stdout = secrets.scrub(result.stdout || '', maskValues);
  const stderr = secrets.scrub(result.stderr || '', maskValues);
  db.prepare('UPDATE skill_runs SET status=?, exit_code=?, duration_ms=?, stdout_excerpt=?, stderr_excerpt=? WHERE id=?')
    .run(result.status, result.exitCode ?? -1, result.durationMs ?? null, stdout.slice(0, 2000), stderr.slice(0, 1000), runId);

  return {
    status: result.status,
    stdout,
    stderr,
    durationMs: result.durationMs,
    runId,
    sandboxRunId: result.runId,
    permissions: m.permissions,
    risk: sp.permRisk(m),
  };
}

/** 某技能运行历史（归属校验：仅 owner） */
function runHistory(skillId, owner, limit = 20) {
  return db.prepare('SELECT id, status, exit_code, duration_ms, stdout_excerpt, stderr_excerpt, created_at FROM skill_runs WHERE skill_id=? AND owner=? ORDER BY id DESC LIMIT ?')
    .all(skillId, owner, Math.min(100, Math.max(1, limit)));
}

module.exports = { runSkill, runHistory };
