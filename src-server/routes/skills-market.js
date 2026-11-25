/** 技能/模版市场（V2.2 #7 2026-10-31；P3-2 融合 2026-11-06）：分散资产的统一聚合运营位
 *  对标 Dify 插件市场 / Coze Skills 商店——内置工具 / 技能资产（含 CRUD 融合）/ 工作流模版 / MCP 工具 / 异构纳管应用五区一页：
 *  - GET    /api/skills-market               本地四区聚合（内置工具 + 三区）+ 统计（V2.3 F5：不再拉外部平台，立即返回保市场首屏速度；登录即可浏览）
 *  - GET    /api/skills-market/platforms     异构应用清单独立端点（V2.3 F5+Y4：多平台并行拉取 + 10 分钟缓存 best-effort；
 *                                          F5 动机：外部平台故障/超时不拖慢市场首屏，前端异步加载填充「异构应用」tab）
 *  - GET    /api/skills-market/favorites     我的收藏列表（join 回资产详情，已下架资产标 available:false）
 *  - POST   /api/skills-market/favorites     收藏（UNIQUE 幂等：重复收藏返回成功）
 *  - DELETE /api/skills-market/favorites     取消收藏
 *  - POST   /api/skills-market/clone         一键克隆：skill_asset/wf_template → 新智能体草稿；mcp_tool/platform 不支持
 *  归属/权限：市场浏览全员（router.use(auth)）；克隆/收藏为写操作走登录用户身份；
 *  克隆另挂 requireFeature('agents') 部署级版本闸门（V2.2 审查加固 F3：与 POST /api/agents 写入口同口径，
 *  community 起即含 agents 特性，不误伤基础功能——闸门意义在于未来收敛免费档位时无需再改市场路由）。
 *  注意：市场收藏走 market_favorites 表（username/item_type/item_id），与智能体收藏 favorites 表是两套，互不影响。
 *  P3-2 融合（2026-11-06）：原独立「技能」页（#/skills，front/skills.js）CRUD 融合到市场页技能资产 tab；
 *  builtin_tools 区从 TOOL_DEFS 动态生成（单一事实来源，排除 AGENT_TOOL_DENY 违禁工具）——
 *  前端不再硬编码工具清单（旧 TOOL_META 仅 4 项已过时），含 P3-2 新增 11 个工具。
 */
const express = require('express');
const dal = require('../lib/dal'); // BE-C1 统一查询出口（方言翻译，租户收敛见 tenantWhere）
const { db, now } = require('../db');
const { auth } = require('../lib/auth');
const { TOOL_DEFS, AGENT_TOOL_DENY, toolRiskOf } = require('../lib/tools');
const { KEYED_TOOL_META } = require('../lib/tools-market');
const { validateWorkflowV2 } = require('../lib/workflow-schema');
const { buildUpsert } = require('../lib/upsert'); // XC-2 跨方言 upsert（sqlite/kingbase/dm MERGE）
const dify = require('../lib/dify');
const coze = require('../lib/coze');
const { requireFeature } = require('../lib/edition');
const skillPkg = require('../lib/skill-package'); // D1-4：技能可执行标记（manifest 规范化/风险/权限摘要）

const router = express.Router();
router.use(auth);

/** 收藏品类型白名单（platforms 不可收藏——外部资产无本地稳定主键） */
const FAV_TYPES = ['wf_template', 'skill_asset', 'mcp_tool'];

/* ---------------- 异构应用清单缓存（模块级 Map + 时间戳，TTL 10 分钟） ----------------
 * 外部平台 API 慢且可能故障，市场页每次刷新都直调不可接受；
 * 成功与失败结果都缓存（失败缓存防反复打故障平台拖慢市场页），TTL 过后自动重试。
 * V2.3 审查加固（S1-1）：缓存 Promise 而非结果（single-flight 单飞）——缓存过期后的首个慢请求在途期间，
 * 后续并发请求共享同一个在途 Promise 而非各自再起一整批外呼；否则认证用户高频刷 /platforms 可在
 * 外呼窗口（dify 10-15s / coze 分钟级翻页）内按 RPS×窗口×N平台 放大外呼，击穿「失败缓存防打故障平台」的设计意图。 */
