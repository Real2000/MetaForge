/** 接入管理：第三方智能体平台（Coze / Dify / 自定义）配置与同步
 * Dify 真纳管：配置控制台账号密码后，「同步」真实拉取应用清单并为每个应用
 * 获取 Service API Key，落库为智能体（agents.external_app_id 去重），对话时真实转发。
 * Coze 真纳管：配置个人访问令牌 PAT 后，「同步」真实遍历工作空间拉取 Bot 清单，
 * 落库为智能体（external_mode='chat'），对话经 /v3/chat 转发（Bot 需在扣子侧发布为 API 渠道）。
 */
const express = require('express');
const { db, now } = require('../db');
const { auth, adminOnly } = require('../lib/auth');
const dify = require('../lib/dify');
const coze = require('../lib/coze');

const router = express.Router();
router.use(auth, adminOnly);

/** 搭建页地址默认推导：coze → 官方开发空间；dify → 国内可达的官方中文站（自部署则填自己的 /apps） */
const DEFAULT_BUILD_URLS = {
  coze: 'https://www.coze.cn/space',
  dify: 'https://dify.ai/zh',
};

function resolveBuildUrl(type, endpoint, buildUrl) {
  if (buildUrl && buildUrl.trim()) return buildUrl.trim();
  if (DEFAULT_BUILD_URLS[type]) return DEFAULT_BUILD_URLS[type];
  if (type === 'dify') {
    const base = (endpoint || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    return base ? base + '/apps' : '';
  }
  return '';
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM platforms ORDER BY id DESC').all();
  // 控制台密码不下发明文，只回传是否已配置；agent_count 为真同步落库的外部智能体数
  const safe = rows.map(p => {
    const { console_password, ...rest } = p;
    rest.console_pwd_set = console_password ? 1 : 0;
    rest.agent_count = db.prepare("SELECT COUNT(*) c FROM agents WHERE source=? AND source_name=? AND external_app_id IS NOT NULL AND external_app_id!=''").get(p.type, p.name).c;
    return rest;
  });
  res.json({ code: 0, data: safe });
});

router.post('/', (req, res) => {
  const { name, type, endpoint, token, build_url, console_email, console_password } = req.body || {};
  if (!name?.trim() || !endpoint?.trim()) return res.json({ code: 400, msg: '请填写名称与服务地址' });
  const finalType = type || 'coze';
  const finalBuild = resolveBuildUrl(finalType, endpoint, build_url);
  const info = db.prepare(`INSERT INTO platforms (name,type,endpoint,token,build_url,console_email,console_password,status,synced,created_at)
    VALUES (?,?,?,?,?,?,?,1,0,datetime('now','localtime'))`)
    .run(name.trim(), finalType, endpoint.trim(), token || '', finalBuild, console_email || '', console_password || '');
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '新建平台接入', name.trim(), req.ip, now());
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

router.put('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM platforms WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '接入配置不存在' });
  const { name, type, endpoint, token, status, build_url, console_email, console_password } = req.body || {};
  const finalType = type || old.type;
  const finalEndpoint = endpoint || old.endpoint;
  const finalBuild = resolveBuildUrl(finalType, finalEndpoint, build_url ?? old.build_url);
  const finalEmail = console_email !== undefined ? console_email : old.console_email;
  const finalPwd = console_password !== undefined ? (console_password === '' ? '' : console_password) : old.console_password;
  db.prepare('UPDATE platforms SET name=?,type=?,endpoint=?,token=?,build_url=?,console_email=?,console_password=?,status=? WHERE id=?')
    .run(name || old.name, finalType, finalEndpoint, token ?? old.token, finalBuild, finalEmail, finalPwd, status ?? old.status, old.id);
  res.json({ code: 0, msg: '已保存' });
});

router.delete('/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM platforms WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM platforms WHERE id=?').run(req.params.id);
  if (old) db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)').run(req.user.username, '删除平台接入', old.name, req.ip, now());
  res.json({ code: 0, msg: '已删除' });
});

