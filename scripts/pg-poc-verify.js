#!/usr/bin/env node
/**
 * MT-7（2026-11-23）PG 桥 PoC 验证脚本 —— 需真实 PostgreSQL 环境
 *
 * 验收三点（计划表 MT-7 原文）：
 *   ① 核心资源读写走 PG：AGENT_DB_DRIVER=pg 启动 db.js 全链（建表 119 表→迁移 140→RLS），
 *      以业务形态（db.prepare().run/get）在租户上下文内写入并读回 agents 核心资源
 *   ② RLS 生效（DB 层强制隔离）：setTenantContext(1) 插入租户 1 行、(2) 插入租户 2 行，
 *      各上下文查询仅见本租户行（FORCE RLS——不依赖应用层自觉）
 *   ③ 并发写无 SQLITE_BUSY：两子进程并发 INSERT（SQLite 单写者会锁等待，PG MVCC 无此约束）
 *
 * 前置：
 *   - PostgreSQL 实例（PG_CONN=postgres://user:pass@localhost:5432/mt7_poc）
 *   - npm i pg
 *   - ⚠️ 必须以「非超级用户」连接（默认 mt7_app）：PG 超级用户始终绕过 RLS（FORCE 也拦不住），
 *     超户连接将使验收点② 形同虚设。角色与库归属准备（一次性）：
 *     CREATE ROLE mt7_app LOGIN PASSWORD 'mt7_app_poc';
 *     ALTER DATABASE mt7_poc OWNER TO mt7_app;   -- PG 16：public schema 归 pg_database_owner（即库主）
 *     （建表后表/序列归 mt7_app 所有，ALTER TABLE ... ENABLE/FORCE RLS 与 CREATE POLICY 需表主权限）
 * 用法：node scripts/pg-poc-verify.js
 */