const PLATFORM_TTL_MS = 10 * 60 * 1000;
const platformCache = new Map(); // platform_id → { ts, promise }（缓存拉取 Promise，单飞共享）

/** 单个接入平台 best-effort 拉取应用清单（try-catch 静默，异常返回 error 标记不抛出） */
async function fetchPlatformApps(p) {
  const apps = [];
  if (p.type === 'dify') {
    if (!p.console_email || !p.console_password) throw new Error('未配置控制台账号密码');
    const session = await dify.consoleLogin(p.endpoint, p.console_email, p.console_password);
    const list = await dify.listApps(p.endpoint, session);
    for (const app of list) apps.push({ platform_type: 'dify', platform_name: p.name, app_id: String(app.id), app_name: app.name || '', app_desc: app.description || '', mode: app.mode || '' });
  } else if (p.type === 'coze') {
    if (!p.token || !String(p.token).startsWith('pat_')) throw new Error('未配置个人访问令牌（PAT）');
    const { bots } = await coze.listAllBots(p.token); // 内部遍历工作空间调 listBots
    for (const b of bots) apps.push({ platform_type: 'coze', platform_name: p.name, app_id: String(b.bot_id || b.bot_id_str || b.id || ''), app_name: b.name || '', app_desc: b.description || '', mode: 'chat' });
  } else {
    throw new Error(`暂不支持的平台类型：${p.type}`);
  }
  return apps;
}

/** 带缓存读取（single-flight：命中未过期/TTL 内在途均共享同一 Promise，cached=true 供前端/测试验证未触发外部调用） */
function loadPlatformApps(p) {
  const hit = platformCache.get(p.id);
  if (hit && Date.now() - hit.ts < PLATFORM_TTL_MS) {
    // 返回新对象不污染缓存内共享结果；TTL 内（含在途未完成）一律 cached=true——本次未触发新的外部调用
    return hit.promise.then(r => ({ ...r, cached: true }));
  }
  const promise = (async () => {
    let apps = [], error = '';
    try { apps = await fetchPlatformApps(p); } catch (e) { error = e.message; }
    return { apps, error, cached: false };
  })();
  platformCache.set(p.id, { ts: Date.now(), promise }); // 在途即入缓存：并发请求按位命中同一 Promise（单飞）
  return promise;
}

/** 解析 MCP 工具级生效风险（P5.34 口径：人工标注 risk_overrides 优先 → 工具启发式 risk → 'auto' 回落） */
function mcpToolRisk(overrides, tool) {
  const name = tool.originalName || tool.name;
  const ov = overrides[name];
  if (ov === 'low' || ov === 'high' || ov === 'middle') return ov;
  return tool.risk || 'auto';
}

