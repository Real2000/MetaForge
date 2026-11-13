# 智能体开发平台 API 调用示例

本文档提供用 JS (Node.js) 和 Python 调用平台 REST API 的示例。

## 认证方式

支持两种认证方式（二选一）：
1. **HttpOnly Cookie**（推荐：安全，适合浏览器和前端）
2. **Bearer Token**（适合后端服务/SDK）

## 基础配置

```javascript
// config.js
const BASE_URL = 'http://localhost:3210';
// 登录后获取的 token：
let token = null;
```

---

## JS (Node.js) 示例

### 登录获取 Token

```javascript
const BASE = 'http://localhost:3210';

async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('登录失败：' + d.msg);
  return d.data.token;
}

async function chat(agentId, content, token) {
  const r = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ agent_id: agentId, content }),
  });
  // SSE 流式响应
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    // 解析 SSE 格式：data: {...}\n\n
    for (const line of text.split('\n').filter(l => l.startsWith('data: '))) {
      const payload = JSON.parse(line.slice(6));
      if (payload.type === 'answer') process.stdout.write(payload.text);
    }
  }
}

// 使用示例
(async () => {
  try {
    const token = await login('admin', 'Admin@2026');
    console.log('登录成功，token:', token.slice(0, 20) + '...');
    // 对话
    await chat(1, '你好', token);
  } catch (e) {
    console.error(e.message);
  }
})();
```

### 创建智能体

```javascript
async function createAgent(token, name, prompt) {
  const r = await fetch(`${BASE}/api/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      name,
      prompt,
      type: 'chat',
      model: 'gpt-4',
      status: 'published',
    }),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('创建失败：' + d.msg);
  return d.data;
}
```

---

## Python 示例

```python
import requests
import json

BASE = 'http://localhost:3210'

def login(username, password):
    r = requests.post(f'{BASE}/api/auth/login',
                      json={'username': username, 'password': password})
    data = r.json()
    if data['code'] != 0:
        raise Exception(f"登录失败：{data['msg']}")
    return data['data']['token']

def list_agents(token):
    """列出智能体"""
    r = requests.get(f'{BASE}/api/agents',
                     headers={'Authorization': f'Bearer {token}'})
    return r.json()

def chat_sync(agent_id, content, token):
    """同步对话（非流式）"""
    r = requests.post(f'{BASE}/api/chat', json={
        'agent_id': agent_id,
        'content': content,
    }, headers={'Authorization': f'Bearer {token}'})
    return r.json()

def upload_file(token, file_path):
    """上传文件到知识库"""
    with open(file_path, 'rb') as f:
        r = requests.post(f'{BASE}/api/files/upload',
                          files={'file': f},
                          headers={'Authorization': f'Bearer {token}'})
    return r.json()

def query_knowledge(kb_id, query, token):
    """知识库检索"""
    r = requests.post(f'{BASE}/api/knowledge/{kb_id}/retrieve',
                      json={'query': query, 'top_k': 5},
                      headers={'Authorization': f'Bearer {token}'})
    return r.json()

# 使用示例
if __name__ == '__main__':
    token = login('admin', 'Admin@2026')
    agents = list_agents(token)
    print(f'共有 {len(agents["data"])} 个智能体')
    for a in agents['data']:
        print(f'  - {a["id"]}: {a["name"]}（{a["status"]}）')
```

---

## 常用 API 端点速查

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/auth/login | 登录 |
| POST | /api/chat/stream | SSE 流式对话 |
| POST | /api/chat | 同步对话 |
| GET | /api/agents | 智能体列表 |
| POST | /api/agents | 创建智能体 |
| GET | /api/chat/models | 可用模型列表 |
| GET | /api/knowledge | 知识库列表 |
| POST | /api/knowledge | 创建知识库 |
| POST | /api/knowledge/:id/files | 上传知识文件 |
| POST | /api/tasks | 创建定时任务 |
| GET | /api/stats/dashboard | 仪表盘统计 |
| GET | /api/doc/meta?src=wf&id=1 | 文档预览元信息 |
| POST | /api/collab/rooms | 创建协作房间 |

## 完整 API 文档

启动平台后，访问 `/api/api-docs/` 查看自动生成的 OpenAPI 交互文档。

> AI生成
