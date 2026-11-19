# 开发者 SDK 与扩展指南

本文档面向希望**集成平台**或**扩展平台能力**的开发者，说明四种扩展途径与各自的接口契约。

> 适用范围：本仓库发布的社区版。企业版在此之上提供多租户、SSO、审计增强等能力，接口保持兼容。

## 一、扩展途径总览

| 途径 | 适用场景 | 认证方式 | 关键入口 |
|---|---|---|---|
| 官方 SDK（Python / TypeScript） | 在自己的应用里调用智能体对话 | 智能体 API 密钥 `sk-ap-xxx` | `POST /openapi/v1/chat/completions` |
| OpenAI 兼容开放接口 | 任意 OpenAI SDK / 客户端直连 | 智能体 API 密钥 | `/openapi/v1/*` |
| MCP 协议（双向） | 接入外部 MCP 工具 / 把智能体暴露为 MCP 工具 | 平台令牌 / MCP 令牌 | `/api/mcp`（客户端）、`/mcp`（服务端） |
| 插件（Plugin） | 用一段隔离代码为智能体新增自定义工具 | 管理员登录令牌 | `/api/plugins/*` |

---

## 二、官方 API SDK

平台内置手写轻量 SDK，契约与 OpenAPI 规范对齐，零/极少依赖。

- **Python**：`sdk/python/`（`agent_platform` 包，标准库 urllib，零依赖）
- **TypeScript/JavaScript**：`sdk/typescript/`（Node 18+ 原生 fetch，零运行时依赖）

三行完成一次对话：

```python
from agent_platform import AgentPlatform
ap = AgentPlatform(base_url='http://localhost:3210', api_key='sk-ap-xxx')
print(ap.chat_once('agent-1-助手', '你好'))
```

```javascript
const { AgentPlatform } = require('agent-platform-sdk');
const ap = new AgentPlatform({ baseUrl: 'http://localhost:3210', apiKey: 'sk-ap-xxx' });
console.log((await ap.chatOnce('agent-1-助手', '你好')));
```

**前置**：后台「智能体管理 → 目标智能体 → API」创建密钥（智能体须为「已发布」）；`model` 形如 `agent-<id>-<名称>`。

**打包下载**：`npm run build:sdk` 生成 `.tgz`（TS）与 `.whl`（Python）到 `public/downloads/`，平台「SDK 中心」亦提供下载。

详见 [`sdk/python/README.md`](../sdk/python/README.md)、[`sdk/typescript/README.md`](../sdk/typescript/README.md)、[`examples/`](../examples/)。

---

## 三、OpenAI 兼容开放接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/openapi/v1/models` | 列出全部已发布智能体 |
| POST | `/openapi/v1/chat/completions` | 对话，支持 `stream` 流式与阻塞两种模式 |

- 鉴权：`Authorization: Bearer sk-ap-xxx`；支持 CORS。
- 输入经敏感词检测、输出自动脱敏；每密钥默认 20 次/分钟限流。
- 原始 REST（平台管理 API，登录令牌认证）示例见 [`examples/api-usage.md`](../examples/api-usage.md)。

---

## 四、MCP 协议接入（双向）

### 4.1 作为 MCP 客户端：接入外部 MCP 服务器

- 管理端路由：`/api/mcp`（服务器登记、工具缓存同步、信任标记）。
- 外部 MCP 工具同步后进入工具清单，智能体勾选即可用；未信任服务器的工具在执行前需人工确认。

### 4.2 作为 MCP 服务端：把智能体暴露为 MCP 工具

- 端点：`POST /mcp`（Streamable HTTP + JSON-RPC 2.0；支持 `initialize` / `tools/list` / `tools/call` / `ping`）。
- 鉴权：`Authorization: Bearer <mcp_token>`（管理员在「MCP 服务」页生成/停用/删除）。
- 工具入参 schema 与智能体 API 文档同源，保证「文档 = 可调用契约」。

---

## 五、插件（Plugin）——自定义工具

插件让你用**一段隔离代码**为智能体新增一个工具。插件工具与内置工具在对话、画布中无差别可用。

### 5.1 插件清单（manifest）