/* ---------------- 三区聚合 ---------------- */
router.get('/', async (req, res) => {
  const me = req.user.username;
  const favSet = new Set(dal.q('SELECT item_type, item_id FROM market_favorites WHERE username=?', [me])
    .map(f => `${f.item_type}:${f.item_id}`));

  // 零区：内置工具（P3-2 融合 2026-11-06）——从 TOOL_DEFS 动态生成（单一事实来源），
  // 排除 AGENT_TOOL_DENY 违禁工具（create_task/local_exec 不进市场）；keyed=key可配标记 +
  // key_configured=当前用户已配置（user_tool_keys join）；risk 用 toolRiskOf 统一口径；
  // params 拆必填/可选两个数组供卡片展示（技能挂载表单与市场卡片共用本结构）
  const myKeyed = new Set(dal.q('SELECT tool_name FROM user_tool_keys WHERE username=? AND status=1', [me]).map(r => r.tool_name));
  const builtinTools = Object.values(TOOL_DEFS)
    .filter(t => t?.schema?.function?.name && !AGENT_TOOL_DENY.has(t.schema.function.name))
    .map(t => {
      const f = t.schema.function;
      const props = f.parameters?.properties || {};
      const required = f.parameters?.required || [];
      return {
        name: f.name,
        description: f.description || '',
        params_required: required.filter(p => props[p]),
        params_optional: Object.keys(props).filter(p => !required.includes(p)),
        risk: toolRiskOf(f.name),
        keyed: !!KEYED_TOOL_META[f.name],
        key_label: KEYED_TOOL_META[f.name]?.label || '',
        key_provider: KEYED_TOOL_META[f.name]?.provider || '',
        key_configured: myKeyed.has(f.name) ? 1 : 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // 一区：工作流模版（热度优先 use_count DESC, id DESC）
  const wfTemplates = dal.q(`SELECT id,slug,name,icon,category,description,scene,use_count,builtin
    FROM workflow_templates ORDER BY use_count DESC, id DESC`)
    .map(t => ({ ...t, favorited: favSet.has(`wf_template:${t.id}`) }));

  // 二区：技能资产（我的全部 + 他人已发布——与 /api/skillassets 可见性口径一致，私有技能不进市场）
  // P3-2 融合：附 mine 标记 + 全字段（prompt/tools/status）——市场页技能资产 tab 现在承担 CRUD（原独立技能页），
  // 列表需渲染详情/编辑/删除/发布开关；私有技能仅 owner 本人可见（原 /api/skillassets 语义不变，这里多带字段）
  const skillAssets = dal.q('SELECT id,name,description,icon,owner,status,prompt,tools,manifest,runtime,version,verified,created_at FROM skill_assets WHERE owner=? OR status=1 ORDER BY id DESC', [me])
    .map(s => {
      let tools = [];
      try { tools = JSON.parse(s.tools || '[]'); } catch { }
      // D1-4：可执行技能标记（供市场卡片渲染「可执行 v版本/风险」徽章与运行/密钥入口）
      const manifest = skillPkg.normalizeManifest(s.manifest);
      return {
        id: s.id, name: s.name, description: s.description, icon: s.icon,
        owner: s.owner, status: s.status, prompt: s.prompt, tools,
        version: s.version, verified: s.verified,
        executable: skillPkg.isExecutable(manifest),
        perm_risk: skillPkg.permRisk(manifest),
        permissions: skillPkg.summarizePermissions(manifest),
        secret_names: manifest.secrets || [],
        created_at: s.created_at,
        owned_by_me: s.owner === me, mine: s.owner === me,
        favorited: favSet.has(`skill_asset:${s.id}`),
      };
    });

  // 三区：MCP 工具（tools_cache 展开每工具一行；停用服务跳过；item_id = server_id:tool_name 供收藏定位）
  const mcpTools = [];
  for (const s of dal.q('SELECT id,name,tools_cache,risk_overrides,trusted,status FROM mcp_servers WHERE status=1 ORDER BY id DESC')) {
    let tools = [], overrides = {};
    try { tools = JSON.parse(s.tools_cache || '[]'); } catch { }
    try { overrides = JSON.parse(s.risk_overrides || '{}') || {}; } catch { overrides = {}; }
    for (const t of tools) {
      const toolName = t.originalName || t.name;
      if (!toolName) continue;
      mcpTools.push({
        id: `${s.id}:${toolName}`,
        server_id: s.id, server_name: s.name, tool_name: toolName,
        description: t.description || '',
        risk: mcpToolRisk(overrides, t),
        server_trusted: s.trusted ? 1 : 0,
        favorited: favSet.has(`mcp_tool:${s.id}:${toolName}`),
      });
    }
  }

  // V2.3 F5：异构应用拉取已移出本端点（原四区同请求聚合时，外部平台慢/故障会拖住整个市场页首屏）——
  // 主端点只聚合本地四区立即返回，异构清单改由 GET /platforms 独立端点承担、前端异步加载
  res.json({
    code: 0,
    data: {
      builtin_tools: builtinTools,
      wf_templates: wfTemplates,
      skill_assets: skillAssets,
      mcp_tools: mcpTools,
      stats: {
        total: builtinTools.length + wfTemplates.length + skillAssets.length + mcpTools.length, // 四区条数之和（异构清单独立端点另行返回，不并入 total）
        my_favorites: favSet.size,
      },
    },
  });
});

/* ---------------- 异构应用独立端点（V2.3 F5 / Y4 2026-10-31） ---------------- */
// F5 动机：外部平台慢/故障时不拖慢市场首屏——主端点立即返回本地三区，本端点由前端异步请求填充「异构应用」tab；
// Y4 动机：原串行 for-await 下 N 个平台 × 各自网络超时会线性叠加拖慢市场页，改 Promise.all 并行后总耗时 ≈ 最慢单个平台；
// 并行安全依据：loadPlatformApps 内部 try-catch 静默吞错、永不 reject（见上），故 Promise.all 不会因单平台失败短路抛错，无需 allSettled；
// 语义与原聚合段完全一致：10 分钟缓存（成功与失败都缓存）/ allCached 统计 / platform_errors 收集 / err_logs 记录；
// platforms 表通常个位数，直接全量并行，无需并发上限。
router.get('/platforms', async (req, res) => {
  const platforms = [];
  const platformErrors = [];
  let allCached = true;
  const rows = dal.q('SELECT * FROM platforms');
  // Promise.all 结果顺序与 rows 一一对应（按位映射回原平台行），platforms 拼接顺序与原串行版一致，输出确定性不变
  const results = await Promise.all(rows.map(p => loadPlatformApps(p)));
  results.forEach((r, i) => {
    const p = rows[i];
    if (!r.cached) allCached = false;
    platforms.push(...r.apps);
    if (r.error) {
      platformErrors.push({ platform_id: p.id, platform_name: p.name, platform_type: p.type, message: r.error }); // 响应观测标记：缓存命中也返回（前端需知道清单为空的原因）
      // V2.3 审查加固（S2-1）：仅真实发生外呼且失败才记 err_logs（原实现缓存命中也写库，
      // 认证用户高频刷本端点可按 R×N 行/秒持续 10 分钟刷出日志洪泛，90 天保留期内磁盘膨胀）
      if (!r.cached) {
        try { dal.runq('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)', ['skills-market', `异构应用拉取失败（${p.name}）：${r.error}`, now()]); } catch { }
      }
    }
  });
  res.json({
    code: 0,
    data: {
      platforms,
      platform_errors: platformErrors,   // best-effort 观测标记（前端不阻塞渲染）
      platforms_cached: allCached,       // 调试字段：true=本次未触发任何外部调用（缓存命中）
    },
  });
});

/* ---------------- 收藏 ---------------- */

/** 查收藏条目的资产当前详情（join 回详情；不可见/已删除返回 available:false） */
function favItemDetail(itemType, itemId, username) {
  if (itemType === 'wf_template') {
    const t = dal.getq('SELECT id,slug,name,icon,category,description,scene,use_count,builtin FROM workflow_templates WHERE id=?', [+itemId]);
    return t ? { available: true, name: t.name, icon: t.icon || '🎨', description: t.description || '', extra: { category: t.category, use_count: t.use_count, builtin: t.builtin } } : { available: false, name: '', icon: '🎨', description: '', extra: {} };
  }
  if (itemType === 'skill_asset') {
    // 可见性口径同市场列表：本人资产或已发布；他人转私有的收藏条目自然变为不可见
    const s = dal.getq('SELECT id,name,description,icon,owner,status FROM skill_assets WHERE id=? AND (owner=? OR status=1)', [+itemId, username]);
    return s ? { available: true, name: s.name, icon: s.icon || '✨', description: s.description || '', extra: { owner: s.owner } } : { available: false, name: '', icon: '✨', description: '', extra: {} };
  }
  if (itemType === 'mcp_tool') {
    const [sid, ...rest] = String(itemId).split(':');
    const toolName = rest.join(':'); // 工具名本身可能含冒号，仅按第一个冒号拆分
    const s = dal.getq('SELECT id,name,tools_cache,trusted,status FROM mcp_servers WHERE id=? AND status=1', [+sid]);
    if (!s || !toolName) return { available: false, name: '', icon: '🔧', description: '', extra: {} };
    let tools = [];
    try { tools = JSON.parse(s.tools_cache || '[]'); } catch { }
    const t = tools.find(x => (x.originalName || x.name) === toolName);
    return t ? { available: true, name: toolName, icon: '🔧', description: t.description || '', extra: { server_name: s.name, server_trusted: s.trusted ? 1 : 0 } } : { available: false, name: toolName, icon: '🔧', description: '', extra: {} };
  }
  return null;
}

router.get('/favorites', (req, res) => {
  const rows = dal.q('SELECT item_type,item_id,created_at FROM market_favorites WHERE username=? ORDER BY id DESC', [req.user.username]);
  res.json({
    code: 0,
    data: rows.map(f => {
      const d = favItemDetail(f.item_type, f.item_id, req.user.username);
      return { item_type: f.item_type, item_id: f.item_id, created_at: f.created_at, ...(d || { available: false, name: '', icon: '📦', description: '', extra: {} }) };
    }),
  });
});

router.post('/favorites', (req, res) => {
  const { item_type, item_id } = req.body || {};
  const id = String(item_id ?? '');
  if (!FAV_TYPES.includes(item_type)) return res.json({ code: 400, msg: '收藏类型仅支持 wf_template / skill_asset / mcp_tool（异构应用暂不可收藏）' });
  if (!id) return res.json({ code: 400, msg: '缺少收藏对象（item_id）' });
  if (!favItemDetail(item_type, id, req.user.username)?.available) return res.json({ code: 400, msg: '收藏对象不存在或已下架' });
  // UNIQUE(username,item_type,item_id) 幂等：重复收藏 = 已收藏，返回成功
  // XC-2（2026-11-25）：INSERT OR IGNORE → 跨方言 upsert（sqlite 零变 / kingbase DO NOTHING / dm MERGE）
  dal.runq(buildUpsert({ table: 'market_favorites', keys: ['username', 'item_type', 'item_id'], columns: ['username', 'item_type', 'item_id', 'created_at'] }), [req.user.username, item_type, id, now()]);
  res.json({ code: 0, msg: '已收藏' });
});

router.delete('/favorites', (req, res) => {
  // 参数兼容 body（与 POST 对称）与 query 两种传法
  const { item_type, item_id } = req.body || {};
  const type = item_type || req.query.item_type;
  const id = String(item_id ?? req.query.item_id ?? '');
  if (!FAV_TYPES.includes(type) || !id) return res.json({ code: 400, msg: '缺少取消收藏参数（item_type / item_id）' });
  dal.runq('DELETE FROM market_favorites WHERE username=? AND item_type=? AND item_id=?', [req.user.username, type, id]);
  res.json({ code: 0, msg: '已取消收藏' });
});

/* ---------------- 一键克隆 ---------------- */

/** 防重名：技能/模版名 +「（副本）」后缀；连后缀都撞则追加序号（副本2/副本3…）。
 *  V2.2 审查加固（Y2）：先截断 base 再拼后缀——原实现查重用全名、返回前才 slice(0,50)，
 *  长名场景「查重名 ≠ 入库名」（截断后可能与他名碰撞），防重名自相矛盾；
 *  base 截 43 字预留 7 字后缀空间（最长「（副本100）」），保证查重名 = 入库名且 ≤50 */
function uniqueAgentName(base) {
  const b = String(base).slice(0, 43);
  let name = `${b}（副本）`;
  for (let i = 2; dal.getq('SELECT 1 FROM agents WHERE name=?', [name]); i++) name = `${b}（副本${i}）`;
  return name;
}

router.post('/clone', requireFeature('agents'), (req, res) => {
  const { item_type, item_id } = req.body || {};
  const id = String(item_id ?? '');

  if (item_type === 'mcp_tool' || item_type === 'platform' || item_type === 'platforms') {
    return res.json({ code: 400, msg: '该类型暂不支持克隆，请在 MCP 管理/接入管理中配置' });
  }

  // V2.3 Y3：与 POST /api/agents 共用 lib/plans.js agentQuotaBlock 统一口径
  // （免费版智能体数软约束，防市场克隆绕过配额引导；行为不变：402 + 同款 msg + upgrade_hint）
  const { agentQuotaBlock } = require('../lib/plans');
  const qb = agentQuotaBlock(req.user.username);
  if (qb.blocked) return res.json({ code: qb.code, msg: qb.msg, data: qb.data });

  if (item_type === 'skill_asset') {
    // 可见性口径同市场列表（他人私有资产不可克隆）
    const s = dal.getq('SELECT * FROM skill_assets WHERE id=? AND (owner=? OR status=1)', [+id, req.user.username]);
    if (!s) return res.json({ code: 404, msg: '技能资产不存在或已下架' });
    // 工具白名单（P5.34b 同 skillassets POST 口径：剔除违禁与未知工具）
    let toolIds = [];
    try { toolIds = JSON.parse(s.tools || '[]'); } catch { }
    toolIds = toolIds.filter(t => TOOL_DEFS[t] && !AGENT_TOOL_DENY.has(t));
    const name = uniqueAgentName(s.name);
    // 组装 POST /api/agents 同款 payload 后内部直接 db INSERT（不 HTTP 自调）——列与默认值照抄 routes/agents.js POST /
    const info = dal.runq(`INSERT INTO agents (name,description,type,space_id,category,prompt,user_prompt,model,temperature,top_p,diversity_mode,icon,context_rounds,max_reply,opening,opening_questions,kb_id,status,source,tools,mcp_servers,long_memory,allow_user_model,suggest_enabled,variables,child_ids,routing_mode,owner,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`, [name, s.description || '', 'digital', dal.getq('SELECT id FROM spaces WHERE type=? AND owner=? LIMIT 1', ['personal', req.user.username])?.id || 0, '技能', s.prompt, '', '', 0.7, 0.7, 'balanced',
        String(s.icon || '✨').slice(0, 8), 10, 1024, `您好，我是从技能市场克隆的「${s.name}」，请问有什么可以帮您？`, '[]',
        null, 'draft', 'self', JSON.stringify(toolIds), '[]', 0, 1, 1, '[]', '[]', 'function', req.user.username]);
    dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '市场克隆技能', `${name}（技能：${s.name}，工具：${toolIds.length ? toolIds.join('/') : '纯提示词'}）`, req.ip, now()]);
    return res.json({ code: 0, msg: `已克隆为「${name}」草稿——去编排页调整提示词后发布`, data: { agent_id: Number(info.lastInsertRowid), name } });
  }

  if (item_type === 'wf_template') {
    // 同构复用 routes/wf-templates.js POST /:id/create 的核心（该逻辑在 router 闭包内不可 import，照抄实现并注明出处）：
    // 读模板 workflow → validateWorkflowV2 二次校验 → 创建画布智能体草稿 → use_count+1
    const t = dal.getq('SELECT * FROM workflow_templates WHERE id=?', [+id]);
    if (!t) return res.json({ code: 404, msg: '模板不存在' });
    const v = validateWorkflowV2(t.workflow);
    if (!v || v.error) return res.json({ code: 500, msg: '模板 workflow 结构异常：' + (v ? v.error : '解析失败') });
    const name = uniqueAgentName(t.name);
    const info = dal.runq(`INSERT INTO agents (name,description,type,icon,category,model,prompt,workflow,edit_mode,routing_mode,owner,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`, [name, t.description || '', 'digital', t.icon || '🎨', t.category || '通用', '',
        `【工作流模板：${t.name}】${t.description || ''}\n\n使用说明：${t.scene || '按需调整节点参数'}`,
        JSON.stringify(v), 'canvas', 'workflow', req.user.username, 'draft']);
    dal.runq('UPDATE workflow_templates SET use_count=use_count+1 WHERE id=?', [t.id]);
    dal.runq('INSERT INTO op_logs (username,action,detail,ip,created_at) VALUES (?,?,?,?,?)', [req.user.username, '市场克隆模板', `${name}（模板：${t.name}，来源：技能市场）`, req.ip, now()]);
    return res.json({ code: 0, msg: `已从模板创建「${name}」草稿——去编排页改提示词/知识库后发布`, data: { agent_id: Number(info.lastInsertRowid), name } });
  }

  return res.json({ code: 400, msg: '克隆类型仅支持 skill_asset / wf_template' });
});

module.exports = router;
