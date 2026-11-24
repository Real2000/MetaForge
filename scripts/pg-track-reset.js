#!/usr/bin/env node
/**
 * PG-1 CI 轨道（M6，2026-11-23）：tenant-e2e 的 PG 测试库复位脚本
 *
 * 作用（npm run test:tenant:pg 的前置步骤）：
 *   1. 确保 PG 实例上有 mt7_e2e 测试库（不存在则建，owner=mt7_app——必须以非超户
 *      连接与持有库，RLS 验收语义才成立：PG 超户永远绕过 RLS，FORCE 也拦不住）；
 *   2. DROP/CREATE public schema——每轮全链冷启动（建表 119 → 迁移 140 → RLS 全量应用），
 *      与生产切换后的首次启动路径同构。
 *
 * 连接约定：
 *   - 管理连接（建库）：PG_ADMIN_CONN（默认 postgres 超户，仅本脚本用）
 *   - 业务库操作：PG_E2E_CONN（默认 mt7_app）
 */
'use strict';
const { Client } = require('pg');

const ADMIN = process.env.PG_ADMIN_CONN || 'postgres://postgres:postgres@localhost:5432/postgres';
const APP = process.env.PG_E2E_CONN || 'postgres://mt7_app:mt7_app_poc@localhost:5432/mt7_e2e';

async function main() {
  let admin = null;
  try {
    admin = new Client({ connectionString: ADMIN, connectionTimeoutMillis: 5000 });
    await admin.connect();
  } catch (e) {
    console.error('[pg-track-reset] 无法连接 PG 管理端（mt7-poc-pg 容器未启动？）：' + e.message);
    process.exit(2);
  }
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname='mt7_e2e'");
  if (!exists.rowCount) {
    await admin.query('CREATE DATABASE mt7_e2e OWNER mt7_app');
    console.log('[pg-track-reset] 已创建测试库 mt7_e2e（owner=mt7_app，非超户——RLS 验收语义成立）');
  }
  await admin.end();

  const app = new Client({ connectionString: APP });
  await app.connect();
  await app.query('DROP SCHEMA public CASCADE');   // PG 16：库 owner（pg_database_owner）= mt7_app，可重建
  await app.query('CREATE SCHEMA public');
  console.log('[pg-track-reset] mt7_e2e public schema 已复位（本轮全链冷启动）');
  await app.end();
}

main().catch(e => { console.error('[pg-track-reset] ' + e.message); process.exit(1); });
