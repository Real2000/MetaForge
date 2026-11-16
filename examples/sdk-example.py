"""
智能体开发平台 SDK 调用示例（U1-8 起为官方 SDK 用法）

前置：
    1. 平台后台 →「智能体管理」→ 目标智能体（须已发布）→「API」→ 创建密钥 sk-ap-xxx
    2. 安装 SDK（二选一）：
       - 平台「API 密钥」弹窗下载 agent_platform_sdk-x.x.x-py3-none-any.whl 后：
         pip install agent_platform_sdk-x.x.x-py3-none-any.whl
       - pip 私有仓就绪后：pip install agent-platform-sdk

用法：
    python sdk-example.py            # 非流式三行调用
    python sdk-example.py --stream   # 流式调用
    python sdk-example.py --models   # 列出可用智能体
"""
import sys
from agent_platform import AgentPlatform

BASE_URL = 'http://localhost:3210'
API_KEY = 'sk-ap-替换为你的密钥'          # 后台「智能体管理 → API」创建
MODEL = 'agent-1-智能体名称'              # ap.list_models() 获取


def demo_models(ap):
    """列出全部可用智能体（model id 即对话用的 model 名）"""
    models = ap.list_models()
    print(f'可用智能体 {len(models)} 个：')
    for m in models:
        print(f"  - {m['id']}  {m.get('description', '')[:40]}")


def demo_chat(ap):
    """三行核心用法：非流式对话"""
    r = ap.chat.completions.create(
        model=MODEL,
        messages=[{'role': 'user', 'content': '你好，介绍一下你能做什么？'}],
    )
    print('回复：', r['choices'][0]['message']['content'])


def demo_stream(ap):
    """流式对话（SSE，逐块打印）"""
    stream = ap.chat.completions.create(
        model=MODEL,
        messages=[{'role': 'user', 'content': '给我讲一个 100 字以内的小故事'}],
        stream=True,
    )
    print('回复：', end='')
    for chunk in stream:
        print(chunk['choices'][0]['delta'].get('content', '') or '', end='')
    print()


def main():
    ap = AgentPlatform(base_url=BASE_URL, api_key=API_KEY)
    if '--models' in sys.argv:
        demo_models(ap)
    elif '--stream' in sys.argv:
        demo_stream(ap)
    else:
        demo_chat(ap)


if __name__ == '__main__':
    main()