// 测试连接：Coze 用 PAT 调 /v1/workspaces 真实验证；其他类型校验地址连通性
router.post('/:id/test', async (req, res) => {
  const old = db.prepare('SELECT * FROM platforms WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '接入配置不存在' });
  if (old.type === 'coze') {
    if (!old.token?.startsWith('pat_')) {
      return res.json({ code: 0, data: { ok: false, msg: '未配置个人访问令牌（PAT）。请到扣子「API 管理 → 个人访问令牌」创建（勾选团队空间管理/Bot 管理/对话权限），粘贴到配置的令牌输入框' } });
    }
    try {
      const spaces = await coze.listWorkspaces(old.token);
      return res.json({ code: 0, data: { ok: true, msg: `PAT 验证通过，可访问 ${spaces.length} 个工作空间：${spaces.map(s => s.name || s.id).join('、')}` } });
    } catch (e) {
      return res.json({ code: 0, data: { ok: false, msg: 'PAT 验证失败：' + e.message } });
    }
  }
  let ok = false, msg = '';
  try {
    const r = await fetch(old.endpoint, { signal: AbortSignal.timeout(6000) });
    ok = r.status < 500;
    msg = ok ? `连接成功（HTTP ${r.status}）` : `服务异常（HTTP ${r.status}）`;
  } catch (e) {
    ok = false;
    msg = `无法连通（${e.message}）— 已保存配置，可在网络可达后重试`;
  }
  res.json({ code: 0, data: { ok, msg } });
});

// 前往外部平台搭建（校验地址 → 记录跳转日志 → 返回搭建页地址由前端 window.open 打开）
router.post('/:id/jump', async (req, res) => {
  const old = db.prepare('SELECT * FROM platforms WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '接入配置不存在' });
  const url = resolveBuildUrl(old.type, old.endpoint, old.build_url);
  if (!url) return res.json({ code: 400, msg: '未配置搭建页地址，请先在接入管理中填写' });
  // 拦截演示占位/保留域名（localhost 是合法的本机自部署地址，放行）
  let host = '';
  try { host = new URL(url).hostname; } catch { return res.json({ code: 400, msg: '搭建页地址格式不合法：' + url }); }
  if (/(^|\.)example\.(com|org|net)$|\.invalid$|\.test$|^your-dify\./i.test(host)) {
    return res.json({
      code: 400,
      msg: `「${old.name}」的搭建页地址 ${url} 是演示占位地址，不可访问。请点击「配置」填写真实地址（${old.type === 'dify' ? '官方中文站为 https://dify.ai/zh（自部署 Dify 填 http://你的域名/apps；海外云端版 cloud.dify.ai 需代理访问）' : '扣子官方为 https://www.coze.cn/space，私有化部署填自己的域名'}）`,
    });
  }
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '前往外部平台搭建', `${old.name} → ${url}`, req.ip, now());
  res.json({ code: 0, data: { url } });
});

// 同步智能体：
// - Dify 且已配置控制台账号密码 → 真同步（拉应用清单 + 获取 Service Key + 落库）
// - Coze 且已配置 PAT → 真同步（遍历工作空间拉 Bot 清单 + 落库 + 清理历史占位记录）
// - 其他情况保留占位同步
router.post('/:id/sync', async (req, res) => {
  const old = db.prepare('SELECT * FROM platforms WHERE id=?').get(req.params.id);
  if (!old) return res.json({ code: 404, msg: '接入配置不存在' });
  const t = now();

  // ---------- Dify 真同步 ----------
  if (old.type === 'dify' && old.console_email && old.console_password) {
    try {
      const session = await dify.consoleLogin(old.endpoint, old.console_email, old.console_password);
      const apps = await dify.listApps(old.endpoint, session);
      // chat 系模式可用 chat-messages 对话；completion 单轮；workflow 仅同步展示
      const CHAT_MODES = ['chat', 'agent-chat', 'advanced-chat'];
      const CMP_MODES = ['completion'];
      let added = 0, updated = 0, skipped = 0;
      for (const app of apps) {
        const exist = db.prepare('SELECT * FROM agents WHERE source=? AND external_app_id=?').get('dify', app.id);
        let serviceKey = '';
        let mode = '';
        if (CHAT_MODES.includes(app.mode)) {
          mode = 'chat';
          serviceKey = await dify.ensureAppApiKey(old.endpoint, session, app.id);
        } else if (CMP_MODES.includes(app.mode)) {
          mode = 'completion';
          serviceKey = await dify.ensureAppApiKey(old.endpoint, session, app.id);
        } else {
          mode = app.mode || '';
          skipped++;
        }
        const desc = (app.description || '').trim() ||
          (mode === 'chat' ? 'Dify 对话型应用（经接入管理同步）' : mode === 'completion' ? 'Dify 文本生成应用（经接入管理同步）' : `Dify ${mode} 应用（暂不支持对话转发）`);
        if (exist) {
          db.prepare(`UPDATE agents SET name=?,description=?,external_api_key=?,external_mode=?,status=?,source_name=?,updated_at=? WHERE id=?`)
            .run(app.name, desc, serviceKey, mode, 'published', old.name, t, exist.id);
          updated++;
        } else {
          db.prepare(`INSERT INTO agents (name,description,type,space_id,category,prompt,model,temperature,context_rounds,max_reply,opening,opening_questions,kb_id,status,source,source_name,external_app_id,external_api_key,external_mode,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(app.name, desc, 'enterprise', 1, '工作', `【外部 Dify 应用】${app.name}`, 'dify-app', 0.7, 10, 2048,
              `您好，我是「${app.name}」（Dify 搭建），请问有什么可以帮您？`, '[]', null, 'published', 'dify', old.name, app.id, serviceKey, mode, t, t);
          added++;
        }
      }
      db.prepare('UPDATE platforms SET synced=synced+1, last_sync_at=? WHERE id=?').run(t, old.id);
      db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
        .run(req.user.username, '同步平台智能体', `${old.name}：真同步完成（新增 ${added}、更新 ${updated}${skipped ? '、暂不支持对话 ' + skipped : ''}）`, req.ip, t);
      return res.json({
        code: 0,
        data: { added, updated, skipped, total: apps.length, real: true, msg: `真实同步完成：共 ${apps.length} 个应用，新增 ${added}、更新 ${updated}${skipped ? `、${skipped} 个工作流类型仅同步展示` : ''}` },
      });
    } catch (e) {
      db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('platform-sync', `Dify 真同步失败（${old.name}）：${e.message}`, t);
      return res.json({ code: 502, msg: 'Dify 真同步失败：' + e.message });
    }
  }

  // ---------- Coze 真同步 ----------
  if (old.type === 'coze' && old.token?.startsWith('pat_')) {
    try {
      const { spaces: spaceInfo, bots } = await coze.listAllBots(old.token);
      let added = 0, updated = 0;
      for (const b of bots) {
        const botId = b.bot_id || b.bot_id_str || b.id;
        if (!botId) continue;
        const exist = db.prepare('SELECT * FROM agents WHERE source=? AND external_app_id=?').get('coze', String(botId));
        const name = b.name || `Coze Bot ${botId}`;
        const desc = (b.description || '').trim() || `扣子智能体（空间：${b.workspace_name || b.workspace_id}，经接入管理同步）`;
        if (exist) {
          db.prepare(`UPDATE agents SET name=?,description=?,external_mode=?,status=?,source_name=?,updated_at=? WHERE id=?`)
            .run(name, desc, 'chat', 'published', old.name, t, exist.id);
          updated++;
        } else {
          db.prepare(`INSERT INTO agents (name,description,type,space_id,category,prompt,model,temperature,context_rounds,max_reply,opening,opening_questions,kb_id,status,source,source_name,external_app_id,external_api_key,external_mode,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(name, desc, 'enterprise', 1, '工作', `【外部扣子智能体】${name}`, 'coze-bot', 0.7, 10, 2048,
              `您好，我是「${name}」（扣子搭建），请问有什么可以帮您？`, '[]', null, 'published', 'coze', old.name, String(botId), old.token, 'chat', t, t);
          added++;
        }
      }
      // 清理历史占位记录（无 external_app_id 的 Coze 智能体）
      const cleaned = db.prepare(`DELETE FROM agents WHERE source='coze' AND (external_app_id IS NULL OR external_app_id='')`).run().changes;
      db.prepare('UPDATE platforms SET synced=synced+1, last_sync_at=? WHERE id=?').run(t, old.id);
      db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
        .run(req.user.username, '同步平台智能体', `${old.name}：Coze 真同步完成（空间 ${spaceInfo.length} 个、Bot ${bots.length} 个：新增 ${added}、更新 ${updated}${cleaned ? `、清理占位 ${cleaned}` : ''}）`, req.ip, t);
      let tip = '';
      if (!bots.length) {
        tip = '。当前工作空间内没有「智能体(Bot)」类型的资源——扣子新版「项目/AI 应用」暂不在开放 API 同步范围内，请在扣子以「智能体」类型新建后再同步；或确认 PAT 勾选了「团队空间管理(listBot)」权限';
      }
      return res.json({
        code: 0,
        data: { added, updated, cleaned, total: bots.length, real: true, msg: `真实同步完成：${spaceInfo.length} 个工作空间共 ${bots.length} 个智能体，新增 ${added}、更新 ${updated}${cleaned ? `、清理占位记录 ${cleaned} 条` : ''}${tip}` },
      });
    } catch (e) {
      db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('platform-sync', `Coze 真同步失败（${old.name}）：${e.message}`, t);
      return res.json({ code: 502, msg: 'Coze 真同步失败：' + e.message });
    }
  }

  // ---------- 占位同步（未配置凭据） ----------
  db.prepare('UPDATE platforms SET synced=synced+1, last_sync_at=? WHERE id=?').run(t, old.id);
  db.prepare('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)')
    .run(req.user.username, '同步平台智能体', `${old.name}：占位同步`, req.ip, t);
  const hint = old.type === 'dify'
    ? '未配置控制台账号密码，执行了占位同步。请在编辑中填写 Dify 控制台邮箱与密码后重新同步'
    : '未配置扣子个人访问令牌（PAT），执行了占位同步。请到扣子「API 管理 → 个人访问令牌」创建 PAT（勾选团队空间管理/Bot 管理/对话权限），粘贴到配置的令牌输入框后重新同步';
  res.json({ code: 0, data: { added: 1, real: false, msg: hint } });
});

module.exports = router;
