# PG 模式巡检清单（M6 / PG-6，2026-11-24）

> 范围：`lint:dialect` 审计下 kingbase（PG 系）方言登记项的 **PG 运行时等价复核** + 全功能巡检。
> 结论先行：**13 处登记项等价实现全部在位；巡检 12/12 通过**；本轮唯一代码修复为
> `ops.js dailyBackup` 显式方言降级分支（原裸奔 catch 形态见 §3）。

## 1. 登记项等价实现复核（kingbase 方言，lint:dialect）

### PRAGMA（×6，样本 db.js:L69 / migrate.js:L53 / migrate.js:L714）

| 登记描述 | 运行时等价 | 实证 |
|---|---|---|
| 探测类（PRAGMA table_info 等，db.js 启动内联迁移探测） | `PROBE_DIALECT`（db.js:66，PG=kingbase）分支：列探测走 `information_schema.columns`、表存在走 `information_schema.tables` | PG 首启 142/142 迁移全链实证（三轮演练+e2e） |
| 设置类（busy_timeout/journal_mode） | sqlite 专有设置在 PG 路径不执行（db.js 仅 sqlite 分支调用） | PG 启动日志无 PRAGMA 报错 |

### sqlite_master 系统表（×7，样本 db.js:L78 / migrate.js:L67 / migrate.js:L282）

| 调用点 | 方言分支 | 实证 |
|---|---|---|
| db.js:78 `probeTableExists` | PROBE_DIALECT 三元（sqlite_master / information_schema.tables） | 巡检 ①② |
| migrate.js:67 `tableExists` | 同上（PROBE_DIALECT） | PG 迁移 142/142 |
| migrate.js:261 结构指纹（全库 DDL 哈希） | PG 端首启自算锚点（结构指纹按 information_schema 形态） | PG 端 `migrate.js up` 重新锚定通过（演练实证） |
| retriever.js:281 FTS5 存在探测 | **前置方言判定**（`dialect === 'sqlite'` 才进探测，PG 显式跳过） | 巡检 ⑨ 检索可用 |
| sso.js:28 表存在探测 | try/catch 兜底（PG 下探测异常→false→走建表分支） | e2e sso 链路 |
| tools-extra.js:121 表清单（Text2SQL） | 方言三元（sqlite_master / information_schema.tables） | 巡检 ③ |

### INSERT OR IGNORE / ON CONFLICT（kingbase 原生兼容）

- kingbase（PG 系）原生支持 `ON CONFLICT` upsert——`config.js:138`、`secrets`、`model_capabilities` 三处标准化写法双原生（SQLite/kingbase 零改动）。**巡检 ⑩** `_config` 直写 `INSERT … ON CONFLICT(key) DO UPDATE` 实证写读一致。
- `INSERT OR IGNORE` 类：**BE-C2 已全量标准化为 ON CONFLICT 写法**（业务 3 处），lint 登记仅剩历史样本位。
- dm（达梦）MERGE 模板落地属 M9 信创第一档（不阻塞 PG 轨道）。

### AUTOINCREMENT → SERIAL / IDENTITY

- 方言层自动改写（`sql-dialect.js:194-197`，kingbase→SERIAL）；显式 id 插入后的序列对齐由 db.js 启动块（setval MAX+1）内建。**巡检 ⑪** 两次连续插入 id 严格递增（无 duplicate key）。

## 2. PG 目录安全防线（PG-1 已铺，本轮复核）

Text2SQL（`tools-extra.js sanitizeSelectSql`）在非 sqlite 方言下对系统目录**整类拦截**：

| 攻击面 | 拦截 | 巡检 |
|---|---|---|
| `SELECT * FROM pg_authid`（口令哈希/超级用户标记） | `pg_[a-z_]+` 整类正则拒 | ④ |
| `FROM pg_catalog.pg_class`（schema 前缀旁路） | 前缀形态一并拒 | ⑤ |
| `FROM information_schema.tables`（结构探测） | information_schema 拒 | ⑥ |
| `FROM secrets`（业务敏感表，含 sqlite 系统表黑名单 sqlite_master/sqlite_sequence 等） | DB_DENY_TABLES | ⑦ |
| 正常业务查询 | 放行 + 强制 LIMIT 200/500 注入 | ⑧ |

## 3. 本轮唯一代码修复：ops.js dailyBackup 显式方言降级

**缺陷**（巡检发现）：`dailyBackup` 无方言分支——PG 模式下 `VACUUM INTO ?`（SQLite 专有）每天
03:30 必炸进 catch，写一条假 err_logs「备份失败」噪音，且掩盖「PG 模式备份零产出」的运维事实。

**修复**：显式 `DB_DIALECT !== 'sqlite'` 分支——跳过并记 **op_logs**（降级是登记决策而非错误），
消息指向 M7 OPS-3（pg_dump 双轨）与切换 runbook 的备份兜底要求。sqlite 路径行为零变化。

## 4. 已知降级项（登记在案、巡检标注确认）

| 项 | 形态 | 去向 |
|---|---|---|
| VACUUM INTO 备份 | PG 无内建等价（pg_dump 属外部工具） | M7 OPS-3 双轨 |
| FTS5 全文虚表 | 建表跳过 → BM25 内存通道 | **PG-5**：10 万分块实测 P95 31.6s 不达标 → tsvector+GIN 方案定稿（另文 docs/全文检索PG方案.md） |
| vec0 向量虚表 | 建表跳过 → ANN 不可用 → 向量通道全扫 | M9 信创/AI-02 量化口径 |
| bm25Scores 的 FTS5 探测 | dialect 前置判定（PG 不执行 sqlite_master） | 巡检 ⑨ |

## 5. 巡检执行方式（可重跑）

```bash
# 巡检脚本（12 项断言，PG 模式实跑）：项目 .temp/pg6-patrol.js
AGENT_DB_DRIVER=pg PG_CONN=<业务角色连接串> AGENT_DATA_DIR=.temp/pg5-pg \
  node .temp/pg6-patrol.js        # 期望：PG-6 巡检：12/12 通过

# 方言审计（登记项静态闭环）：
npm run lint:dialect             # 期望：未登记 warning = 0
```

本轮巡检结果（2026-11-24）：**12/12 通过**（探测 API / Text2SQL 方言分叉 / 目录拦截 ×5 /
检索通道 / upsert / 序列 / dailyBackup 降级）。

> AI生成
