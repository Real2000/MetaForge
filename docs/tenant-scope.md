# 租户域 / 平台共享 表级分类清单（MT-01）

> 依据：《开发计划表 v1.1 · 决策落地版》D-1（租户边界模型）与 M1 里程碑 MT-01。
> 落地范围：本清单是 MT-02（租户模型落地，扩围）的**唯一权威范围**；MT-02 只对本文件标记为 **TENANT** 的表加 `tenant_id`。
> 版本：2026-11-22 · M1 / MT-01。

## 1. 边界模型（D-1 回顾）

- 客户 = 独立**租户**（`tenants` 一等实体）；资源通过 `tenant_id` 建立**硬边界**。
- 现有 `spaces` 降级为「租户内协作分组」（软分组），**不再作为租户边界**。
- 三层正交判定，任一不满足即拒绝（fail-closed）：**租户(硬边界) / 空间(软分组) / owner**。
- 平台超管（`role='admin'` 且平台级）可跨租户，但**旁路必须强制审计**。

## 2. 分类原则

| 分类 | 含义 | 处理 |
| --- | --- | --- |
| **TENANT** | 租户域：内容归属某个客户，客户间必须强隔离 | MT-02 加 `tenant_id INTEGER DEFAULT 1`，存量回填 `1` |
| **SHARED** | 平台共享：平台级目录 / 基础设施 / 安全台账，全租户共有或平台运营专用 | 不加 `tenant_id`（或仅平台可见） |
| **INFRA** | 框架/调度基础设施（迁移、锁、队列） | 不加 `tenant_id`，不参与租户过滤 |

> 判定口径：**「同一份数据是否可能同时属于两个不同客户」**——是 → TENANT；否 → SHARED/INFRA。
> 混合表（如 `mcp_servers`）先归 SHARED，后续按需加 `workspace` 维度细分。

## 3. 分类清单（共 113 张业务表 + 框架表）

### 3.1 TENANT（租户域，MT-02 加 tenant_id）

**账号 / 组织**
`users` `spaces` `departments`

**智能体与协作**
`agents` `agent_acls` `agent_memories` `agent_prompt_versions` `agent_publish_history` `agent_reviews` `agent_api_keys` `agent_experience`
`collab_rooms` `collab_room_invites` `collab_room_members` `collab_room_messages` `collab_room_tasks` `collab_ai_participants`

**知识库 / 检索**
`kbs` `kb_files` `kb_chunks` `recall_eval_results` `external_sources` `entities` `entity_relations`

**对话 / 运行**
`sessions` `messages` `chat_traces` `checkpoints` `orchestration_runs` `workflow_runs` `workflow_templates` `wf_files`

**任务 / 项目 / 资产**
`tasks` `task_runs` `projects` `assets` `asset_exports` `shots` `model3d_tasks` `dh_assessments`

**内建数据库 / 代码**
`app_tables` `app_table_rows` `code_repos` `code_index` `code_patches` `code_patch_backups`

**计费用量 / 运营**
`usage_records` `op_logs` `billing_holds` `invoices` `evaluations` `eval_baselines`

**通知 / 反馈 / 收藏**
`notifications` `notification_reads` `feedbacks` `favorites` `tool_approvals`

**凭据 / 密钥 / 用户级配置**
`secrets` `mcp_tokens` `mcp_credentials` `user_providers` `user_tool_keys` `user_sso_identities` `user_channel_bindings`
`skill_assets` `skill_runs` `skill_secrets`

**渠道 / 端侧 / 集成**
`channels` `channel_messages` `channel_bound_chats` `dingtalk_events` `platforms`
`localbridge_devices` `localbridge_tasks` `localbridge_backups` `remote_hosts` `browser_automations`

**文件 / 市场（租户侧）**
`file_catalog` `file_revisions` `market_favorites` `market_orders`

**销售 / 邀请 / 分享 / A2A**
`enterprise_leads` `invite_registrations` `invited_users` `share_sessions` `a2a_tasks` `a2a_api_keys`

**沙箱（已用 `tenant` TEXT 列，D3-3）**
`sandbox_runs` `sandbox_pools` —— 已有文本 `tenant` 维度，MT-02 统一归一化为整数 `tenant_id`（见 §4.3）。

### 3.2 SHARED（平台共享，不加 tenant_id）

**模型 / 能力目录**
`providers` `model_capabilities` `voice_providers`

**资产目录 / 市场（供给侧）**
`expert_catalog` `market_hubs` `plugins` `sub_agent_library` `market_products` `mcp_servers`

**系统字典 / 合规**
`words` `word_categories` `chat_whitelist`

**平台认证 / 单点登录基础设施**
`sso_providers` `sso_login_states` `connector_oauth_states`

**安全台账（平台级）**
`security_events` `login_attempts` `token_blacklist` `err_logs`

**客户端分发 / 遥测**
`bridge_releases` `bridge_updates` `bridge_crashes`

### 3.3 INFRA（框架基础设施，不加 tenant_id）

`_migrations` `cluster_locks` `task_queue`

## 4. 配套约定

### 4.1 默认租户

- 新建 `tenants(id, name, status, plan, parent_tenant_id, created_at)`，种子写入 **默认租户 `id=1`（name='默认租户'，status='active'，plan='enterprise'）**。
- 全部 TENANT 表 `tenant_id` 默认值 = `1`；存量行回填 `1`。
- 单租户（私有化）部署下所有数据恒为 `tenant_id=1`，**业务行为与现状一致**（回归承诺）。

### 4.2 租户上下文解析来源（MT-03 实现）

解析优先级（自上而下，命中即用）：

1. **JWT claim `tenant_id`**（登录态签发时写入，最高可信）
2. **子域 / 请求头**：`X-Tenant-Id` Header 或 `Host` 首段子域（多租户 SaaS 入口）
3. **拒绝**：以上均缺失 → **403**（fail-closed；平台超管除外）

约束：

- 解析失败时，**除平台超管外一律拒绝**，禁止回退到默认租户以免越权。
- 平台超管（`role='admin'` 且平台级）旁路时**强制写审计**（`op_logs` / `security_events`）。
- 中间件必须置于**全部业务路由之前**（`server.js` 路由挂载前），解析结果挂载为 `req.tenant = { id, name, ... }` 供业务层读取。

### 4.3 命名归一化

- `spaces.owner` 及资源 `owner` 字段统一为 **username**（现网种子/历史数据存在昵称混用），MT-02 迁移中执行「昵称 → username」归一化，避免按 owner 过滤失效导致 fail-open。
- 沙箱 `sandbox_runs.tenant` / `sandbox_pools.tenant`（TEXT）归一化为整数 `tenant_id`。

### 4.4 MT-02 回填范围汇总（执行清单）

仅对 §3.1 中列出的 TENANT 表执行：`ALTER TABLE <t> ADD COLUMN tenant_id INTEGER DEFAULT 1` + `UPDATE <t> SET tenant_id=1 WHERE tenant_id IS NULL`；SHARED / INFRA 表不动。

## 5. 验收对照（MT-01 → MT-02）

- [ ] 本清单经评审，TENANT / SHARED / INFRA 三类无歧义、无遗漏；
- [ ] MT-02 回填范围严格取自 §3.1；
- [ ] 迁移后 `npm test` 全绿；所有 TENANT 表 `tenant_id` 存在且存量=1。

> AI生成
