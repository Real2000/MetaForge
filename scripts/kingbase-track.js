#!/usr/bin/env node
/**
 * IC-1 CI 轨道（M11，2026-11-25）：kingbase tenant-e2e 一键轨道（D-10「容器即用即删」）
 *
 * 一条命令完成：镜像检查 → 容器拉起（--privileged + DB_MODE=pg）→ 就绪等待 → 库/schema 复位
 * → tenant-e2e 全量（AGENT_DB_DRIVER=pg + kingbase 方言）→ 容器删除（finally 保证，失败也删）。
 *
 * 设计口径（D-10 拍板）：镜像常驻 Docker 本地磁盘（766MB，一次性导入），容器即用即删——
 * 「容器常备」的真实成本是 kingbase 进程常驻 ~1GB 内存，且本机 Docker Desktop 存在被关闭的
 * 历史（2026-11-25 mt7-poc-pg 即因 Docker 重启退出），常驻不可靠；冷启动 ~45s 的固定成本由
 * 本脚本工程化消化（相对 29 用例全量回归的时长占比可忽略）。
 *
 * 用法：
 *   npm run test:tenant:kingbase     # 一键轨道（容器自动清理）
 * 可覆盖环境变量：KB_IMAGE / KB_CONTAINER / KB_PORT / KB_ADMIN_CONN / KB_E2E_CONN
 * 前置：Docker Desktop 运行中 + 镜像已导入（docker load -i kingbase_v009r001c010b0004_single_x86.tar）
 * 退出码：e2e 子进程退出码（0=全绿）；容器无论如何都会删除（含失败路径）。
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const IMAGE = process.env.KB_IMAGE || 'kingbase_v009r001c010b0004_single_x86:v1';
const CONTAINER = process.env.KB_CONTAINER || 'kingbase-track';
const PORT = process.env.KB_PORT || '54321';
const ADMIN_CONN = process.env.KB_ADMIN_CONN || `postgres://system:Mt7kingbase2026@localhost:${PORT}/kingbase`;
const E2E_CONN = process.env.KB_E2E_CONN || `postgres://mt7_app:mt7_app_poc@localhost:${PORT}/xc1_kingbase_e2e`;
// 超户口令从管理端连接串派生（单一事实源）：镜像初始化密码经 DB_PASSWORD 注入——缺省为镜像内
// default_pass（未知值），不注入则 reset/probe 的 system/Mt7kingbase2026 约定必然连不上（IC-1 首跑踩坑）
const ADMIN_PWD = decodeURIComponent(new URL(ADMIN_CONN).password);

/** docker 执行（check=true 时失败即抛；stderr 全量捕获防泄漏式截断掩盖根因） */
function docker(args, check = true) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (check && r.status !== 0) {
    throw new Error(`docker ${args[0]} 失败：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  }
  return r;
}

/** 前置检查：镜像在本地 + 端口未被其他容器占用 + 清理同名残留（上轮硬杀留下的孤儿容器） */
function preflight() {
  const img = docker(['image', 'inspect', IMAGE], false);
  if (img.status !== 0) {
    throw new Error(`镜像 ${IMAGE} 不在本地——先导入：docker load -i kingbase_v009r001c010b0004_single_x86.tar`);
  }
  const ps = docker(['ps', '--format', '{{.Names}}|{{.Ports}}']).stdout
    .split('\n').filter(Boolean).map((l) => l.split('|'))
    .filter(([, ports]) => ports.includes(`:${PORT}->`));
  if (ps.length && ps[0][0] !== CONTAINER) {
    throw new Error(`端口 ${PORT} 被容器 ${ps[0][0]} 占用——先停它，或用 KB_PORT 换端口`);
  }
  if (docker(['inspect', CONTAINER], false).status === 0) {
    docker(['rm', '-f', CONTAINER], false);
    console.log(`[kingbase-track] 已清理同名残留容器 ${CONTAINER}`);
  }
}

/** 就绪等待：admin 连接轮询（冷启动实测 ~45s，上限 120s；kingbase 无 pg_isready 语义需实连） */
async function waitReady(timeoutMs = 120000) {
  const { Client } = require('pg');
  const t0 = Date.now();
  for (;;) {
    try {
      const c = new Client({ connectionString: ADMIN_CONN, connectionTimeoutMillis: 3000 });
      await c.connect();
      await c.query('SELECT 1');
      await c.end();
      console.log(`[kingbase-track] 容器就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      return;
    } catch {
      if (Date.now() - t0 > timeoutMs) throw new Error(`kingbase 就绪超时（${timeoutMs / 1000}s）——docker logs ${CONTAINER} 排查`);
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
}

async function main() {
  const t0 = Date.now();
  preflight();
  console.log(`[kingbase-track] 拉起容器 ${CONTAINER}（镜像 ${IMAGE}，即用即删模式）`);
  docker(['run', '-d', '--name', CONTAINER, '--privileged=true',
    '-e', 'DB_MODE=pg', '-e', 'DB_USER=system', '-e', `DB_PASSWORD=${ADMIN_PWD}`,
    '-p', `${PORT}:54321`, IMAGE]);
  let e2eStatus = 1;
  try {
    await waitReady();
    const reset = spawnSync(process.execPath, [path.join(__dirname, 'kingbase-track-reset.js')], { stdio: 'inherit' });
    if (reset.status !== 0) throw new Error(`轨道复位失败（退出码 ${reset.status}）`);
    console.log('[kingbase-track] 运行 tenant-e2e（AGENT_DB_DRIVER=pg + DB_DIALECT=kingbase）');
    const e2e = spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'tenant-e2e.js')], {
      stdio: 'inherit',
      env: { ...process.env, AGENT_DB_DRIVER: 'pg', PG_CONN: E2E_CONN, DB_DIALECT: 'kingbase' },
    });
    e2eStatus = e2e.status === null ? 1 : e2e.status;
  } finally {
    // 即用即删：任何路径（成功/失败/异常）都删容器——不把 kingbase 进程留在生产机
    const rm = docker(['rm', '-f', CONTAINER], false);
    console.log(`[kingbase-track] 容器已清理${rm.status === 0 ? '' : '（失败——手工 docker rm -f ' + CONTAINER + '）'}`);
  }
  console.log(`[kingbase-track] 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，e2e 退出码 ${e2eStatus}`);
  process.exitCode = e2eStatus;
}

main().catch((e) => { console.error('[kingbase-track] 失败：' + e.message); process.exitCode = 1; });