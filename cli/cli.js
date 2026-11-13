#!/usr/bin/env node

/**
 * P2-21 CLI 管理命令（2026-11-13）
 *
 * 平台管理命令行接口，支持用户/智能体/备份/配置/知识库等管理操作。
 *
 * 用法：
 *   node cli/cli.js --help
 *   node cli/cli.js user list
 *   node cli/cli.js backup run
 *   node cli/cli.js config list
 */
const path = require('path');
const fs = require('fs');
const { Command } = require('commander');

const program = new Command();
process.env.AGENT_DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, '..', 'data');
const { db, now } = require('../src-server/db');
const config = require('../src-server/lib/config');

program
  .name('cli')
  .description('智能体开发平台 CLI 管理工具')
  .version('p5.37');

/* ========== 用户管理 ========== */

const userCmd = program.command('user').description('用户管理');

userCmd.command('list')
  .description('列出所有用户')
  .action(() => {
    const rows = db.prepare('SELECT id, username, nickname, role, dept, email, status, plan, created_at FROM users ORDER BY id').all();
    console.table(rows);
  });

userCmd.command('get <username>')
  .description('查看用户详情')
  .action((username) => {
    const row = db.prepare('SELECT id, username, nickname, role, dept, email, status, plan, quota_total, quota_used, created_at FROM users WHERE username=?').get(username);
    if (!row) { console.error('用户不存在'); process.exit(1); }
    console.log(JSON.stringify(row, null, 2));
  });

userCmd.command('create')
  .description('创建用户')
  .requiredOption('-u, --username <name>', '用户名')
  .option('-p, --password <pwd>', '密码（默认随机生成）')
  .option('-r, --role <role>', '角色（admin/user，默认 user）')
  .option('-n, --nickname <name>', '昵称')
  .option('-d, --dept <dept>', '部门')
  .action((opts) => {
    const pwd = opts.password || crypto.randomBytes(8).toString('hex');
    const hash = require('../src-server/lib/crypto-util').hashPwd(pwd);
    try {
      db.prepare('INSERT INTO users (username,password,nickname,role,dept,status,created_at) VALUES (?,?,?,?,?,1,?)')
        .run(opts.username, hash, opts.nickname || opts.username, opts.role || 'user', opts.dept || '', now());
      console.log(`用户 ${opts.username} 创建成功${opts.password ? '' : '，密码：' + pwd}`);
    } catch (e) {
      if (e.message.includes('UNIQUE')) { console.error('用户名已存在'); process.exit(1); }
      throw e;
    }
  });

userCmd.command('disable <username>')
  .description('禁用用户')
  .action((username) => {
    db.prepare('UPDATE users SET status=0 WHERE username=?').run(username);
    console.log(`用户 ${username} 已禁用`);
  });

userCmd.command('enable <username>')
  .description('启用用户')
  .action((username) => {
    db.prepare('UPDATE users SET status=1 WHERE username=?').run(username);
    console.log(`用户 ${username} 已启用`);
  });

userCmd.command('set-admin <username>')
  .description('设为管理员')
  .action((username) => {
    db.prepare("UPDATE users SET role='admin' WHERE username=?").run(username);
    console.log(`用户 ${username} 已设为管理员`);
  });

/* ========== 部门管理 ========== */

const deptCmd = program.command('dept').description('部门管理');

deptCmd.command('list')
  .description('列出所有部门')
  .action(() => {
    const rows = db.prepare('SELECT * FROM departments ORDER BY id').all();
    console.table(rows);
  });

deptCmd.command('create <name>')
  .description('创建部门')
  .option('-p, --parent <id>', '父部门 ID')
  .option('-d, --description <text>', '描述')
  .action((name, opts) => {
    db.prepare('INSERT INTO departments (name,parent_id,description,created_at) VALUES (?,?,?,?)')
      .run(name, opts.parent ? +opts.parent : null, opts.description || '', now());
    console.log(`部门 ${name} 已创建`);
  });

/* ========== 智能体管理 ========== */

const agentCmd = program.command('agent').description('智能体管理');

agentCmd.command('list')
  .description('列出智能体')
  .option('-s, --status <status>', '按状态筛选')
  .action((opts) => {
    let sql = 'SELECT id, name, type, category, model, status, owner, created_at FROM agents WHERE 1=1';
    const args = [];
    if (opts.status) { sql += ' AND status=?'; args.push(opts.status); }
    sql += ' ORDER BY id DESC';
    const rows = db.prepare(sql).all(...args);
    console.table(rows);
  });