安装插件时提交如下字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `plugin_id` | ✅ | 工具名（作为 `TOOL_DEFS` 键），建议 `snake_case`，如 `weather_query` |
| `entry` | ✅ | 插件入口 **源码**（一段完整 JS 程序，见 5.2 契约） |
| `name` | | 展示名 |
| `description` | | 工具描述（会拼进工具的 function description，供模型理解） |
| `version` | | 版本号，默认 `1.0.0` |
| `author` | | 作者，默认 `system` |
| `runtime` | | 运行时，当前为 `node` |
| `settings_schema` | | 入参 schema（JSON Schema 的 `properties` 对象），定义工具参数 |
| `permissions` | | 权限声明数组（如 `["net:api.example.com"]`），用于审计与展示 |

### 5.2 入口代码契约（`entry`）

`entry` 在**隔离子进程**中执行（`runIsolated`）：

- **入参**：工具被调用时，运行时会以 JSON 注入全局 `globalThis.PLUGIN_ARGS`，插件读取它获取调用参数。
- **输出**：通过 `console.log` 写到 stdout 的内容即工具返回给模型的结果（`stderr` 用于报错信息）。
- **沙箱约束**：默认**禁网**（`fetch` 仅放行显式授权的域名白名单）；`process.env` 被掩蔽；`cwd` 为一次性临时目录；有执行超时与内存上限；进程内写出的非 `main.js` 文件会作为产物收集。
- **失败处理**：非零退出或超时标记为失败，插件返回「插件执行失败：…」，不影响平台稳定性。

### 5.3 完整示例：一个「天气占位」插件

`entry` 源码：

```javascript
// 读取调用入参
const args = globalThis.PLUGIN_ARGS || {};
const city = args.city || '北京';

// 演示数据（真实插件可在此发起已授权的网络请求）
console.log(`【示例插件】${city} 今日晴，气温 22℃（演示数据）`);
```

`settings_schema`（定义工具参数）：

```json
{
  "city": { "type": "string", "description": "城市名，如 北京" }
}
```

### 5.4 生命周期接口

所有接口需管理员登录令牌（`Bearer <token>`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins` | 列出已安装插件 |
| GET | `/api/plugins/:id` | 插件详情 |
| POST | `/api/plugins/install` | 安装/覆盖安装（幂等：同 `plugin_id` 则更新） |
| POST | `/api/plugins/:id/uninstall` | 卸载 |
| POST | `/api/plugins/:id/toggle` | 启用/停用 |
| POST | `/api/plugins/:id/test` | 沙箱试运行（`{"args": {...}}`），安装后验证可用性 |
| GET | `/api/plugins/remote/sync` | 同步远程插件市场列表 |

安装示例：

```bash
TOKEN="<管理员登录令牌>"
curl -s -X POST http://127.0.0.1:3210/api/plugins/install \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "plugin_id": "weather_query",
    "name": "天气查询（示例）",
    "description": "查询指定城市的天气（演示）",
    "entry": "const a=globalThis.PLUGIN_ARGS||{};console.log(`【示例插件】${a.city||\"北京\"} 今日晴，气温 22℃（演示数据）`);",
    "settings_schema": { "city": { "type": "string", "description": "城市名" } },
    "permissions": []
  }'
```

试运行：

```bash
curl -s -X POST http://127.0.0.1:3210/api/plugins/1/test \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"args":{"city":"上海"}}'
```

安装并启用后，到「智能体管理」为目标智能体勾选 `weather_query` 工具，即可在对话中通过自然语言触发。

### 5.5 插件运行时说明

- 服务启动时自动加载所有已启用插件并注册到工具表；安装/启用/更新后即时热注册，卸载/停用后即时移除。
- 每次执行落 `sandbox_runs` 审计；加载失败落 `err_logs`，不阻断服务。

---

## 六、技能（Skill）

技能面向「提示词 + 资源 + 工作流」的封装，与插件的区别：插件是**代码型工具**，技能是**能力包**（可含提示词模板、示例、工作流）。技能市场路由 `/api/skills-market`；`@技能名` 可在对话中显式触发。

---

## 七、参考

- 示例代码：[`examples/sdk-example.py`](../examples/sdk-example.py)、[`examples/sdk-example.mjs`](../examples/sdk-example.mjs)、[`examples/api-usage.md`](../examples/api-usage.md)
- 命令行管理：`node cli/cli.js --help`
- 部署与运维：[`docs/部署手册.md`](部署手册.md)、[`docs/OFFLINE_DEPLOY.md`](OFFLINE_DEPLOY.md)
- 贡献与安全：[`CONTRIBUTING.md`](../CONTRIBUTING.md)、[`SECURITY.md`](../SECURITY.md)

> AI生成
