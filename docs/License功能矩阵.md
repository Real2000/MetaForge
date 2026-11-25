# License 功能矩阵与商用化指南（三档定稿 · M7 / OPS-5，2026-11-25）

> 定稿口径（V1.1 计划表 OPS-5）：三档功能矩阵、签发-验签-轮换-到期降级全链、试用授权流程。
> 演练：`.temp/ops5-license-drill.js` 五段全过（2026-11-25，本文件 §三）。
> 商务对标：MaxKB 专业版「永久授权买断」模式——本平台 License 为**部署级 功能开关**，
> 社区版兜底不锁死（「不锁死不裸奔」）。

## 一、三档功能矩阵（EDITIONS 定稿，src-server/lib/edition.js）

| 能力 | 社区版 community | 专业版 professional | 企业版 enterprise |
|---|:---:|:---:|:---:|
| agents 智能体构建 | ✅ | ✅ | ✅ |
| kb 知识库（上传/分块/混合检索/评测） | ✅ | ✅ | ✅ |
| workflow 画布编排 | ✅ | ✅ | ✅ |
| mcp 工具接入（MCP 服务/连接器广场） | ✅ | ✅ | ✅ |
| openapi 对外 API（Agent API/全域 Key） | ✅ | ✅ | ✅ |
| dingtalk 企微/飞书/钉钉组织集成 | — | ✅ | ✅ |
| unlimited 企业级配额（智能体/知识库等上限解除） | — | ✅ | ✅ |
| audit_flow 智能体上架审核流（三审） | — | — | ✅ |
| priority_support 优先支持通道 | — | — | ✅ |

**档位设计原则**：

- 社区版保留全部**核心生产力**（建模/知识/编排/API）——可用性即传播力，不含管理围墙；
- 专业档差分在**组织协同**（IM 集成）与**规模解除**（unlimited）——按组织规模付费的自然分界；
- 企业档差分在**治理与保障**（审核流合规 + 优先支持）——大组织采购决策点。
- 高档**包含**低档全部特性（`hasFeature` 单一判定，无组合陷阱）。

**特性闸消费点**（requireFeature('...')）：agents 写入/克隆入口（`agents`）、skills-market 克隆
（`agents`）、IM 集成路由组（`dingtalk`）、智能体发布审核流（`audit_flow`）等——闸在**写入/入口**
层而非读层（读历史数据不受降级影响）。

## 二、License 技术链路（既有基建，V2.2/V2.3 完备）

| 环节 | 实现 | 说明 |
|---|---|---|
| 签发 | `scripts/issue-license.js` | Ed25519 签名 JSON；私钥**绝不入仓库**（护栏拦截仓库内路径）；`--days` 可负数（测试过期） |
| 验签 | lib/edition.js refreshLicense | 签名 + 字段形态 + 档位合法性 + 日期五重校验；7 种降级原因（missing/badjson/badpubkey/badsig/badformat/badedition/expired） |
| 部署自检 | `scripts/verify-license.js` | 不依赖服务进程；`--pubkey` 验证轮换后签名链路 |
| 公钥轮换 | env `LICENSE_PUBKEY_HEX` 覆盖内置 | 流程见 `docs/License密钥轮换指南.md`（签发机新钥 → 部署机换公钥 → verify 自检 → reload） |
| 运行态管理 | `routes/edition.js` | HTTP 上传/查看/重载（Key 只留前缀展示，双层防泄露） |
| 到期提醒 | checkExpiryNotice | 到期前 N 天通知中心提醒（不阻塞运行） |

**降级红线（验收硬指标）**：任何降级**不抛错不阻塞启动**，社区版核心功能全量可用；专业特性
入口关闭（不裸奔）。到期日当天仍有效（`< 今天`才过期）。

## 三、全链演练记录（2026-11-25，五段全过）

| # | 段 | 结果 |
|---|---|---|
| ① | 签发：密钥对生成 + 专业版 30 天（试用口径 `试用-星尘科技`） | License 字段/签名正确 |
| ② | 部署验签：verify-license --pubkey 新公钥 | ✅ 专业版 / 剩余 30 天 |
| ③ | 服务仿真：env 公钥 + license.json → edition 加载 | 专业版生效（dingtalk=true，基础 agents=true） |
| ④ | **试用到期：--days -5 → 降级** | 社区版 / reason=expired：**dingtalk=false 关停、agents=true 基础不阻塞**（硬指标过） |
| ⑤ | **密钥轮换：新钥企业版 365 天** | 新公钥下企业版生效（audit_flow=true）；**旧公钥对新签名 fail-closed 降级**（密钥分离性） |

**试用授权流程（定稿）**＝短周期签发（如 30 天）+ 客户标识 `试用-<客户名>`（防串货 + 展示）+
到期自动降级社区版兜底（无需运维介入，客户侧无感退化）；续期 = 换发新 License 上传即生效
（`POST /api/edition/reload`，无需重启）。

## 四、验收对照（V1.1 计划表 OPS-5）

| 验收标准 | 结果 |
|---|---|
| 三档功能矩阵定稿 | ✅ §一（含设计原则与消费点对照） |
| 签发-验签-轮换-到期降级全链演练 | ✅ §三 五段全过 |
| 试用授权流程 | ✅ §三（短周期 + 到期降级兜底 + 无重启续期） |
| 全链演练通过（含到期降级不阻塞基础功能） | ✅ 硬指标实证（agents=true） |
| 功能矩阵文档发布 | ✅ 本文档 |

> 上线前待办（商务侧，非代码）：正式签发机私钥托管与 `LICENSE_PUBKEY_HEX` 生产内置分发；
> `security@example.com` 占位邮箱替换（OPS-4 遗留观察 §四）。

> AI生成
