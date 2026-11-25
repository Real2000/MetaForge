# SW-1 切换前置复检报告（V1.2 · M10）

> 任务：M10 SW-1「切换前置复检」（P0）——D-5 停机直切前的全要素实跑复检
> 日期：2026-11-25（周四）　执行环境：macOS 生产机（生产 3210 全程在线零扰动）
> 上游：`docs/PG切换runbook.md`（S1~S7 + 回滚预案）　下游：SW-2 切换窗口 2026-11-28（周六）22:00

## 一、结论

**SW-1 全项通过**：以生产 `VACUUM INTO` 快照（.temp/sw1/platform.db，2.9MB / 2929 行 / 124 表）
完成对账复跑、切换全流程演练（含回退实测）、备份与热回退核验、观测自动化工具交付四项验收。
实跑抓出 **5 个真实窗口风险**（其中 2 个为合成数据演练不可能覆盖、切换夜必炸的数据形态问题），
全部当场修复并以 smoke 守卫锚定。SW-2 前置条件全部就位。

## 二、复检清单与结果

| 项 | 内容 | 结果 |
|---|---|---|
| ① 对账复跑 | 生产快照建演练库（metaforge_sw1，OWNER mt7_app）→ S4 建链 → S5 全量搬运对账 | **124 表 / 2929 行 diff=0（3.7s）**；S4 建链 145/145 迁移 + RLS 68 表 FORCE + 序列对齐 120 表；八表锚点双侧全等（users 8 / tenants 1 / agents 38 / sessions 92 / messages 309 / kb_chunks 68 / workflow_runs 62 / op_logs 1369） |
| ② 全流程演练含回退 | PG 模式带数据起服 3299 → health OK + RLS 三态抽查（基线 0 / 租户 999999=0 / 租户 1=38）+ 序列健康（last=max+1）；回退演练 sqlite 模式起服 | **health OK；RLS/序列全绿；回退热重启 1s**（runbook 10s 口径成立）。隔离目录首启 75s 为当日 ops 补跑（备份补跑已证实日志在案）+ 冷加载一次性成本；切换夜回退目标为生产 data 目录（当日任务已跑过，热形态），30min 窗口富余极大 |
| ③ 备份与热回退 | sqlite 轨每日备份产物核验（保留 30 份 ≥ 7 天热回退要求）；S2 快照演练（integrity ok）；PG 轨 dailyBackupPg 端到端 | sqlite 轨：platform-2026-11-25.db（00:12）就位；**PG 轨在 S7 真实起服上下文自动跑通**（容器探测→pg_dump -U postgres -Fc→落盘→保留策略），产物 pg_restore --list 可读（125 TABLE DATA）；演练备份全部落在隔离目录，生产 data/backups 39 文件零扰动 |
| ④ 观测自动化 | SW-2 窗口验收工具 | `scripts/sw-verify.js` 交付（`npm run sw-verify`）：health（10 次重试）/ 双侧计数锚点（核心七表严格相等 + op_logs 漂移容忍）/ RLS 三态 / 序列健康，一条命令 + 退出码；E2E 实测全绿（先抓出自身计数缺租户上下文的 bug 并修复） |

## 三、发现与修复（5 项，均已代码化 + smoke 守卫锚定）

| # | 发现 | 影响（若切换夜踩中） | 处置 |
|---|---|---|---|
| 1 | `mt7-poc-pg` 容器 Exited(255) 且 restart=no——今日 13:24 用户重启 Docker Desktop（为 kingbase 实测）后未随起；上一轮误认另一栈的 `docker-db_postgres-1`（healthy 但无宿主机端口映射）为平台 PG | S4/S5/备份全部连接被拒（pg-bridge AggregateError 即此根因） | 拉起容器 + `docker update --restart unless-stopped` 加固；**这是 D-9 窗口的单点发现：不加固则 Docker Desktop 任何重启都会静默带走生产 PG** |
| 2 | 生产库含 sqlite-vec 虚表组 `vec_kb_1_*`（5 张）——合成数据四轮演练未覆盖，migrate-to-pg fail-fast 卡死 | S5 直接中断，窗口内手工排障 | `collectVec0Group` 识别（sql 含 USING vec0 + 四族影子后缀，宁漏勿误）自动跳过；smoke 运行时守卫 |
| 3 | kb_chunks.embedding 三态混存（53 行 `H:` 前缀 JSON + 6 行裸 JSON + 9 行 float32 BLOB）——#144「生产向量未启用、embedding 全 NULL」假设已被 M8 评测/摄取工作过时化 | 文本按原始字节直转 bytea → 切换后**全量向量静默失效**（decodeVec 长度校验 fail-closed），检索退化纯文本通道且无告警 | `toEmbeddingBlob` 列级转换钩子（插入与对账同钩子防自欺）：文本→AI-02 float32 BLOB、BLOB 直通、不可解析 fail-fast；与 retriever.decodeVec 闭环 smoke 守卫锁格式同步 |
| 4 | dailyBackupPg 容器自动探测用 `/5432/` 宽匹配——同宿主机多栈并存时未映射端口的复合栈 postgres（`5432/tcp`）同样命中，docker ps 顺序不定可能选错容器 | 切换后每日 PG 备份失败（或更糟） | 收窄为 `/5432->/`（仅发布映射命中）+ runbook S6 增加 `AGENT_PG_CONTAINER=mt7-poc-pg` 显式配置双保险 |
| 5 | sw-verify 初版计数不带租户上下文——租户内容表（agents/sessions/messages/kb_chunks/workflow_runs）RLS 基线 fail-closed 恒数 0 | 验收工具切换夜给出全量假失败 | E2E 实测抓回；计数前置探针租户上下文；smoke 静态守卫锚定该口径 |

## 四、切换夜（SW-2，11-28 22:00）配置与执行要点

1. **S6 db.env 增配**（runbook 已更新）：`AGENT_PG_CONTAINER=mt7-poc-pg` 显式指定，免自动探测；
2. **S7 验收改一条命令**：`BASE_URL=http://localhost:3210 PG_CONN=<目标串> SW_SQLITE=<S2快照> npm run sw-verify`（可反复重跑，全部只读）；手工锚点命令保留为兜底；
3. **S5 预期输出形态**：应见「跳过 sqlite-vec 虚表组 5 张」与 kb_chunks 68 行 diff=0——若出现「目标库缺表」含 vec_ 前缀即回退检查点；
4. **回退 RTO 口径**：热形态实测 1s；若回退发生在当日 ops 任务补跑前，首启可能多耗 ~1 分钟（当日备份等一次性补跑），30min 窗口内可忽略；
5. **演练库处置**：metaforge_sw1 与 .temp/sw1/（含快照/密钥副本/pg_dump）**保留至 SW-2 验收通过后删除**（含生产数据副本，切换后按数据最小化原则清理）。

## 五、测试证据

- 三门禁：lint:sql / lint:schema / lint:dialect 全绿；
- smoke 新增 2 组守卫（vec0 识别 + embedding 转换闭环；sw-verify 锚点口径 + 租户上下文前置）；
- 全量回归（2026-11-25）：sqlite smoke **721/0**（719 基线 + 2 条 SW-1 新守卫）+ tenant-e2e **26/0**
  + PG 轨道 **29/29**（npm test 与 test:tenant:pg 串行全绿，退出码 0）。

> AI生成
