# 全文检索 PG 方案定稿（M6 / PG-5，2026-11-24）

> 验收口径（V1.1 计划表 PG-5）：10 万分块下**检索可用、召回不回归、P95 < 300ms**（对齐 AI-02）；
> 方案定稿入 docs。
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

## 4. PoC 实现清单（下轮排期，预估 2 人日）

1. **列迁移**（migrate.js 新迁移步，PG-only 方言分支登记 lint:dialect）：
   `ALTER TABLE kb_chunks ADD COLUMN bm25_tsv tsvector`（sqlite 跳过——FTS5 已在位）；
   `CREATE INDEX ... USING GIN (bm25_tsv)`。
2. **摄取双写**：分块入库路径（ingestion-pipeline → kb_chunks INSERT）同步生成
   `to_tsvector('simple', terms(content).join(' '))`；keywords/questions 扩展文本并入（与
   `_idx` 口径一致）。
3. **查询改写**：`bm25Scores` PG 分支（方言判定）改 SQL 候选集——
   `SELECT id, ts_rank(bm25_tsv, q) FROM kb_chunks WHERE kb_id=? AND bm25_tsv @@ q LIMIT 候选N`
   （q 为查询词 OR 形态的 tsquery），候选集回表取 content 参与融合；rows 加载不再全量。
4. **存量回填**：`scripts/reindex-fts.js` PG 版（分批 UPDATE 生成 tsv）。
5. **RRF 阈值校准（配套修复）**：threshold=0.01 与 RRF 量级（上限 0.0164）天然贴地——
   大库近零命中。校准方案二选一（PoC 时按回归结果定）：threshold 缺省随库规模自适应
   （如 `min(0.01, wB/(K+top)×2)`）或 finish 内改用归一分比较。**影响核心检索语义，需全量
   回归 + 召回对比报告**。
6. **验收重测**：同一造数脚本（.temp/pg5-seed.js）+ 查询集复跑——P95 < 300ms、召回与 sqlite
   FTS5 路径 top-k 重合率报告。
7. **向量通道缺口（记录，非 PG-5 范围）**：PG 无 vec0 → ANN 不可用 → 全扫 + 哈希降级嵌入 +
   写回（实测单查 178s 的主因之一）。归属：AI-02 量化口径 / M9 信创（pgvector PoC 另立项）。

## 5. 中小规模现状结论（PG 模式检索当下可用性）

生产当前规模（单库 <1 千块）：内存通道毫秒级（P95 <50ms）、RRF 分值远超阈值——**PG 模式检索
链路自 PG-2/PG-5 修复后完整可用**（巡检 13/13 小库链路实证）。10 万分块量级的切换前置条件：
完成 §4 PoC（runbook 切换前置检查项补充「目标库规模 >5 万分块须先落 tsvector PoC」）。

> AI生成
