"""
智能体开发平台 Python 调用示例

用法：
    pip install requests
    python sdk-example.py
"""
import requests
import json
import sys

BASE = 'http://localhost:3210'


class PlatformClient:
    """平台 API 客户端"""

    def __init__(self, base_url=BASE):
        self.base = base_url.rstrip('/')
        self.token = None
        self.session = requests.Session()

    def login(self, username, password):
        """登录获取 token"""
        r = self.session.post(f'{self.base}/api/auth/login',
                              json={'username': username, 'password': password})
        data = r.json()
        if data['code'] != 0:
            raise Exception(f"登录失败：{data.get('msg', '未知错误')}")
        self.token = data['data']['token']
        self.session.headers['Authorization'] = f'Bearer {self.token}'
        print(f'✅ 登录成功（{username}）')
        return self.token

    def get_agents(self):
        """获取智能体列表"""
        r = self.session.get(f'{self.base}/api/agents')
        return r.json()

    def create_agent(self, name, prompt, model='gpt-4'):
        """创建智能体"""
        r = self.session.post(f'{self.base}/api/agents', json={
            'name': name,
            'description': f'通过 SDK 创建的智能体：{name}',
            'prompt': prompt,
            'model': model,
            'type': 'chat',
            'status': 'published',
        })
        return r.json()

    def get_models(self):
        """获取可用模型列表"""
        r = self.session.get(f'{self.base}/api/chat/models')
        return r.json()

    def chat(self, agent_id, content):
        """同步对话"""
        r = self.session.post(f'{self.base}/api/chat', json={
            'agent_id': agent_id,
            'content': content,
        })
        return r.json()

    def get_knowledge(self):
        """获取知识库列表"""
        r = self.session.get(f'{self.base}/api/knowledge')
        return r.json()

    def get_config(self):
        """获取系统配置"""
        r = self.session.get(f'{self.base}/api/config')
        return r.json()


if __name__ == '__main__':
    import getpass

    client = PlatformClient()

    try:
        # 登录
        username = input('用户名（默认 admin）: ') or 'admin'
        password = getpass.getpass('密码（默认 Admin@2026）: ') or 'Admin@2026'
        client.login(username, password)

        # 获取模型列表
        print('\n📋 可用模型：')
        models = client.get_models()
        if models['code'] == 0:
            for m in models['data'][:5]:
                print(f'   - {m["name"]}（{m.get("provider", "?")}）')
            print(f'   ...共 {len(models["data"])} 个模型')

        # 获取智能体列表
        print('\n🤖 智能体列表：')
        agents = client.get_agents()
        if agents['code'] == 0:
            for a in agents['data'][:5]:
                print(f'   - #{a["id"]} {a["name"]}（{a["status"]}）')
            print(f'   ...共 {len(agents["data"])} 个智能体')

        print('\n✅ 测试通过')

    except KeyboardInterrupt:
        print('\n已取消')
    except Exception as e:
        print(f'\n❌ 错误：{e}')
        sys.exit(1)
