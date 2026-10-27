/**
 * 智能体可配置工具的违禁集（P5.34/P5.34b）
 * create_task（持久化自动执行实体）与 local_exec（外设操作）不允许配置进智能体/技能——
 * 对话链路仅首页助手服务端默认集可用且有确认卡；所有写入口（agents POST/PUT/import/copy、
 * skill_assets、存量清洗）统一引用本集合。
 * 零依赖小模块：db.js 迁移与 tools.js 均可安全引用（避免 db ↔ tools 循环依赖）。
 */
const AGENT_TOOL_DENY = new Set(['create_task', 'local_exec']);

module.exports = { AGENT_TOOL_DENY };
