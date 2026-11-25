# XC-1 · kingbase V9R1C10 实测差异清单（2026-11-25，第十轮）

> 验收对照（V1.1 计划表 XC-1）：**kingbase 容器全链启动通过 ✅；MT-7 验收三点复跑全绿 ✅；差异清单归档（本文档）✅**。
> 实测结论：**生产代码零适配**——db.js 全链（119 表 + 140 迁移 + RLS 89 表全量）、MT-7 三点、
> tenant-e2e 全量 29 用例对 kingbase 一次通过，sql-dialect 的 kingbase 方言分支设计直接兑现。

## 一、实测环境与拓扑

| 项 | 值 |
|---|---|
| 镜像 | `kingbase_v009r001c010b0004_single_x86:v1`（官网 Docker tar，730MB） |
| 版本 | **KingbaseES V009R001C010，server_version = 12.1（PG12 系协议）** |
| 容器 | `kingbase-xc1`（`--privileged=true`，端口 54321，DB_MODE=pg 兼容模式，不挂卷用完即删） |
| 驱动 | node `pg`（与 postgres:16 生产轨道同一驱动、同一桥） |
| 测试库 | `xc1_kingbase_e2e`（owner=mt7_app 非超户——RLS 验收语义前提） |

## 二、验收三点复跑记录

| 验收点 | 结果 |
|---|---|
| ① 全链启动（建表 119 → 迁移 140 → RLS 全量）+ 核心资源读写 | ✅ lastInsertRowid 契约通过，agents 读写通路 OK |
| ② FORCE RLS 双租户互不可见 | ✅ 各租户上下文仅见本租户行 |
| ③ 两进程并发写（MVCC） | ✅ 各 20 条并发 INSERT 全部成功，无 SQLITE_BUSY |
| 超额：tenant-e2e 全量 | ✅ **29/29**（跨租户隔离/密钥分层/支付对账/停用租户等复杂语义原样通过） |
| RLS 行为八项探针 | ✅ 8/8（见 §四-3） |

## 三、差异清单（XC-1 核心交付）

1. **server_version = 12.1（PG12 系）**——生产 postgres:16 轨道为 PG16。pg-bridge / node pg 驱动
   对两代协议全兼容（参数化/JSONB/RETURNING/advisory_lock/set_config/information_schema 六项探测全过）；
   **RETURNING 四态**（INSERT/UPDATE/DELETE × 参数化/简单协议）全部正常回行（pg-bridge 的
   lastInsertRowid 契约依赖项）。
2. **public schema 归属差异（轨道 reset 适配点）**：kingbase/PG12 系中 public schema 的 owner 为
   超户（system），库 owner 无权 `DROP SCHEMA public`——`must be owner of schema public`；
   PG16 中 public 归 pg_database_owner（库主可自行冷启动重建）。**适配**：kingbase 轨道 schema
   冷启动由管理端执行 `CREATE SCHEMA public AUTHORIZATION mt7_app`（`.temp/xc1-kb-reset.js`，
   生产 pg-track-reset.js 无需改动——它面向 PG16 轨道）。
3. **RLS 语义完全一致**（八项探针全绿）：`ENABLE + FORCE ROW LEVEL SECURITY` 双开关、
   USING/WITH CHECK 双子句、`SET LOCAL app.tenant_id` 事务级注入、`current_setting(..., true)`
   缺省回退 '0'、'platform' 逃逸通道、本租户写放行/跨租户写拦截、事务结束复位、
   superuser bypass——与生产 pg-rls.js 同款策略模板逐项一致。
   ⚠️ 探针踩坑记录（过程资产）：`FORCE` 不隐含 `ENABLE`，漏 ENABLE 则 RLS 完全不生效
   （读写全穿透）——该教训与 PG16 的 PG-1 踩坑（NULLIF 三参解析炸整块）同属「策略 SQL
   解析失败被非致命 catch 吞掉」防线，生产 pg-rls.js 的 ENABLE+FORCE 双语句形态经双端实测锚定。
4. **COUNT 等 int8 结果经 node pg 返回字符串**（'1' 而非 1）——PG 系通病（PG16 同样），非 kingbase
   特有；生产代码已在 PG 轨道兼容（严格数值比较处已转换）。
5. **DROP USER 依赖严格性**：存在对象依赖（GRANT 等）时报 `cannot be dropped because some objects
   depend on it`，且**不允许删除有在线会话的角色**（PG16 为同路径但会话语义略宽）。运维清理
   顺序：断开 app 连接 → `DROP OWNED BY <role>` → `DROP USER <role>`。
6. **容器特权要求**：官方镜像 entrypoint 以 sudo 做 mkdir/chown（PAM 会话初始化），
   无 `--privileged=true` 时 `pam_open_session: Permission denied` 循环失败——部署文档注意项
   （与 postgres 官方镜像的普通权限模式不同）。
7. **默认端口/用户**：54321（非 PG 5432）、默认库 `kingbase`、默认超户 `system`；DB_MODE 支持
   oracle/pg/mysql/sqlserver 四兼容模式——**XC-1 实测选定 pg 模式**（MetaForge PG 桥同协议）。
8. **方言翻译实测兑现**：140 步迁移 + 119 表 DDL 全量经 sql-dialect kingbase 分支
   （AUTOINCREMENT→SERIAL、datetime('now')→timestamp 系、INSERT OR IGNORE→ON CONFLICT 等）
   **零告警零适配通过**——lint:dialect 登记表「kingbase 原生兼容」的设计假设经全链实测成立。

## 四、部署接线约定（信创上线包采纳）

- 驱动复用 `pg`（AGENT_DB_DRIVER=pg + PG_CONN 指 54321）；db.js 的 DB_DIALECT 自动映射
  kingbase 方言翻译，零配置改动；
- 建库三步（管理端）：CREATE USER mt7_app → CREATE DATABASE xxx OWNER mt7_app →
  `CREATE SCHEMA public AUTHORIZATION mt7_app`（差异 #2 适配）；
- RLS 全量应用由 db.js 启动路径自动执行（与 PG16 同路径）；
- 演练资产：`.temp/xc1-rls-probe.js`（RLS 八项探针）/ `.temp/xc1-kb-reset.js`（轨道复位），
  容器 `kingbase-xc1` 用完即删（数据最小化）。

> AI生成
