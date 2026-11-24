# MetaForge PostgreSQL 切换 Runbook（M6 / D-5）

> 版本：1.0（2026-11-24，PG-4）
> 决策口径（D-5 已拍板）：**停机直切 + 迁移前 sqlite 快照保留 7 天 + 切换后灰度观测**。
> 本手册全部步骤均经三轮全链演练实证（见 §6 演练记录），命令可直接复制执行。
> RTO 目标：≤30 分钟（实测回滚 2 分钟内，见 §6）。

---

## 0. 适用范围与前置条件

| 项 | 要求 |
|---|---|
| PG 实例 | PostgreSQL ≥ 13（生产基线 16；容器化部署时镜像 postgres:16-alpine 同源） |
| 数据库角色 | **必须以非超户业务角色持有库**（如 mt7_app）。超户永远绕过 RLS，FORCE 也拦不住——RLS 隔离语义成立的硬前提 |
| 磁盘 | 目标库空间 ≥ sqlite 库大小 × 3（含索引与事务余量） |
| 代码版本 | 切换目标版本必须包含 PG-1~PG-3（RLS 全量 / 桥优化 / migrate-to-pg.js） |
| 停机窗口 | 预估 = 搬运时长 + 启动观测（当前规模实测全程 <5 分钟，窗口留 30 分钟） |

**关键红线（实证踩坑，违反即失败）：**

1. `CREATE DATABASE` 必须带 `OWNER <业务角色>`；
2. 若需重建 `public` schema，**必须由业务角色执行**（或超户执行时带 `AUTHORIZATION <业务角色>`）——
   超户裸 `CREATE SCHEMA public` 会让 owner=postgres，业务角色无 CREATE 权限，服务启动报
   `no schema has been selected to create in`（演练二轮实锤）；
3. **`AGENT_DATA_DIR` 保持 `data/` 不变**——加密密钥 `data/encryption.key` 必须沿用，
   否则 secrets 等密文全部解不开；
4. schema 的唯一真相来源是 db.js 启动链（含 config.js / sso.js 惰性建表）——
   **禁止手工建表**，migrate-to-pg.js 对缺表 fail-fast 会兜底拦截。

---

## 1. 切换前检查（S0）

```bash
cd <项目根>
# 1) 服务健康、当前驱动确认（应为 sqlite）
curl -sf http://localhost:3210/api/health && echo
grep -c 'AGENT_DB_DRIVER' db.env 2>/dev/null || echo "db.env 不存在（sqlite 模式）"
# 2) PG 实例连通 + 业务角色可用
psql "<PG_CONN>" -c "SELECT current_user, current_database();"
# 3) 目标库不存在的表 = 0（若目标库曾用过，建议直接换新库名，避免残留）
```

## 2. 停机直切步骤（S1~S7）

### S1 停服务（冻结写入）

```bash
bash 停止平台.command
```

### S2 sqlite 快照（回退锚点，保留 7 天）

```bash
cp data/platform.db "data/platform.db.bak-$(date +%Y%m%d-%H%M%S)"
ls -la data/*.bak-*   # 确认快照生成
```

> WAL 模式下建议同时用 sqlite 备份 API 做一致性快照（或停服后 cp——S1 已停服，cp 即安全）。

### S3 建 PG 库（新库名）

```bash
psql "<PG_ADMIN_CONN>" -c "CREATE DATABASE metaforge OWNER mt7_app;"
```

### S4 PG 模式首启建 schema（完整启动链，随后退出）

```bash
AGENT_DB_DRIVER=pg PG_CONN='<业务角色连接串>' node -e \
  "require('./src-server/db'); require('./src-server/lib/config'); require('./src-server/lib/sso');"
```

预期日志（三段缺一不可）：
- `[migrate] 完成 N/N 项迁移`（N=当前迁移步总数）
- `[db][MT-7] RLS 已应用 68 张租户内容表（FORCE + tenant_isolation…）`
- `[db][PG-1] 写路径租户列注入已启用`

### S5 全量搬运 + 对账

```bash
PG_CONN='<业务角色连接串>' node scripts/migrate-to-pg.js
```

**验收硬指标**：末行必须为 `✅ 全表对账 diff = 0`，退出码 0。
任何 `✗` 行都表示对应表失败——修复后重跑（工具幂等，重跑=TRUNCATE 重搬，安全）。

- 搬运时长实测：2683 行 / 3 秒。线性外推：`预估秒数 ≈ 总行数 × 1.1ms / 1000`（含对账双读）；
- WARNING 类（源缺列按 NULL 填充）：旧库缺新功能列时的预期行为，不阻塞；治本走迁移步补列。

### S6 切换驱动（写 db.env）

```bash
cat > db.env <<'EOF'
AGENT_DB_DRIVER=pg
PG_CONN=postgres://<user>:<password>@<host>:5432/metaforge
EOF
```

> `db.env` 由「启动平台.command」自动加载（PG-4 起）；**密码明文落盘风险自负**——生产建议改用
> PG 侧 trust/证书或部署密钥管理后仍走 db.env 引用。db.env 加入 .gitignore（切换后确认）。

### S7 PG 模式启动 + 验收锚点

```bash
bash 启动平台.command    # 预期日志：[i] 已加载数据库配置 db.env（AGENT_DB_DRIVER=pg）
curl -sf http://localhost:3210/api/health && echo
```

**数据验收锚点（双侧计数必须一致，sqlite 快照 vs PG 库）**：

```bash
# sqlite 侧（快照）
sqlite3 data/platform.db.bak-* "SELECT COUNT(*) FROM messages; SELECT COUNT(*) FROM sessions; SELECT COUNT(*) FROM users;"
# PG 侧
psql "<PG_CONN>" -At -c "SET app.tenant_id='platform'; SELECT COUNT(*) FROM messages; SELECT COUNT(*) FROM sessions; SELECT COUNT(*) FROM users;"
```

