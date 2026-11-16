"""
智能体开发平台官方 Python SDK（U1-8）

三行代码完成一次对话（验收标准）：
    from agent_platform import AgentPlatform
    ap = AgentPlatform(base_url='http://localhost:3210', api_key='sk-ap-xxx')
    r = ap.chat.completions.create(model='agent-1-助手', messages=[{'role': 'user', 'content': '你好'}])

端点契约（与平台 /openapi 路由一致，OpenAI 兼容）：
    GET  /openapi/v1/models           列出已发布智能体（model id 形如 agent-<id>-<名称>）
    POST /openapi/v1/chat/completions 对话（Bearer sk-ap-xxx；支持 stream SSE）

认证：agent_api_keys 密钥（后台「智能体管理 → API」创建，model 前缀 agent-<id>- 指定目标智能体）。

零强制依赖：标准库 urllib；装了 requests 则自动优先使用（连接复用更快）。
"""
import json as _json
import urllib.request as _urllib_request
import urllib.error as _urllib_error

try:  # requests 可选依赖
    import requests as _requests
except ImportError:  # pragma: no cover
    _requests = None

__version__ = '1.0.0'
__all__ = ['AgentPlatform', 'AgentPlatformError', 'ChatCompletion', 'ChatCompletionChunk', 'AgentModel']


class AgentPlatformError(Exception):
    """SDK 错误：携带 HTTP 状态与平台错误信封 { error: { message, type } }。"""

    def __init__(self, message, status=0, api_error=None):
        super().__init__(message)
        self.status = status
        self.api_error = api_error  # dict | None


class ChatCompletion(dict):
    """非流式对话响应（OpenAI 兼容 dict 结构，便于直接取字段）。"""


class ChatCompletionChunk(dict):
    """流式增量块（OpenAI 兼容 dict 结构）。"""


class AgentModel(dict):
    """智能体（models 列表项，id 即 chat 用的 model 名）。"""


def _sse_lines(byte_iter):
    """SSE 逐行解析（OpenAI chunk 协议：data: {...} 行 + data: [DONE] 终止行）。"""
    buf = b''
    for chunk in byte_iter:
        buf += chunk
        while b'\n' in buf:
            line, buf = buf.split(b'\n', 1)
            text = line.decode('utf-8', 'replace').rstrip('\r')
            if not text.startswith('data:'):
                continue
            payload = text[5:].strip()
            if payload == '[DONE]':
                return
            if payload:
                try:
                    yield _json.loads(payload)
                except ValueError:
                    pass  # 坏行跳过，流不断


class _ChatCompletions:
    def __init__(self, client):
        self._client = client

    def create(self, model, messages, stream=False, timeout=None):
        """对话补全。非流式返回 ChatCompletion；stream=True 返回生成器逐块产出 ChatCompletionChunk。"""
        return self._client._chat_completions(model, messages, stream, timeout)


class _Chat:
    def __init__(self, client):
        self.completions = _ChatCompletions(client)


