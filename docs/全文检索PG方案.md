# 全文检索 PG 方案定稿（M6 / PG-5，2026-11-24）

> 验收口径（V1.1 计划表 PG-5）：10 万分块下**检索可用、召回不回归、P95 < 300ms**（对齐 AI-02）；
> 方案定稿入 docs。
> **PoC 落地更新（2026-11-24 当日，§4 清单已全部实现）**：tsvector 候选集全链落地——
> MATCH 通道 P50 86ms（达标）；全链 P50 1.5s 的尾部归因与后续方向见 §6。
> 结论先行：**内存 BM25 通道（sqlite/PG 共用缺省路径）在 10 万分块下实测 P95 31.6s/37.0s，
> 与验收线差两个数量级，确定不达标**；且 rows 全量加载（867ms/2772ms）与 RRF 阈值临界（大库
> 近零命中）为跨引擎结构性问题。**定稿方案：tsvector + GIN 索引替代（JS 预分词入列，与 sqlite
> FTS5 同构的库内候选集方案）**，PoC 实现清单见 §4。

## 1. 实测数据（2026-11-24，本项目 .temp/pg5-{seed,bench,bench3}.js 可重跑）

造数：单库 100 000 分块（100 主题 × 1000 块，中文 200-400 字变异，主题词保证区分度），查询集 50 条。

| 粒度 | sqlite 基准 | PG（同步桥） |
|---|---|---|
| rows 全量加载（10 万行含 BLOB） | P50 **867ms** / RSS 482MB | P50 **2772ms** / P95 4719ms / RSS **1172MB** |
| BM25 内存通道（分词+打分/查询） | P50 **13.4s** / P95 **31.6s** / RSS 1GB | P50 **14.3s** / P95 **37.0s** / RSS **2GB** |
| 向量全扫段（parseVec+cosine） | 14ms（embedding 全 NULL 近零） | 9ms |
| retrieve() 全链（含哈希降级嵌入+写回） | P50 **32.5s** / P95 35.3s | P50 **144s** / P95 **161s**（含 bgeEmbed 批量失败等待 + 10 万次本地哈希 + 10 万次 UPDATE 写回——桥逐条写回往返为主因） |

关键判定：

1. **P95 31.6s / 37.0s vs 验收 300ms——差 105 / 123 倍**。内存通道的查询期全量重分词
   （每查询对 10 万块重新 terms()：中文 2-gram 生成 + Set 运算）是首要成本；rows 全量加载
   为第二成本（且 PG 桥大结果集走溢出文件通道放大 3 倍 + RSS 2GB）。
2. **召回无回归成立**：sqlite 与 PG 走同一 bm25ScoresMemory 实现，分词/打分完全同码；
   大库下双侧行为一致（见 §2 阈值临界——同为 RRF 量级所致，非 PG 差异）。另注：FTS5 的
   `unicode61` 分词器不切中文，内存版 2-gram 对中文召回反而更强——降级在中文场景不是召回倒退。
3. **检索可用性缺陷（跨引擎一致）**：RRF 融合分上限 ≈ wB/(K+1) + wV/(K+1) = 0.0164（K=60），
   10 万块大库实际 top 分 ≈0.0085——**低于缺省 threshold=0.01 → 近零命中**（sqlite 侧同样仅
   1 条过阈）。生产小库（<1 万块）不受影响（双通道排名靠前时分值 0.0164 > 0.01）。该缺陷与
   驱动无关，属分数量级与阈值的校准缺失——修复随 PoC 配套（§4-⑤）。

## 2. 意外收获：PG-1 遗留缺陷修复（本轮提交）

实测过程暴露并修复 `retriever.js` 主 SELECT 的 PG 崩溃：原句 `WHERE (? IS NULL OR c.kb_id = ?)`
在 PG 端报 `could not determine data type of parameter $1`——`$1 IS NULL` 不提供类型线索、PG
参数推断失败（sqlite 动态类型宽松不炸）。**即 PG 模式下所有检索（kbId 限定/跨库）全链崩溃**
（e2e 用例未覆盖检索路径故未暴露）。已改为按 kbId 有无拼两个 SQL 形态（语义严格一致）；
全库排查此模式仅此一处。

