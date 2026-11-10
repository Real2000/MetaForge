/** 演示环境一键就绪脚本（B3 交付物料 2026-11-10）
 *  用法：
 *    node scripts/seed-demo.js           # 检查并补齐演示数据（幂等），输出就绪报告
 *    node scripts/seed-demo.js --fresh   # 清空数据目录（之后启动服务将自动重建全套种子数据）
 *
 *  设计说明：db.js 在「库为空首次启动」时已自动种子全套演示数据（用户/智能体/知识库/供应商/会话历史）。
 *  本脚本的职责是：①任何时点（含被用过的库）都可执行的演示就绪检查；②演示资产被删后按需补齐最小集；
 *  ③输出 10 分钟演示路径与登录凭据指引，供售前/演示场景直接照做。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'platform.db');

const FRESH = process.argv.includes('--fresh');

// ---------- --fresh：清空数据目录，交给下次启动的自动种子 ----------
if (FRESH) {
  if (fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true });
    console.log('[seed-demo] ✅ data/ 已清空——下次启动服务（npm start / 双击启动平台.command）将自动重建全套演示种子数据');
  } else {
    console.log('[seed-demo] data/ 不存在，无需清空');
  }
  process.exit(0);
}

// ---------- 常规：就绪检查 + 缺失补齐 ----------
if (!fs.existsSync(DB_FILE)) {
  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  数据库尚未初始化                            │');
  console.log('└──────────────────────────────────────────────┘');
  console.log('演示数据会在服务首次启动时自动创建。请先启动服务：');
  console.log('  macOS     ：双击项目根目录「启动平台.command」');
  console.log('  命令行    ：npm start');
  console.log('  Docker    ：docker compose up -d');
  console.log('启动后再次运行本脚本即可获得演示就绪报告。');
  process.exit(0);
}

const { db, hashPwd, now, daysAgo } = require('../src-server/db');

const issues = [];   // 未就绪项（阻断演示的）
const warns = [];    // 提示项（不阻断但建议处理）

// ---- 1. 演示账号 ----
const users = db.prepare('SELECT username, role, status, must_change_pwd FROM users').all();
if (users.length === 0) {
  issues.push('用户表为空（异常：种子未执行或被清空）——运行 node scripts/seed-demo.js --fresh 后重启服务');
} else {
  const admin = users.find(u => u.username === 'admin' && u.role === 'admin');
  if (!admin) warns.push('admin 管理员账号不存在（可能被改名/删除）——演示前请确认有可登录的管理员');
}

// ---- 2. 演示智能体（published 且覆盖多类型）----
const pubAgents = db.prepare("SELECT id, name, type FROM agents WHERE status='published' AND source='self'").all();
const typeCover = new Set(pubAgents.map(a => a.type));
if (pubAgents.length < 5 || !typeCover.has('enterprise') || !typeCover.has('digital')) {
  // 补齐最小演示集（幂等：同名跳过）
  const demoAgents = [
    ['公司制度问答助手', '解答考勤、报销、请假等公司制度问题', 'enterprise', '工作',
      '你是公司制度问答助手。请严格根据知识库内容回答员工关于考勤、报销、请假等制度问题；知识库没有的内容请如实告知无法回答，不要编造。回答保持简洁、分点。'],
    ['智能翻译助手', '中英互译的专业翻译', 'enterprise', '通用',
      '你是一位专业、精准的翻译助手。将用户输入的中文翻译成英文，或英文翻译成中文。译文需准确传达原意、表达自然流畅。只输出译文本身。'],
    ['周报生成器', '根据工作要点生成工作周报', 'digital', '办公',
      '你是周报生成器。用户输入本周工作要点后，你输出结构化周报，包含「本周完成、数据成果、问题与风险、下周计划」四部分。'],
  ];
  let added = 0;
  for (const [name, desc, type, cat, prompt] of demoAgents) {
    if (!db.prepare('SELECT 1 FROM agents WHERE name=?').get(name)) {
      db.prepare(`INSERT INTO agents (name,description,type,space_id,category,prompt,model,temperature,context_rounds,max_reply,opening,opening_questions,kb_id,status,source,source_name,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(name, desc, type, null, cat, prompt, 'qwen-plus', 0.5, 10, 2048,
          `您好，我是${name}，请问有什么可以帮您？`, '[]', null, 'published', 'self', '', now(), now());
      added++;
    }
  }
  if (added) console.log(`[seed-demo] 已补齐 ${added} 个演示智能体`);
}

// ---- 3. 演示知识库与内容 ----
const kbs = db.prepare('SELECT COUNT(*) c FROM kbs').get().c;
const chunks = db.prepare('SELECT COUNT(*) c FROM kb_chunks').get().c;
if (kbs === 0 || chunks === 0) {
  const info = db.prepare("INSERT INTO kbs (name,description,enabled,owner,created_at) VALUES ('演示知识库','演示用制度与产品资料',1,'admin',?)").run(now());
  const f = db.prepare("INSERT INTO kb_files (kb_id,name,size,status,chunk_count,created_at) VALUES (?,?,?,?,?,?)")
    .run(info.lastInsertRowid, '演示资料.txt', 1024, 'success', 2, now());
  const ins = db.prepare('INSERT INTO kb_chunks (file_id,kb_id,content) VALUES (?,?,?)');
  ins.run(f.lastInsertRowid, info.lastInsertRowid, '智能体平台提供前台与管理后台两部分：前台含首页对话、智能体、知识库、任务管理模块。');
  ins.run(f.lastInsertRowid, info.lastInsertRowid, '知识库支持文件上传、分片解析与召回测试，可在对话中作为检索增强上下文使用。');
  console.log('[seed-demo] 已补齐演示知识库（1 库 2 分片）');
}

// ---- 4. 会话历史（看板趋势图有数据）----
const sessions = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;
if (sessions < 5) warns.push(`会话历史仅 ${sessions} 条——数据看板趋势图会偏空；可用任意账号发起几轮对话或运行 --fresh 重建`);

// ---- 5. 模型源（演示关键项：无 Key = 模拟回复）----
const prov = db.prepare('SELECT name, api_key, configured FROM providers').all();
const withKey = prov.filter(p => p.api_key && p.api_key.length > 0 && p.configured === 1).length;
if (withKey === 0) {
  warns.push('模型供应商均未配置 API Key——对话将以「模拟回复」模式运行（功能链路完整，内容为占位回复）。演示效果建议至少为一家供应商填入真实 Key：后台 → 模型接入 → 编辑 → 填 API Key');
}

// ---------- 汇总报告 ----------
console.log('');
console.log('════════════ 演示环境就绪报告 ════════════');
console.log(`  用户账号    : ${users.length} 个（${users.map(u => u.username).slice(0, 6).join('、')}${users.length > 6 ? '…' : ''}）`);
console.log(`  已发布智能体: ${pubAgents.length} 个（企业 ${[...typeCover].filter(t => t === 'enterprise').length ? '✓' : '✗'} / 数字员工 ${typeCover.has('digital') ? '✓' : '✗'}）`);
console.log(`  知识库      : ${kbs} 个 / ${chunks} 条内容分片`);
console.log(`  会话历史    : ${sessions} 条（供看板趋势图）`);
console.log(`  模型供应商  : ${prov.length} 家，其中已配 Key ${withKey} 家`);
console.log('');

if (issues.length) {
  console.log('❌ 存在阻断项：');
  issues.forEach(s => console.log('  - ' + s));
  process.exit(1);
}
if (warns.length) {
  console.log('⚠️ 提示项（不阻断演示）：');
  warns.forEach(s => console.log('  - ' + s));
  console.log('');
}

console.log('✅ 演示环境就绪');
console.log('');
console.log('──────── 10 分钟演示路径 ────────');
console.log('  登录：admin / admin123（首次登录会强制改密，演示机改完一次即可长期使用）');
console.log('  ① 首页对话（2min）：顶部选择模型直接对话；未配 Key 时为模拟回复，链路演示同样完整');
console.log('  ② 智能体矩阵（2min）：前台「智能体」→ 企业智能体/数字员工/部门AI助理/其他四分类 → 点「公司制度问答助手」提「年假有多少天？」');
console.log(' ③ 知识库（2min）：前台「知识库」→ 打开演示知识库 → 召回测试输入「考勤」验证检索');
console.log('  ④ 管理后台（2min）：数据看板趋势图 → 智能体管理（发布/编排入口）→ 模型接入');
console.log('  ⑤ 加分项（2min）：任务管理定时任务 / 我的设备桌面场景模板 / 广场与技能市场');
console.log('────────────────────────────────');
db.close && db.close();
process.exit(0);