class AgentPlatform:
    def __init__(self, base_url, api_key, timeout=60):
        """
        :param base_url: 平台地址（如 http://localhost:3210；尾斜杠自动去除）
        :param api_key:  agent_api_keys 密钥（sk-ap-xxx）
        :param timeout:  请求超时秒数（默认 60）
        """
        if not base_url:
            raise ValueError('base_url 不能为空（如 http://localhost:3210）')
        if not api_key:
            raise ValueError('api_key 不能为空（后台「智能体管理 → API」创建的 sk-ap-xxx 密钥）')
        self.base_url = str(base_url).rstrip('/')
        self.api_key = api_key
        self.timeout = timeout
        self.chat = _Chat(self)
        if _requests is not None:
            self._session = _requests.Session()  # 连接复用（可选依赖自动启用）
        else:
            self._session = None

    # ---------- 底层请求 ----------

    def _post(self, path, payload, timeout=None, stream=False):
        t = timeout or self.timeout
        body = _json.dumps(payload).encode('utf-8')
        if self._session is not None:
            resp = self._session.post(
                self.base_url + path, data=body,
                headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.api_key},
                timeout=t, stream=stream)
            self._raise_for_status(resp)
            return resp
        req = _urllib_request.Request(
            self.base_url + path, data=body, method='POST',
            headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.api_key})
        resp = _urllib_request.urlopen(req, timeout=t)  # 4xx/5xx 走 HTTPError
        return resp

    def _get(self, path, timeout=None):
        t = timeout or self.timeout
        if self._session is not None:
            resp = self._session.get(
                self.base_url + path,
                headers={'Authorization': 'Bearer ' + self.api_key}, timeout=t)
            self._raise_for_status(resp)
            return resp
        req = _urllib_request.Request(self.base_url + path, headers={'Authorization': 'Bearer ' + self.api_key})
        return _urllib_request.urlopen(req, timeout=t)

    def _raise_for_status(self, resp):
        """requests 响应手动抛错（urllib 已自动）；错误信封统一解析成 AgentPlatformError。"""
        if getattr(resp, 'ok', True):
            return
        try:
            text = resp.text
        except Exception:
            text = ''
        raise _from_error_response(resp.status_code, text)

    # ---------- 公开 API ----------

    def list_models(self, timeout=None):
        """列出可用智能体（model id 形如 agent-<id>-<名称>）。"""
        resp = self._get('/openapi/v1/models', timeout)
        text = _read_all(resp)
        j = _json.loads(text)
        return [AgentModel(x) for x in (j.get('data') or [])]

    def _chat_completions(self, model, messages, stream, timeout):
        if stream:
            resp = self._post('/openapi/v1/chat/completions',
                               {'model': model, 'messages': messages, 'stream': True},
                               timeout, stream=True)
            byte_iter = _iter_stream(resp)
            return (ChatCompletionChunk(x) for x in _sse_lines(byte_iter))
        resp = self._post('/openapi/v1/chat/completions',
                          {'model': model, 'messages': messages, 'stream': False}, timeout)
        text = _read_all(resp)
        return ChatCompletion(_json.loads(text))

    def chat_once(self, model, message, system=None, timeout=None):
        """便捷方法：一轮对话直接拿回复文本（非流式）。"""
        messages = []
        if system:
            messages.append({'role': 'system', 'content': system})
        messages.append({'role': 'user', 'content': message})
        r = self._chat_completions(model, messages, False, timeout)
        try:
            return r['choices'][0]['message']['content'] or ''
        except (KeyError, IndexError):
            return ''


def _read_all(resp):
    """统一读取全部响应体（urllib/requests 双兼容）。"""
    if hasattr(resp, 'read'):
        return resp.read().decode('utf-8', 'replace')
    return resp.text


def _iter_stream(resp):
    """流式字节迭代器（urllib 逐块读 / requests iter_content）。"""
    if hasattr(resp, 'iter_content'):
        for chunk in resp.iter_content(chunk_size=1024):
            if chunk:
                yield chunk
    else:
        while True:
            chunk = resp.read(1024)
            if not chunk:
                break
            yield chunk


def _from_error_response(status, text):
    """平台错误信封 { error: { message, type } } → AgentPlatformError（非 JSON 错误体按 null 处理）。"""
    api_error = None
    try:
        j = _json.loads(text)
        if isinstance(j, dict) and isinstance(j.get('error'), dict):
            api_error = {'message': str(j['error'].get('message', '')), 'type': str(j['error'].get('type', 'unknown'))}
    except ValueError:
        pass
    if api_error:
        msg = '平台返回 {0}：{1}（{2}）'.format(status, api_error['message'], api_error['type'])
    else:
        msg = 'HTTP {0}：{1}'.format(status, text[:200] if text else '')
    return AgentPlatformError(msg, status, api_error)
