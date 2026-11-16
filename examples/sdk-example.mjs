/**
 * 智能体开发平台 SDK 调用示例 —— TypeScript/Node（U1-8 官方 SDK 用法）
 *
 * 前置：
 *   1. 平台后台 →「智能体管理」→ 目标智能体（须已发布）→「API」→ 创建密钥 sk-ap-xxx
 *   2. 安装 SDK（二选一）：
 *      - 平台「API 密钥」弹窗下载 agent-platform-sdk-x.x.x.tgz 后：
 *        npm install agent-platform-sdk-x.x.x.tgz
 *      - npm 私有仓就绪后：npm install agent-platform-sdk
 *
 * 用法：
 *   node examples/sdk-example.mjs            # 三行核心调用
 *   node examples/sdk-example.mjs --stream   # 流式
 *   node examples/sdk-example.mjs --models  # 列出智能体
 */
import { AgentPlatform } from 'agent-platform-sdk';

const BASE_URL = 'http://localhost:3210';
const API_KEY = 'sk-ap-替换为你的密钥'; // 后台「智能体管理 → API」创建
const MODEL = 'agent-1-智能体名称';      // ap.listModels() 获取

async function demoModels(ap) {
  const models = await ap.listModels();
  console.log(`可用智能体 ${models.length} 个：`);
  for (const m of models) console.log(`  - ${m.id}  ${(m.description || '').slice(0, 40)}`);
}

async function demoChat(ap) {
  const r = await ap.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: '你好，介绍一下你能做什么？' }],
  });
  console.log('回复：', r.choices[0].message.content);
}

async function demoStream(ap) {
  const stream = await ap.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: '给我讲一个 100 字以内的小故事' }],
    stream: true,
  });
  process.stdout.write('回复：');
  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0].delta?.content || '');
  }
  process.stdout.write('\n');
}

const ap = new AgentPlatform({ baseUrl: BASE_URL, apiKey: API_KEY });
const arg = process.argv[2] || '';
if (arg === '--models') await demoModels(ap);
else if (arg === '--stream') await demoStream(ap);
else await demoChat(ap);