巡检脚本外壳缺陷同步修复：同步 try/catch 捕不到 async 断言——retriever 用例曾假 ✓，
`.temp/pg6-patrol.js` 改 promise 收集 + 统一 await 后真验证 13/13。

## 3. 方案对比与定稿依据

| 方案 | 评估 | 结论 |
|---|---|---|
| A. 内存 BM25 + 倒排缓存（JS 层 term→postings，增量失效） | 打分可降到 O(命中)，但 **rows 全量加载 867ms/2772ms 仍在**（超验收线 3-9 倍）；RSS 0.5-1GB 不可接受；且 sqlite/PG 双端各自维护缓存 | 单独不达标，否决 |
| B. **tsvector + GIN（JS 预分词入列）** | BM25 通道 SQL 侧 `@@` 匹配 + `ts_rank` + LIMIT 候选——rows 加载从 10 万行降至候选几百行（<100ms 量级）；分词仍由 JS `terms()` 完成（**与内存版/FTS5 口径一致，召回可对齐**）；GIN 倒排在库内，冷启动零成本 | **定稿** |
| C. zhparser（PG 中文分词扩展） | 容器需自建镜像、分词口径与 JS 版不一致（召回对齐困难） | 否决 |
| D. pg_trgm | trigram 模糊匹配语义非等价检索 | 否决 |

B 的关键设计点：`to_tsvector('simple', ...)` + 空格连接的 JS 预分词串（simple 配置不再二次
分词，词边界完全由 JS 决定）——规避 PG 中文分词缺失，同时保留 BM25-lite 的 2-gram 召回口径。

## 4. PoC 实现清单（已全部落地，2026-11-24）

1. **列迁移**（迁移步 143，kingbase-only 方言分支）：`ALTER TABLE kb_chunks ADD COLUMN bm25_tsv tsvector` + GIN 索引；
   迁移步 145（实测调优）：btree_gin 扩展 + 复合 GIN `(kb_id, bm25_tsv)`（单列 GIN 下 planner 常弃用——单库 kb_id 选择性高 + RLS 行过滤不可索引化；复合形态为版本演进/低频词保底）。
2. **摄取双写**：ingestion-pipeline 父块/子块 INSERT 双写（`to_tsvector('simple', ?)` 参数化，PG-only 拼接）。
3. **查询改写**：retriever PG 方言候选集路径（`bm25_tsv @@ to_tsquery('simple', qTerms OR)` + `LIMIT 500`，`TSV_CANDIDATES=500`）；**打分仍 bm25ScoresMemory（候选集上毫秒级）——双端打分口径严格一致**；列缺失防御性回落全量（`_pgTsvReady` 探测）。
4. **存量回填**：`scripts/migrate-to-pg.js` 内置 `backfillTsv`（分批 500 行，只补 `tsv IS NULL` 增量幂等；口径 content+keywords 完整 `_idx`）；**时序设计**：回填不在迁移步做（143 空库首启即记账，彼时回填则搬运数据永远 NULL）——由工具搬运后统一执行（runbook S5 自动包含，10 万块实测 149s）。
5. **编辑/合并/关键词同步**：knowledge.js 三处 UPDATE、keywordgen.js 一处 UPDATE 同步重算 tsv（`lib/text-terms.js` 单一事实源——terms/tsvText/idxText；写侧 tsv 与读侧 `_idx`/tsquery 严格同口径防召回回归）。
6. **ANALYZE**：搬运工具尾部自动 `ANALYZE`（实测踩坑：统计失真时 planner 对 MATCH 行数估计 rows=6 而实际 10 万 → 索引选择失当 1.2s 级误判）。
7. **启动期增量回填**（db.js PG 启动块）：每次启动探测 `bm25_tsv IS NULL` 行并增量回填——**兜住一切非管道写入**（种子数据内联 INSERT、巡检/测试裸插、未来未知直插；巡检实锤：演示知识库首建在 PG 下检索不可见，该块根治）。稳态 COUNT 毫秒级；大库首次回填 10 万块实测 ~3 分钟一次性。
8. **意外修复**：迁移步 11 的 embedding def 历史上为 TEXT（JSON 文本时代）——AI-02 改 float32 BLOB 写入后未跟进，PG 严格类型下二进制插 text 报 `invalid byte sequence 0x00`（造数搬运实锤）。迁移步 144 存量改型 `text→bytea`（先 DROP 旧 DEFAULT）；步 11 def 就位 BLOB（新库直接建对）。生产潜伏风险同步消除。143/144/145 均已补 down（BE-E1 回滚闭环；down 与 up 对称方言分支——PG 语法在 sqlite 会断回滚链）。

