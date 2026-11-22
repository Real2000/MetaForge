/**
 * MT-01/MT-02 租户域表清单（权威来源：docs/tenant-scope.md §3.1）。
 * 独立成模块（不依赖 db），供 migrate.js 与 scripts/tenant-audit.js 共同引用，
 * 避免探针脚本因载入 migrate → db 而误触生产库。
 */
'use strict';

const TENANT_TABLES = [
  // 账号 / 组织
  'users', 'spaces', 'departments',
  // 智能体与协作
  'agents', 'agent_acls', 'agent_memories', 'agent_prompt_versions', 'agent_publish_history',
  'agent_reviews', 'agent_api_keys', 'agent_experience',
  'collab_rooms', 'collab_room_invites', 'collab_room_members', 'collab_room_messages',
  'collab_room_tasks', 'collab_ai_participants',
  // 知识库 / 检索
  'kbs', 'kb_files', 'kb_chunks', 'recall_eval_results', 'external_sources', 'entities', 'entity_relations',
  // 对话 / 运行
  'sessions', 'messages', 'chat_traces', 'checkpoints', 'orchestration_runs',
  'workflow_runs', 'workflow_templates', 'wf_files',
  // 任务 / 项目 / 资产
  'tasks', 'task_runs', 'projects', 'assets', 'asset_exports', 'shots', 'model3d_tasks', 'dh_assessments',
  // 内建数据库 / 代码
  'app_tables', 'app_table_rows', 'code_repos', 'code_index', 'code_patches', 'code_patch_backups',
  // 计费用量 / 运营
  'usage_records', 'op_logs', 'billing_holds', 'invoices', 'evaluations', 'eval_baselines',
  // 通知 / 反馈 / 收藏
  'notifications', 'notification_reads', 'feedbacks', 'favorites', 'tool_approvals',
  // 凭据 / 密钥 / 用户级配置
  'secrets', 'mcp_tokens', 'mcp_credentials', 'user_providers', 'user_tool_keys',
  'user_sso_identities', 'user_channel_bindings', 'skill_assets', 'skill_runs', 'skill_secrets',
  // 渠道 / 端侧 / 集成
  'channels', 'channel_messages', 'channel_bound_chats', 'dingtalk_events', 'platforms',
  'localbridge_devices', 'localbridge_tasks', 'localbridge_backups', 'remote_hosts', 'browser_automations',
  // 文件 / 市场（租户侧）
  'file_catalog', 'file_revisions', 'market_favorites', 'market_orders',
  // 销售 / 邀请 / 分享 / A2A
  'enterprise_leads', 'invite_registrations', 'invited_users', 'share_sessions', 'a2a_tasks', 'a2a_api_keys',
  // 沙箱（另有 TEXT tenant 维度，MT-02 统一归一到 tenant_id）
  'sandbox_runs', 'sandbox_pools',
];

module.exports = { TENANT_TABLES };
