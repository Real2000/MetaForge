# agent-platform-sdk

智能体开发平台官方 Python SDK。

## 安装

```bash
# 平台内下载（SDK 中心）
# pip 私有仓发布后：
pip install agent-platform-sdk
```

## 三行代码完成一次对话

```python
from agent_platform import AgentPlatform

ap = AgentPlatform(base_url='http://localhost:3210', api_key='sk-ap-xxx')
r = ap.chat.completions.create(model='agent-1-智能体名称', messages=[{'role': 'user', 'content': '你好'}])
print(r['choices'][0]['message']['content'])
```

## 前置：创建 API 密钥

1. 平台后台 →「智能体管理」→ 目标智能体 →「API」
2. 创建密钥得到 `sk-ap-xxx`（智能体须为「已发布」状态）
3. `model` 格式为 `agent-<id>-<名称>`（`ap.list_models()` 可查）

## 流式对话

```python
stream = ap.chat.completions.create(
    model='agent-1-智能体名称',
    messages=[{'role': 'user', 'content': '讲个故事'}],
    stream=True,
)
for chunk in stream:
    print(chunk['choices'][0]['delta'].get('content', ''), end='')
```

## 便捷方法

```python
ap.chat_once('agent-1-助手', '你好', system='你是一个有帮助的助理')  # 直接返回文本
ap.list_models()                                                     # 列出已发布智能体
```

## 错误处理

- 非 2xx 抛 `AgentPlatformError`：`status`（HTTP 码）+ `api_error`（平台错误信封 `{ message, type }`）
- 常见：`401` 密钥无效/停用、`403` 密钥作用域不含目标智能体、`404` model 不存在或未发布、`429` 频率限制（每 Key 20 次/分钟）

## 环境要求

- Python 3.8+；标准库零依赖（urllib）
- 可选：`pip install agent-platform-sdk[requests]` 启用 requests（连接复用更快）

> AI生成
