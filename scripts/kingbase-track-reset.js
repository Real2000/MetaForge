#!/usr/bin/env node
/**
 * IC-1 CI 轨道（M11，2026-11-25）：tenant-e2e 的 kingbase 测试库复位脚本
 *
 * 定位：scripts/pg-track-reset.js 的 kingbase 姊妹版（npm run test:tenant:kingbase 的前置步骤），
 * 资产由 XC-1 演练脚本提升转正（.temp/xc1-kb-reset.js → 本文件，逻辑逐行等价 + 连接参数化）。
 *
 * 与 PG 版的唯一差异（XC-1 差异清单 #2，PG12 系语义）：
 *   kingbase 中 public schema 的 owner 是超户（system），库 owner（mt7_app）无权 DROP SCHEMA
 *   （PG16 中 public 归 pg_database_owner、库主可自建）——schema 冷启动必须由管理端连接执行
 *   `CREATE SCHEMA public AUTHORIZATION mt7_app`，否则 db.js 启动报 no schema。
 *
 * 连接约定（与 pg-track-reset 同款环境变量风格）：
 *   - 管理连接：KB_ADMIN_CONN（默认本地演练容器 system 超户，仅本脚本用）
 *   - 业务库连接：KB_E2E_CONN（默认 mt7_app 非超户——必须以非超户持有库，RLS 验收语义才成立）
 *
 * 运行：node scripts/kingbase-track-reset.js（容器未起时报错退出码 2，提示先起 kingbase-track）
 */
'use strict';
const { Client } = require('pg');

const ADMIN = process.env.KB_ADMIN_CONN || 'postgres://system:Mt7kingbase2026@localhost:54321/kingbase';
const APP = process.env.KB_E2E_CONN || 'postgres://mt7_app:mt7_app_poc@localhost:54321/xc1_kingbase_e2e';
// 测试库名从业务连接串派生（与 pg-track-reset 的 mt7_e2e 固定名不同：kingbase 需管理端建库，
// 名字必须参数一致，派生比双份配置少一处漂移面）
const E2E_DB = decodeURIComponent(new URL(APP).pathname.replace(/^\//, ''));

async function main() {
  let admin = null;
  try {
    admin = new Client({ connectionString: ADMIN, connectionTimeoutMillis: 5000 });
    await admin.connect();
  } catch (e) {
    console.error('[kingbase-track-reset] 无法连接 kingbase 管理端（kingbase-track 容器未启动？）：' + e.message);
    process.exit(2);
  }
  // 幂等：角色与库保障（库 owner 必须是业务角色——超户连接会绕过 RLS，验收语义失效）
  const hasUser = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='mt7_app'");
  if (!hasUser.rowCount) await admin.query("CREATE USER mt7_app WITH PASSWORD 'mt7_app_poc'");
  const hasDb = await admin.query("SELECT 1 FROM pg_database WHERE datname='" + E2E_DB.replace(/'/g, "''") + "'");
  if (!hasDb.rowCount) await admin.query(`CREATE DATABASE ${quoteIdent(E2E_DB)} OWNER mt7_app`);
  else await admin.query(`ALTER DATABASE ${quoteIdent(E2E_DB)} OWNER TO mt7_app`);
  console.log(`[kingbase-track-reset] 角色/库就绪（${E2E_DB}，owner=mt7_app，非超户——RLS 验收语义成立）`);

  // schema 冷启动（管理端直连目标库执行——kingbase 差异 #2 的适配点；不跨库 DDL）
  await admin.end();
  const ddl = new Client({ ...connParts(ADMIN), database: E2E_DB });
  await ddl.connect();
  await ddl.query('DROP SCHEMA public CASCADE');
  await ddl.query('CREATE SCHEMA public AUTHORIZATION mt7_app');
  console.log('[kingbase-track-reset] public schema 已由管理端重建（AUTHORIZATION mt7_app）');
  await ddl.end();

  // 验证：mt7_app 现在是 schema owner（后续建表/迁移/RLS 全量路径全归它）
  const app = new Client({ connectionString: APP });
  await app.connect();
  const r = await app.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='public'");
  console.log('[kingbase-track-reset] public schema owner =', r.rows[0].owner);
  await app.end();
  if (r.rows[0].owner !== 'mt7_app') {
    console.error('[kingbase-track-reset] ✗ schema owner 异常（期望 mt7_app）——RLS 验收语义不成立');
    process.exit(1);
  }
  console.log('[kingbase-track-reset] ✅ 复位完成（本轮全链冷启动）');
}

/** URL → pg Client 连接参数（admin 会话切换 database 用；URL 已在白名单式使用下安全） */
function connParts(url) {
  const u = new URL(url);
  return {
    host: u.hostname, port: Number(u.port || 5432),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
  };
}

/** 标识符引用（库名来自配置——防御式引号，非法名直接拒绝） */
function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('非法库名：' + name);
  return '"' + name + '"';
}

main().catch((e) => { console.error('[kingbase-track-reset] 失败:', e.message); process.exit(1); });