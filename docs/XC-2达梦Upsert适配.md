# 达梦 Upsert 适配（M9 / XC-2，2026-11-25）

> 交付口径（V1.1 计划表 XC-2 + 风险 4 降级预案）：dm 无官方容器镜像——「方言 translate 单测扩容全绿
> + MERGE 模板落地」本轮交付；「建表 + 核心读写链路实测」待 dm 测试环境（客户环境联调或官方
> 容器开放）后收口。

## 一、任务定位

XC-2 原文：「基线登记的 7 处 INSERT OR IGNORE → MERGE 模板逐处改写（dm unsupported 项）」。
实测清点业务位共 **8 处**（登记样本位 7 处 + 复查发现 skills-market 收藏位）：

| # | 位点 | 表 | 冲突目标（唯一约束） |
| --- | --- | --- | --- |
| 1 | db.js 内置模板 seed | workflow_templates | slug UNIQUE |
| 2 | lib/auth.js token 吊销 | token_blacklist | jti（普通索引，见 §三语义登记） |
| 3 | lib/market-sync.js 市场同步 | plugins | plugin_id UNIQUE |
| 4 | lib/migrate.js 迁移台账 | _migrations | id PK |
| 5 | routes/security.js 敏感词导入 | words | 无唯一约束（见 §三语义登记） |
| 6/7 | routes/notify.js 已读标记 ×2 | notification_reads | UNIQUE(username, notification_id) |
| 8 | routes/skills-market.js 收藏 | market_favorites | UNIQUE(username, item_type, item_id) |

## 二、交付设计：lib/upsert.js 声明式跨方言出口

不做 SQL 文本机械翻译（sql-dialect 设计原则「语义复杂改写不臆造」——ON CONFLICT→MERGE 的
占位符重排机械翻译极易错位），改为业务位以声明式 spec 生成分支 SQL：

| 方言 | ignore 模式（存在即跳过） | upsert 模式（更新非键列） |
| --- | --- | --- |
| sqlite | `INSERT OR IGNORE`（存量语义零变） | `ON CONFLICT(keys) DO UPDATE SET c=excluded.c` |
| kingbase / PG | `ON CONFLICT(keys) DO NOTHING`（显式冲突目标） | 同 sqlite（原生） |
| dm | `MERGE INTO ... USING (SELECT ? AS c1...) src ON ... WHEN NOT MATCHED THEN INSERT` | 追加 `WHEN MATCHED THEN UPDATE SET c=src.c`（Oracle 分支序：MATCHED 在前） |

- **占位符按 columns 声明序线性排列**，dm 的 USING 子句同序消费、两分支引用 `src."col"`
  符号名——从源头消灭「MERGE 占位符重排」陷阱；
- SQL 缓存（Map，200 条上限简单淘汰）——notify/markRead 等热路径零重复拼接；
- 防御闸：未知方言 fail-fast / keys⊄columns 拒绝 / upsert 无可更新列拒绝 / 标识符 `"` 翻倍转义；
- 方言探测 `currentDialect()`：AGENT_DB_DRIVER（db.js 权威源，pg→kingbase 映射）> DB_DIALECT
  （dal 兼容兜底）> 缺省 sqlite；每次实读 env（无缓存污染，测试可注入）。

连带收益：5 处内嵌 `datetime('now','localtime')`（workflow_templates/_migrations/words 等）
参数化为 `now()`（同格式字符串），消除 SQLite 专有函数依赖。

## 三、语义登记（跨方言行为微差，已注释于改写位）

1. **token_blacklist（jti 普通索引非唯一）**：sqlite 侧 INSERT OR IGNORE 从不触发（插重复 jti
   双行——现状如此，零回归）；dm 侧 MERGE ON jti 跳过——JWT jti 标准全局唯一，即幂等去重本意。
2. **words（无唯一约束）**：业务位已有「先查 word 后写」应用层判重为主体；sqlite 侧 OR IGNORE
   同样从不触发；dm 侧 MERGE ON word 为并发窗口的原子化兜底。

## 四、范围界定（保留原样的位点）

`dm::ON CONFLICT upsert` 登记 ×7（checkpoints/secrets/_config/cluster-lock/群白名单/
schema_anchor/rate-limit）**本轮不动**：SQLite/kingbase 双原生；其中 rate-limit 含
`count=count+1` 增量表达式 + RETURNING 子句、cluster-lock 含 WHERE 抢锁谓词——语义复杂改写
不臆造，dm 部署时按基线登记模板手工替换或扩展 buildUpsert 表达式列。基线登记文本已同步更新
（scripts/dialect-baseline.json）。

## 五、验收对照

| V1.1 计划表 XC-2 验收标准 | 结果 |
| --- | --- |
| dm 方言 translate 单测扩容全绿 | ✅ smoke 新增 XC-2 组 4 用例：三方言×两模式 SQL 形态（含 MERGE 关键件/分支序/占位符线性序/防御闸/标识符转义/缓存恒定）+ currentDialect 映射 + sqlite 实库行为级（ignore 二次插入幂等/三列复合唯一）+ 8 处业务位清零与 spec 锚点 |
| 至少建表 + 核心读写链路实测通过 | ⏸ 阻塞于 dm 测试环境（无官方容器；风险 4 既定降级）——本报告 §二 机制 + smoke 语言级实测为可测部分全量交付，dm 环境到位后按 §五 附验收清单收口 |

**dm 环境到位后的收口清单**：① `AGENT_DB_DRIVER=dm` 驱动接线（db-driver dm 模块——达梦
npm 驱动无官方包，需客户环境提供）；② migrate.js 建表链路实跑（140+ 迁移 × information_schema
探测分支）；③ 8 处业务位 MERGE 行为实跑验证；④ rate-limit/cluster-lock 复杂位点 MERGE 改写；
⑤ lint:dialect 复扫确认零告警。

## 六、验证记录

- 三门禁全绿（lint:sql 2 处基线内 / lint:schema 119 表 / lint:dialect 未登记 warning=0，
  dm::INSERT OR IGNORE 业务位从审计雷达清零）；
- sqlite 全量回归 + tenant-e2e（见提交记录）；
- `docs/AI增益验收报告.md` §四同轮交付（M8 收口），与本报告共同构成 V1.1 第七轮产出。

> AI生成
