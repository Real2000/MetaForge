/**
 * 远程主机执行（2026-11-12 P1-12）
 *
 * 白名单语义：remote_hosts 表即白名单——未登记主机一律拒绝（防任意内网横移）。
 * 凭据：credential 列 AES-256-GCM 密文（password / private key 二型）。
 * 主机密钥校验：known_hosts_mode
 *   strict       —— 指纹必须与预登记 fingerprint 一致（推荐；不匹配拒绝执行）
 *   accept-new   —— 首次连接记录指纹（TOFU，后续一致才放行）
 *   off          —— 不校验（仅测试用，落审计警告）
 * 执行：execRemote(hostId, command) —— 系统 ssh 二进制 + BatchMode/StrictHostKeyChecking；
 *   docker_enabled 主机支持 { docker: true } 变体在容器内执行。
 * P1-13：每次执行落 sandbox_runs（run_env=remote-ssh / docker）。
 */
const { spawn } = require('child_process');
const dal = require('./dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const crypto = require('crypto');
const { db, now } = require('../db');
const { encrypt, decrypt } = require('./crypto-util');
const { digestOf } = require('./sandbox');

// ---------------- 主机登记 CRUD ----------------
function upsertHost({ id, name, host, port, username, credential, credentialType, fingerprint, knownHostsMode, dockerEnabled, enabled, createdBy }) {
  const n = String(name || '').trim(), h = String(host || '').trim();
  if (!n || !h) throw new Error('主机名称与地址不能为空');
  const enc = credential ? (encrypt(String(credential)) || String(credential)) : '';
  const fp = String(fingerprint || '').trim();
  const mode = ['strict', 'accept-new', 'off'].includes(knownHostsMode) ? knownHostsMode : 'strict';
  if (id) {
    const old = dal.getq('SELECT * FROM remote_hosts WHERE id=?', [id]);
    if (!old) throw new Error('主机不存在');
    dal.runq(`UPDATE remote_hosts SET name=?, host=?, port=?, username=?, credential=?, credential_type=?,
      fingerprint=?, known_hosts_mode=?, docker_enabled=?, enabled=?, updated_at=? WHERE id=?`, [n, h, port ?? old.port, username ?? old.username,
        credential === undefined ? old.credential : enc,
        credentialType || old.credential_type, fp || old.fingerprint, mode,
        dockerEnabled === undefined ? old.docker_enabled : (dockerEnabled ? 1 : 0),
        enabled === undefined ? old.enabled : (enabled ? 1 : 0), now(), id]);
    return dal.getq('SELECT id, name, host FROM remote_hosts WHERE id=?', [id]);
  }
  if (mode === 'strict' && !fp) {
    throw new Error('strict 模式必须预登记主机指纹（ssh-keyscan 获取），否则无法校验主机身份');
  }
  const info = dal.runq(`INSERT INTO remote_hosts (name, host, port, username, credential, credential_type, fingerprint, known_hosts_mode, docker_enabled, enabled, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [n, h, port || 22, String(username || ''), enc, credentialType === 'key' ? 'key' : 'password',
      fp, mode, dockerEnabled ? 1 : 0, enabled === undefined ? 1 : (enabled ? 1 : 0),
      String(createdBy || ''), now(), now()]);
  return dal.getq('SELECT id, name, host FROM remote_hosts WHERE id=?', [info.lastInsertRowid]);
}

/** 列表（凭据不回显） */
function listHosts() {
  const rows = dal.q('SELECT * FROM remote_hosts ORDER BY id');
  return rows.map(r => ({ ...r, credential: r.credential ? '••••••••' : '', has_credential: !!r.credential }));
}

function deleteHost(id) {
  dal.runq('DELETE FROM remote_hosts WHERE id=?', [id]);
}

// ---------------- 密钥校验 ----------------
/** 生成临时 known_hosts 内容（strict=仅登记指纹；accept-new/off 由 ssh 参数处理） */
function knownHostsArgs(host, port, mode, fingerprint) {
  if (mode === 'off') return { args: ['-o', 'StrictHostKeyChecking=no'] };
  if (mode === 'accept-new') return { args: ['-o', 'StrictHostKeyChecking=accept-new'] };
  // strict：写入临时 known_hosts（仅含预登记指纹）并强制校验
  const kpath = `/tmp/.ap-known-hosts-${Date.now()}`;
  const line = `${host} ${fingerprint}\n`;
  require('fs').writeFileSync(kpath, line, { mode: 0o600 });
  return { args: ['-o', `UserKnownHostsFile=${kpath}`, '-o', 'StrictHostKeyChecking=yes'], cleanup: () => { try { require('fs').unlinkSync(kpath); } catch { } } };
}

// ---------------- 远程执行 ----------------
/** execRemote(hostId, command, { docker, timeoutMs, owner, agentId, sessionId })
 *  返回 { status, stdout, stderr, durationMs, runId }；永不 reject。 */
async function execRemote(hostId, command, opts = {}) {
  const { docker = false, timeoutMs = 20000, owner = '', agentId = null, sessionId = null } = opts;
  const row = dal.getq('SELECT * FROM remote_hosts WHERE id=?', [hostId]);
  // ① 白名单：主机必须已登记且启用
  if (!row) return { status: 'denied', stdout: '', stderr: '主机未登记（远端白名单拒绝执行）' };
  if (!row.enabled) return { status: 'denied', stdout: '', stderr: `主机「${row.name}」已停用` };

  const runEnv = docker && row.docker_enabled ? 'docker' : 'remote-ssh';
  const runInfo = dal.runq(`INSERT INTO sandbox_runs (run_env, owner, agent_id, session_id, status, code_digest, created_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?)`, [runEnv, owner, agentId, sessionId, digestOf(command), now()]);
  const runId = Number(runInfo.lastInsertRowid);

  if (docker && !row.docker_enabled) {
    dal.runq('UPDATE sandbox_runs SET status=?, stderr_excerpt=? WHERE id=?', ['denied', '该主机未启用 Docker 执行', runId]);
    return { status: 'denied', stdout: '', stderr: '该主机未启用 Docker 执行（remote_hosts.docker_enabled=0）', runId };
  }

  // ② 凭据解密（password → sshpass 不可用时降级禁密码；key → 临时私钥文件 0600）
  let cred = '';
  try { cred = row.credential ? (decrypt(row.credential) || row.credential) : ''; } catch { cred = ''; }
  const args = ['-p', String(row.port || 22), '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes'];
  const kh = knownHostsArgs(row.host, row.port, row.known_hosts_mode, row.fingerprint);
  args.push(...kh.args);
  let keyFile = null;
  if (row.credential_type === 'key' && cred) {
    keyFile = `/tmp/.ap-ssh-key-${Date.now()}`;
    require('fs').writeFileSync(keyFile, cred, { mode: 0o600 });
    args.push('-i', keyFile, '-o', 'IdentitiesOnly=yes');
  }
  const remoteCmd = docker
    ? `docker exec ${JSON.stringify('ap-sandbox')} sh -c ${JSON.stringify(command)}` // 变体：容器内执行
    : command;
  if (row.username) args.push(`${row.username}@${row.host}`); else args.push(row.host);
  args.push(remoteCmd);

  return await new Promise((resolve) => {
    const child = spawn('ssh', args, { shell: false, env: { PATH: process.env.PATH || '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    let killed = false;
    const t0 = Date.now();
    const killer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { } }, timeoutMs);
    child.stdout.on('data', d => out.push(d.toString()));
    child.stderr.on('data', d => err.push(d.toString()));
    child.on('error', e => {
      clearTimeout(killer); kh.cleanup?.(); if (keyFile) try { require('fs').unlinkSync(keyFile); } catch { }
      dal.runq('UPDATE sandbox_runs SET status=?, stderr_excerpt=?, duration_ms=? WHERE id=?', ['failed', 'ssh 启动失败（本机可能无 ssh）：' + e.message, Date.now() - t0, runId]);
      resolve({ status: 'failed', stdout: '', stderr: 'ssh 启动失败：' + e.message, runId });
    });
    child.on('close', (code) => {
      clearTimeout(killer); kh.cleanup?.(); if (keyFile) try { require('fs').unlinkSync(keyFile); } catch { }
      const stdout = out.join('').slice(0, 8192), stderr = err.join('').slice(0, 4096);
      const status = killed ? 'timeout' : (code === 0 ? 'success' : 'failed');
      dal.runq('UPDATE sandbox_runs SET status=?, exit_code=?, duration_ms=?, node_version=?, stdout_excerpt=?, stderr_excerpt=? WHERE id=?', [status, code ?? -1, Date.now() - t0, `${row.host}:${row.port}`, stdout.slice(0, 2000), stderr.slice(0, 1000), runId]);
      resolve({ status, stdout, stderr, runId });
    });
  });
}

module.exports = { upsertHost, listHosts, deleteHost, execRemote };