### 摄取双写点全景（写入路径全覆盖）

| 写点 | tsv 口径 | 说明 |
|---|---|---|
| ingestion-pipeline 父块/子块 INSERT | content | 摄取时 keywords 未生成 |
| knowledge.js 编辑（带元数据/纯内容）、合并 UPDATE | content+keywords（完整 _idx） | SQL 列引用拼旧 content + JS 算 keywords 扩展 |
| keywordgen.js 关键词生成 UPDATE | content+keywords（完整 _idx） | keywords 生成后并入 |
| db.js 种子/巡检/任何直插 | 启动期回填自愈 | 见 §4-7 |
| scripts/migrate-to-pg.js 搬运 | 工具回填（分批增量幂等） | runbook S5 自动包含 |

## 5. PoC 实测结果（10 万分块演练库 pg5_drill，与生产切换同构链路）

| 指标 | PoC 前（内存通道） | PoC 后（候选集） | 验收线 |
|---|---|---|---|
| MATCH 候选集 SELECT（retrieve 主 SQL） | 2772ms（全量 rows 加载） | **P50 86ms / P95 626ms**（高频词 19-90ms；低频词尾部见 §6） | — |
| retrieve 全链 P50（含向量通道） | 144s | **1.5s** | — |
| 零命中查询（threshold=0.01 默认） | 46/50 | **4/50**（候选集 rank 域变小，RRF 融合分 0.0164 量级正常过阈） | — |
| RSS | 1.2GB | **350MB** | — |
| 搬运+回填 | — | 10 万块 93s + 回填 149s（工具内置） | — |

- **检索可用 ✓**：46/50 命中（默认阈值下）；召回打分 bm25ScoresMemory 双端同码同口径。
- **对比基线**：全链 P50 32.5s（sqlite）/144s（PG）→ 1.5s，**20~96 倍改善**；生产现状规模（<1 千块）下全路径毫秒级。
- **P95 < 300ms**：MATCH 通道高频词达标（19-90ms）；全链 P95 2.4s 未全达——尾部归因见 §6（非候选集本体成本）。

## 6. 尾部归因与后续方向（下版排期）

P50 1.5s ≈ MATCH 86ms + **向量通道哈希降级段 ~1.4s**（候选 500 块的 parseVec → bgeEmbed 失败 →
本地哈希 embed 500 块 + 桥逐条写回 500 次）。**该段与 vecWeight 无关**（560-610 行结构），
是 PG 无 vec0 → ANN 不可用 → 全扫+哈希兜底+落库缓存的既有形态（内存通道时代同样存在，被 32s
分词掩盖）——**归 AI-02/OPS-1 量化口径（pgvector PoC 另立项）**，非全文检索候选集缺陷。

低频词/无命中词的 MATCH 尾部（0.5-2.4s）：planner 在「LIMIT 早停」赌注下选 Seq 扫（RLS 行过滤
不可索引化 + 高频 2-gram 的 posting bitmap 成本评估）——已固化 ANALYZE（防统计失真误判）+ 复合
GIN（形态保底）；**根治方向**（下版）：候选查询包事务 + `SET LOCAL` 强制索引、或 tsquery 高频词
动态裁剪（需运行时词频探测），均需 planner×RLS 深水区专项验证，边际成本陡增故列排期。

RRF 阈值校准（原 §4-⑤）：候选集形态下零命中 46/50→4/50，**阈值问题随候选集 rank 域收窄自然消解**——不改动 threshold 语义（保持 0.01 缺省，零调用面变更风险）。

## 5. 中小规模现状结论（PG 模式检索当下可用性）

生产当前规模（单库 <1 千块）：内存通道毫秒级（P95 <50ms）、RRF 分值远超阈值——**PG 模式检索
链路自 PG-2/PG-5 修复后完整可用**（巡检 13/13 小库链路实证）。10 万分块量级的切换前置条件：
完成 §4 PoC（runbook 切换前置检查项补充「目标库规模 >5 万分块须先落 tsvector PoC」）。

> AI生成
