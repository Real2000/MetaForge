/**
 * U2-1 / N7-P4 信创 DAL —— 数据库连接抽象（sqlite | dm | kingbase）
 *
 * 目的：把「打开连接 / 生成连接参数 / 绑定方言」抽象为统一入口，驱动按需惰性加载。
 *       默认 sqlite（better-sqlite3）路径行为与现状完全一致；达梦 / 金仓驱动为可选项，
 *       未安装对应依赖时给出可读错误并提示回退 sqlite，不使进程崩溃。
 *
 * 依赖（可选，未随包提供）：
 *   - 达梦：dmdb（官方 Node 驱动）
 *   - 金仓：pg（KingbaseES 兼容 PostgreSQL 协议）
 */
'use strict';

const sqlDialect = require('./sql-dialect');

const DRIVERS = {
  sqlite: {
    name: 'sqlite',
    label: 'SQLite（better-sqlite3）',
    module: 'better-sqlite3',
    dialect: 'sqlite',
    readonlySupported: true,
  },
  dm: {
    name: 'dm',
    label: '达梦 DM8',
    module: 'dmdb',
    dialect: 'dm',
    readonlySupported: false,
  },
  kingbase: {
    name: 'kingbase',
    label: '人大金仓 KingbaseES',
    module: 'pg',
    dialect: 'kingbase',
    readonlySupported: false,
  },
};

/** 依赖是否已安装（惰性探测，不加载） */
function moduleInstalled(mod) {
  try { require.resolve(mod); return true; } catch { return false; }
}

/** 列出全部驱动及其可用性（供部署自检 / 管理端展示） */
function listDrivers() {
  return Object.values(DRIVERS).map(d => ({
    name: d.name,
    label: d.label,
    module: d.module,
    dialect: d.dialect,
    available: moduleInstalled(d.module),
  }));
}

/** 指定驱动是否可用 */
function isAvailable(name) {
  const d = DRIVERS[String(name || '').toLowerCase()];
  return !!d && moduleInstalled(d.module);
}

/**
 * 创建驱动实例。
 * @param {string} [name='sqlite']
 * @returns {{name:string, dialect:string, def:object, translate:(sql:string)=>object, connect:(opts:object)=>object, available:()=>boolean}}
 */
function createDriver(name = 'sqlite') {
  const key = String(name || 'sqlite').toLowerCase();
  const def = DRIVERS[key];
  if (!def) throw new Error(`未知数据库驱动：${name}（可选：${Object.keys(DRIVERS).join(', ')}）`);

  return {
    name: def.name,
    dialect: def.dialect,
    def,
    available: () => moduleInstalled(def.module),
    /** 将 SQLite 语法 SQL 翻译为本文档方言 */
    translate: (sql) => sqlDialect.translate(sql, def.dialect),
    /**
     * 打开连接。
     * @param {object} opts
     *   - sqlite: { path, readonly=false }
     *   - dm/kingbase: { host, port, user, password, database }
     */
    connect(opts = {}) {
      if (!moduleInstalled(def.module)) {
        throw new Error(
          `数据库驱动「${def.label}」未安装（缺少依赖 ${def.module}）。` +
          `请先 npm i ${def.module}，或改用默认 SQLite（AGENT_DB_DRIVER=sqlite）。`
        );
      }
      const Driver = require(def.module);
      if (def.name === 'sqlite') {
        return new Driver(opts.path || ':memory:', { readonly: !!opts.readonly, fileMustExist: !!opts.readonly });
      }
      if (def.name === 'kingbase') {
        // pg: 返回 Pool；连接参数直传
        const { Pool } = Driver;
        return new Pool({ host: opts.host, port: opts.port || 54321, user: opts.user, password: opts.password, database: opts.database });
      }
      // dm：官方驱动连接参数（userid/password/connectString）
      return Driver.getConnection ? Driver.getConnection(opts) : new Driver(opts);
    },
  };
}

module.exports = { DRIVERS, listDrivers, isAvailable, createDriver, moduleInstalled };