> 计数抽样覆盖：users / tenants / agents / sessions / messages / kb_chunks / workflow_runs。
> 注意 PG 侧查询租户内容表必须 `SET app.tenant_id='platform'`（FORCE RLS 生效，见 §5）。

---

## 3. 切换后观测（首 24 小时）

| 观测项 | 方式 | 预期 |
|---|---|---|
| 健康检查 | `curl :3210/api/health` 每 5 分钟 | 恒 200 |
| 错误日志 | `tail -f logs/server.log` | 无 pg-bridge 超时/RLS 报错 |
| 登录链路 | 平台超管 + 普通用户各登录一次 | 均成功 |
| 会话写入 | 发起一次对话 | messages 落库、token 正常 |
| 租户隔离抽查 | 租户 A 建智能体，租户 B 列表不可见 | RLS 隔离成立 |
| 自增健康 | 连续创建两条记录 | 无 `duplicate key`（序列对齐生效） |
| 性能 | `node .temp/bench-bridge.js`（或在测试库跑） | withTenant P95 < 1.5ms |

**已知降级（切换后生效，均为登记项）：**

- 全文检索 FTS5 影子表不迁（PG 方言建表跳过）——BM25 走内存通道（retriever 方言判定），召回结果不回退；
- `ops` 每日备份 `VACUUM INTO` 在 PG 模式静默降级（sqlite 专有）——**PG 侧备份须另行安排 pg_dump**（M7 OPS-3 排期，切换前必须有临时 crontab 兜底）；
- 结构锚点告警：切换后 PG 端首次自算锚点，可能有一条 `[migrate] 结构漂移告警`——属预期，跑一次 `node scripts/migrate.js up` 即重锚消除。

---

## 4. 回滚预案（RTO 实测 ≈ 2 分钟）

**触发条件**（满足其一）：
- 验收锚点计数不一致且 15 分钟内无法定位；
- 服务启动失败 / 核心链路（登录、对话）不可用；
- 出现数据正确性事故（错租户可见、写入丢失）。

**回滚步骤：**

```bash
bash 停止平台.command
rm db.env                      # 删切换点即回 sqlite
bash 启动平台.command           # 数据 = S2 快照点（停机窗口内无新写，零丢失）
```

**回滚后差异处理**：停机直切在 S1 冻结写入，回滚即回到冻结点，**理论上零丢失**；
但若回滚发生在「切换后已运行并产生新数据」的场景（先验收再观测期），PG 侧新写入需按
`op_logs`/`messages` 时间戳手工回补——触发条件中已要求尽早发现，避免此态。

sqlite 快照自 S2 起保留 **7 天**（D-5 拍板），过期后由值班删除。

---

## 5. 已知项与排期关联

| 项 | 状态 | 去向 |
|---|---|---|
| VACUUM INTO 备份降级 | PG 模式静默跳过 | M7 OPS-3：pg_dump 双轨 |
| FTS5 全文检索 | 降级内存 BM25 | PG-5：10 万分块实测收口 |
| dm（达梦）方言 | MERGE 模板未落地 | M9 信创第一档 |
| 平面表 21 张无 RLS | 应用层防线 | 设计如此（共享配置语义） |
| PG→sqlite 反向工具 | 无 | D-5 拍板走快照回退，不建反向工具 |

---

## 6. 演练记录归档（2026-11-24，PG-3/PG-4 联合演练）

| 轮次 | 内容 | 结果 |
|---|---|---|
| 一 | 全量搬运对账（126 表 / 2674 行） | 124/124 表 diff=0；2 表列漂移暴露（expert_catalog/sub_agent_library 缺 created_by）→ 治本迁移步 141/142 |
| 二 | 补列后重置演练库重跑 | 全表 diff=0；缺列 NULL 填充路径实证；**踩坑**：超户裸建 public schema → 启动报 no schema（改 AUTHORIZATION 修复） |
| 三 | 生产补列落地后终形态 | 124 表 / 2683 行全 diff=0、无警告；生产重启健康检查通过、锚点重锚一致 |
| 四 | **本 runbook 全流程验收演练**（S1~S7 + 回滚，演练库 metaforge） | 切换全程 35 秒（S4 建链 5s + S5 搬运 3.6s + S7 启动+健康检查 7s）；**验收锚点 8/8 一致**（users/tenants/agents/sessions/messages/kb_chunks/workflow_runs/op_logs 双侧计数全等）；RLS 抽查：业务角色无上下文 messages=0 行（FORCE 拦截）、platform 逃逸=309 行；序列健康三表 seq=MAX+1；**回滚 RTO 实测 10 秒**（目标 ≤30 分钟）；演练库已按数据最小化原则 DROP |

实测基线：搬运 3.6 秒 / 2683 行；PG 模式全链冷启动 5.87s；生产 PG 模式启动+健康检查 7s；回滚（停-删-启-健康检查）10s。

---

## 附：快速参考卡

```bash
# 切换（全部按 §2 顺序，此处仅速查）
bash 停止平台.command && cp data/platform.db data/platform.db.bak-$(date +%Y%m%d-%H%M%S)
psql <admin> -c "CREATE DATABASE metaforge OWNER mt7_app;"
AGENT_DB_DRIVER=pg PG_CONN=… node -e "require('./src-server/db');require('./src-server/lib/config');require('./src-server/lib/sso')"
PG_CONN=… node scripts/migrate-to-pg.js        # 必须 diff = 0
echo -e "AGENT_DB_DRIVER=pg\nPG_CONN=…" > db.env && bash 启动平台.command

# 回滚
bash 停止平台.command && rm db.env && bash 启动平台.command
```

> AI生成
