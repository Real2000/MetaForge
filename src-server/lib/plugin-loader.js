/**
 * U2-3 插件运行时加载器（2026-11-16）
 *
 * 职责：
 *   1. 从 plugins 表加载已启用插件，动态注册到 TOOL_DEFS。
 *   2. 提供卸载插件的接口（从 TOOL_DEFS 移除）。
 *   3. 生命周期钩子（install/uninstall/enable/disable 时自动调用）。
 *
 * 与现有工具系统的集成：
 *   - TOOL_DEFS（lib/tools.js）支持动态扩展（extras 与 market 同款等号赋值）。
 *   - runTool 通过 TOOL_DEFS[name] 查找工具定义并执行。
 *   - 插件工具与内置工具无差别对待——智能体勾选后在对话/画布中自然生效。
 *
 * 注册时机：
 *   - 服务启动时：require 本模块自动触发 start_time 第一次加载。
 *   - 运行时：install / enable / update 后手动调用 loadPlugin(id) / unloadPlugin(id)。
 */
const { db, now } = require('../db');

// 插件注册表：{ pluginId -> { schema, run } }
// 注意：TOOL_DEFS 在 tools.js 中为 const，但对其属性赋值是允许的（TOOL_DEFS['mcp_get_x'] 模式同款）
const PLUGIN_REGISTRY = new Map();

/** 从 plugins 表加载所有已启用的插件，注册到 TOOL_DEFS。启动时调用一次。 */
function loadAll() {
  const plugins = db.prepare("SELECT * FROM plugins WHERE enabled=1").all();
  for (const p of plugins) {
    loadPlugin(p);
  }
  if (plugins.length) {
    console.log(`[plugin-loader] 已加载 ${plugins.length} 个已启用插件`);
  }
  return plugins.length;
}

/**
 * 读取单个插件并注册到 TOOL_DEFS。
 * @param {number|object} pluginOrId — 插件 ID 数字或插件行对象
 * @returns {boolean} 是否加载成功
 */
function loadPlugin(pluginOrId) {
  const p = typeof pluginOrId === 'object' ? pluginOrId : db.prepare('SELECT * FROM plugins WHERE id=?').get(pluginOrId);
  if (!p) return false;
  if (!p.enabled) return false;
  try {
    const pluginId = p.plugin_id;
    // 构建工具定义（与 TOOL_DEFS 结构一致：schema + run）
    const toolDef = {
      schema: {
        type: 'function',
        function: {
          name: pluginId,
          description: `${p.name}（插件 v${p.version}，${p.author || '官方'}）${p.description ? '——' + p.description : ''}`,
          parameters: {
            type: 'object',
            properties: (() => {
              try { return JSON.parse(p.settings_schema || '{}'); } catch { return {}; }
            })(),
          },
        },
      },
      run: async (args, ctx) => {
        // 插件的入口文件或 URL（通过沙箱执行）
        try {
          const { runIsolated } = require('./sandbox');
          const result = await runIsolated({
            code: p.entry,
            args,
            timeoutMs: 30000,
            runtime: p.runtime || 'node',
          });
          return String(result.stdout || result.output || '插件执行完成，无返回');
        } catch (e) {
          return `插件执行失败：${e.message}`;
        }
      },
    };
    // 注册到 TOOL_DEFS（动态赋值，与 tools.js 中 extras/market 同款模式）
    const { TOOL_DEFS } = require('./tools');
    TOOL_DEFS[pluginId] = toolDef;
    PLUGIN_REGISTRY.set(pluginId, p.id);
    return true;
  } catch (e) {
    console.error(`[plugin-loader] 插件「${p.plugin_id}」加载失败：`, e.message);
    db.prepare('INSERT INTO err_logs (source,message,created_at) VALUES (?,?,?)').run('plugin-loader', `插件「${p.plugin_id}」加载失败：${e.message}`, now());
    return false;
  }
}

/**
 * 从 TOOL_DEFS 卸载插件。
 * @param {number|string} pluginIdOrId — 插件 ID 数字或 plugin_id 字符串
 */
function unloadPlugin(pluginIdOrId) {
  const pid = typeof pluginIdOrId === 'number'
    ? (db.prepare('SELECT plugin_id FROM plugins WHERE id=?').get(pluginIdOrId)?.plugin_id)
    : pluginIdOrId;
  if (!pid) return;
  const { TOOL_DEFS } = require('./tools');
  delete TOOL_DEFS[pid];
  PLUGIN_REGISTRY.delete(pid);
}

// 启动时自动加载
loadAll();

module.exports = { loadAll, loadPlugin, unloadPlugin, PLUGIN_REGISTRY };