'use strict';
const { execFileSync, spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONN = process.env.PG_CONN || 'postgres://mt7_app:mt7_app_poc@localhost:5432/mt7_poc';
const ENV = { ...process.env, AGENT_DB_DRIVER: 'pg', PG_CONN: CONN, AGENT_DATA_DIR: path.join(ROOT, '.temp', 'pg-poc-data') };

function step(name, fn) {
  process.stdout.write(`\n${name} ... `);
  try { const r = fn(); console.log('✅ ' + (r || 'OK')); return true; }
  catch (e) {
    // execFileSync 超时/非零退出错误对象附带子进程 stderr——尾部透出便于定位
    //（db.js 初始化的非致命告警（迁移框架/RLS）也走 stderr，不看会误判）
    const tail = e && e.stderr ? String(e.stderr).trim().split('\n').filter(Boolean).slice(-8).join('\n   ') : '';
    console.log('❌ ' + e.message + (tail ? `\n   [stderr]\n   ${tail}` : ''));
    return false;
  }
}

async function main() {
  let pass = true;
  // ① 全链启动（建表+迁移+RLS）+ 核心资源读写（租户 1 上下文——FORCE RLS 下无上下文=基线租户 0，
  //    tenant_id=1 的行必须在其租户上下文内写入，这正是 RLS 强制隔离的语义本身）
  pass &= step('① PG 全链启动（建表→迁移→RLS）+ 核心资源（agents）读写', () => {
    const out = execFileSync('node', ['-e', `
      process.env.AGENT_DB_DRIVER = 'pg';
      process.env.PG_CONN = ${JSON.stringify(CONN)};
      const { db: d } = require('./src-server/db'); // db.js 导出 { db, dbRead, ... }（桥或 better-sqlite3 同接口）
      d.setTenantContext(1); // FORCE RLS：写入 tenant_id=1 行须在租户 1 上下文（WITH CHECK 强制归属）
      const info = d.prepare('INSERT INTO agents (name,description,type,status,source,owner,tenant_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,datetime(\\'now\\',\\'localtime\\'))').run('mt7-poc-agent', 'MT-7 PoC 验证智能体', 'digital', 'draft', 'self', 'poc', 1, '');
      if (!info.lastInsertRowid) throw new Error('lastInsertRowid 契约缺失：' + JSON.stringify(info));
      const row = d.prepare('SELECT id, name, tenant_id FROM agents WHERE id=?').get(info.lastInsertRowid);
      if (!row || row.name !== 'mt7-poc-agent') throw new Error('读回不符：' + JSON.stringify(row));
      if (d.prepare('SELECT COUNT(*) c FROM agents').get().c < 1) throw new Error('核心资源查询失败');
      console.log('lastInsertRowid=' + info.lastInsertRowid + ' 读写通路 OK');
    `], { cwd: ROOT, env: ENV, encoding: 'utf8', timeout: 180000 });
    return out.trim().split('\n').pop();
  });

  // ② RLS 强制隔离
  pass &= step('② RLS 强制隔离（FORCE，双租户互不可见）', () => {
    const out = execFileSync('node', ['-e', `
      process.env.AGENT_DB_DRIVER = 'pg';
      process.env.PG_CONN = ${JSON.stringify(CONN)};
      const { db: d } = require('./src-server/db'); // 导出为 { db, dbRead, ... }——须解构取 db（曾漏解构致 TypeError）
      d.setTenantContext(1);
      d.prepare('INSERT INTO agents (name,type,status,source,owner,tenant_id) VALUES (?,?,?,\\'self\\',\\'poc1\\',1)').run('rls-t1', 'digital', 'draft');
      d.setTenantContext(2);
      d.prepare('INSERT INTO agents (name,type,status,source,owner,tenant_id) VALUES (?,?,?,\\'self\\',\\'poc2\\',2)').run('rls-t2', 'digital', 'draft');
      d.setTenantContext(1);
      const seeT1 = d.prepare('SELECT COUNT(*) c FROM agents').get().c;
      if (!d.prepare('SELECT 1 FROM agents WHERE name=?').get('rls-t1')) throw new Error('租户 1 应见自己行');
      if (d.prepare('SELECT 1 FROM agents WHERE name=?').get('rls-t2')) throw new Error('RLS 失效：租户 1 见到了租户 2 的行（FORCE 未生效？）');
      d.setTenantContext(2);
      if (d.prepare('SELECT 1 FROM agents WHERE name=?').get('rls-t1')) throw new Error('RLS 失效：租户 2 见到了租户 1 的行');
      console.log('双租户互不可见 OK（见 ' + seeT1 + ' 行）');
    `], { cwd: ROOT, env: ENV, encoding: 'utf8', timeout: 60000 });
    return out.trim().split('\n').pop();
  });

  // ③ 并发写（两子进程同时 INSERT——SQLite 会 SQLITE_BUSY 等待，PG MVCC 直接并行）
  pass &= await stepAsync('③ 并发写无 SQLITE_BUSY（MVCC）', async () => {
    const workers = [0, 1].map(w => new Promise(resolve => {
      const p = spawn('node', ['-e', `
        process.env.AGENT_DB_DRIVER = 'pg';
        process.env.PG_CONN = ${JSON.stringify(CONN)};
        const { db: d } = require('./src-server/db');
        d.setTenantContext(1);
        for (let i = 0; i < 20; i++) d.prepare('INSERT INTO agents (name,type,status,source,owner,tenant_id) VALUES (?,?,?,\\'self\\',\\'conc${w}\\',1)').run('conc-w${w}-' + i, 'digital', 'draft');
        console.log('worker ${w} done');
      `], { cwd: ROOT, env: ENV, stdio: 'pipe' });
      let out = '';
      p.stdout.on('data', c => { out += c; });
      p.stderr.on('data', c => { out += c; });
      p.on('exit', code => resolve({ code, out }));
    }));
    const rs = await Promise.all(workers);
    const bad = rs.filter(r => r.code !== 0 || !/done/.test(r.out));
    if (bad.length) throw new Error('并发写失败：' + JSON.stringify(bad.map(r => r.out.slice(-120))));
    return '两进程各 20 条并发 INSERT 全部成功（MVCC，无 SQLITE_BUSY）';
  });

  console.log('\n==== MT-7 PoC 验证' + (pass ? '通过' : '存在失败项') + ' ====');
  process.exit(pass ? 0 : 1);
}

/** 异步步骤包装（并发写等异步验证） */
async function stepAsync(name, fn) {
  process.stdout.write(`\n${name} ... `);
  try { const r = await fn(); console.log('✅ ' + (r || 'OK')); return true; }
  catch (e) { console.log('❌ ' + e.message); return false; }
}

main();