agentCmd.command('export <id>')
  .description('导出智能体为 JSON')
  .option('-f, --file <path>', '导出路径', `agent-export-${Date.now()}.json`)
  .action((id, opts) => {
    const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(+id);
    if (!agent) { console.error('智能体不存在'); process.exit(1); }
    // 去敏感字段
    const clean = { ...agent };
    delete clean.api_key;
    delete clean.secrets;
    fs.writeFileSync(opts.file, JSON.stringify(clean, null, 2));
    console.log(`智能体 ${agent.name} 已导出到 ${opts.file}`);
  });

agentCmd.command('import <file>')
  .description('从 JSON 导入智能体')
  .action((file) => {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // 确保必要字段
    const info = db.prepare(`INSERT INTO agents (name,description,type,space_id,category,prompt,model,temperature,context_rounds,max_reply,opening,opening_questions,kb_id,status,source,tools,long_memory,allow_user_model,suggest_enabled,variables,child_ids,routing_mode,owner,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'imported','import','[]',1,1,0,'[]','[]','function',?,?,?)`).run(
      data.name, data.description || '', data.type || 'chat', data.space_id || 0,
      data.category || '未分类', data.prompt || '', data.model || '', data.temperature || 0.7,
      data.context_rounds || 10, data.max_reply || 1024, data.opening || '', data.opening_questions || '[]', data.kb_id || 0,
      data.owner || 'admin', now(), now());
    console.log(`智能体已从 ${file} 导入，ID: ${info.lastInsertRowid}`);
  });

/* ========== 配置管理 ========== */

const configCmd = program.command('config').description('配置管理');

configCmd.command('list')
  .description('列出所有可配置项')
  .action(() => {
    const items = config.exportConfigs({ role: 'admin' });
    console.table(items.map(i => ({ key: i.key, value: i.value, label: i.label, group: i.group })));
  });

configCmd.command('get <key>')
  .description('查看配置项')
  .action((key) => {
    const items = config.exportConfigs({ role: 'admin' });
    const item = items.find(i => i.key === key);
    if (!item) { console.error('配置项不存在'); process.exit(1); }
    console.log(JSON.stringify(item, null, 2));
  });

configCmd.command('set <key> <value>')
  .description('更新配置项')
  .action((key, value) => {
    try {
      const old = config.getAll().get(key);
      const coerced = config.set(key, value);
      db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
        .run('cli', '更新配置', `config.${key}: ${JSON.stringify(old)} → ${JSON.stringify(coerced)}`, '127.0.0.1', now());
      console.log(`配置 ${key} = ${JSON.stringify(coerced)}（原：${JSON.stringify(old)}）`);
    } catch (e) {
      console.error('配置更新失败：', e.message);
      process.exit(1);
    }
  });

/* ========== 备份 ========== */

const backupCmd = program.command('backup').description('备份管理');

backupCmd.command('run')
  .description('执行数据库备份')
  .action(() => {
    const { dailyBackup } = require('../src-server/lib/ops');
    const r = dailyBackup();
    console.log(r.ok ? `✅ 备份完成：${r.msg}` : `❌ 备份失败：${r.msg}`);
  });

backupCmd.command('list')
  .description('列出备份文件')
  .action(() => {
    const dir = path.join(process.env.AGENT_DATA_DIR || path.join(__dirname, '..', 'data'), 'backups');
    if (!fs.existsSync(dir)) { console.log('暂无备份'); return; }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort().reverse();
    const list = files.map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, size: (st.size / 1048576).toFixed(2) + ' MB', mtime: st.mtime };
    });
    console.table(list);
  });

/* ========== 知识库 ========== */

const kbCmd = program.command('knowledge').description('知识库管理');

kbCmd.command('list')
  .description('列出知识库')
  .action(() => {
    const rows = db.prepare('SELECT id, name, description, enabled, owner, created_at FROM kbs ORDER BY id').all();
    console.table(rows);
  });

/* ========== 一次性任务 ========== */

const taskCmd = program.command('task').description('定时任务管理');

taskCmd.command('list')
  .description('列出定时任务')
  .action(() => {
    const rows = db.prepare('SELECT id, name, cron, status, enabled, username, created_at FROM tasks ORDER BY id').all();
    console.table(rows);
  });

/* ========== 统计 ========== */

program.command('stats')
  .description('系统统计概览')
  .action(() => {
    const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const agents = db.prepare("SELECT COUNT(*) c FROM agents WHERE status='published'").get().c;
    const rooms = db.prepare("SELECT COUNT(*) c FROM collab_rooms WHERE status='active'").get()?.c || 0;
    const kbs = db.prepare('SELECT COUNT(*) c FROM kbs').get().c;
    const files = db.prepare('SELECT COUNT(*) c FROM file_catalog').get()?.c || 0;
    const tasks = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
    console.log(JSON.stringify({ users, agents, rooms, kbs, files, tasks }, null, 2));
  });

/* ========== 启动 ========== */

program.parse();