# agent-platform-sdk

智能体开发平台官方 TypeScript/JavaScript SDK。

## 安装

```bash
# 平台内下载（SDK 中心）
# npm 私有仓发布后：
npm install agent-platform-sdk
```

## 三行代码完成一次对话

```javascript
const { AgentPlatform } = require('agent-platform-sdk');

const ap = new AgentPlatform({ baseUrl: 'http://localhost:3210', apiKey: 'sk-ap-xxx' });
const r = await ap.chat.completions.create({
  model: 'agent-1-智能体名称',               // GET /openapi/v1/models 获取
  messages: [{ role: 'user', content: '你好' }],
});
console.log(r.choices[0].message.content);
```

## 前置：创建 API 密钥

1. 平台后台 →「智能体管理」→ 目标智能体 →「API」
2. 创建密钥得到 `sk-ap-xxx`（智能体须为「已发布」状态）
3. `model` 格式为 `agent-<id>-<名称>`（`ap.listModels()` 可查）

## 流式对话

```javascript
const stream = await ap.chat.completions.create({
  model: 'agent-1-智能体名称',
  messages: [{ role: 'user', content: '讲个故事' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0].delta?.content || '');
}
```

## 便捷方法

```javascript
await ap.chatOnce('agent-1-助手', '你好', '你是一个有帮助的助理');  // 直接返回文本
await ap.listModels();                                            // 列出已发布智能体
```

## 错误处理

- 非 2xx 抛 `AgentPlatformError`：`status`（HTTP 码）+ `apiError`（平台错误信封 `{ message, type }`）
- 常见：`401` 密钥无效/停用、`403` 密钥作用域不含目标智能体、`404` model 不存在或未发布、`429` 频率限制（每 Key 20 次/分钟）

## 环境要求

- Node.js 18+（原生 fetch；更低版本可注入 `fetchImpl`）
- 零运行时依赖

> AI生成
