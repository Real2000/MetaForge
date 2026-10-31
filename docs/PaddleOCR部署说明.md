# PaddleOCR 部署说明（V2.3 #5 摄取管道化 + PaddleOCR 接入 2026-10-31）

## 一、功能定位

知识库摄取管道的 `ocr` 步骤后端：扫描版 PDF / 图片型文件在常规解析后**文本过短（<8 字符）**时，
平台把原始文件 buffer 送外部 PP-OCR 服务识别，把图片内容增强为可切片文本入库。

不部署该服务时平台功能**完全不受影响**（见「四、无 docker / 未配置时的行为」）。

- 平台侧封装：`src-server/lib/paddleocr.js`（HTTP 调用，零第三方依赖，Node 内置 fetch）
- 摄取管道入口：`src-server/lib/ingestion-pipeline.js`（`ocr` 步骤，位于 `parse` 与 `clean` 之间）
- 服务容器编排：项目根目录 `docker-compose.paddleocr.yml`（端口 9300）

## 二、启动命令（docker）

```bash
# 项目根目录执行
docker compose -f docker-compose.paddleocr.yml up -d

# 查看启动日志（首次启动约 5-10 分钟：pip 安装 + 模型下载）
docker compose -f docker-compose.paddleocr.yml logs -f paddleocr

# 停止
docker compose -f docker-compose.paddleocr.yml down
```

首次启动会自动完成：
1. `pip install paddlepaddle==2.6.1 paddleocr==2.7.3 flask==3.0.3`（CPU 版，约数百 MB）；
2. 下载 PP-OCR 中英文检测/识别/方向分类模型（缓存到 `./data/paddleocr-models`，容器重建不重复下载）；
3. 启动极简 HTTP 服务（懒加载：首个识别请求才初始化模型，健康探测不触发加载）。

## 三、平台侧 env 配置

```bash
# 平台启动前设置（指向 OCR 服务基址；不配置 = OCR 整体关闭）
export PADDLEOCR_URL=http://127.0.0.1:9300
node server.js
```

| env | 默认 | 说明 |
| --- | --- | --- |
| `PADDLEOCR_URL` | （未配置=功能关闭） | OCR 服务基址；尾斜杠自动去除；只写 `127.0.0.1:9300` 会自动补 `http://` |

服务契约（与 `docker-compose.paddleocr.yml` 内封装一致，自建服务请对齐）：

- `GET /health` → `200 {"ok":true,...}`：健康探测，3 秒超时，HTTP 2xx 即视为健康
- `POST /ocr`，body `{"image":"<base64>"}` → `{"code":0,"text":"全文","lines":[{"text":..,"score":..}]}`：识别，15 秒超时
- 平台解析侧兼容 PaddleOCR 官方 hubserving 形态 `{"results":[[{"text":...}]]}`

## 四、健康探测与静默降级机制

`ocr` 步骤触发条件（三条件同时满足才发起识别）：

1. 存在原始文件 buffer（`file_b64` 上传；`content` 直传文本无从 OCR，直接跳过）；
2. `parse` 步骤后文本 <8 字符（扫描版特征；文本充足则无需增强）；
3. OCR 服务健康（`PADDLEOCR_URL` 已配置且 `/health` 探测通过）。

降级链路（**任何一环失败都不阻塞上传管道**）：

| 场景 | 行为 |
| --- | --- |
| 未配置 `PADDLEOCR_URL` | 完全静默跳过：不发网络请求、不写任何日志（保证未配置环境与历史行为逐字节一致） |
| 已配置但服务不可达（探测失败） | 跳过 + `console.warn` + `err_logs` 记一条降级（source=`kb-ocr`）；探测结果缓存 60 秒，防连续上传反复探测 |
| 识别失败 / 超时 / 结果为空 | 跳过 + `console.warn` + `err_logs` 记一条降级 |
| 降级后 `clean` 步骤文本仍 <8 字符 | 按历史行为落失败：`解析后无有效文本内容（扫描版 PDF 需先 OCR）`（同步模式 400，异步模式终态 failed） |

## 五、无 docker 时的行为

不部署容器、不配置 `PADDLEOCR_URL` 时：OCR 功能整体关闭，摄取管道 `ocr` 步骤秒级空跳，
上传行为与接入前完全一致——扫描版文件仍按原失败文案落库，**无需为升级本版本而必须部署 OCR**。

如无 docker 但想启用（任选其一，对齐上述服务契约即可）：

```bash
# 方案 A：本机 Python 直起（同容器内实现）
pip install "paddlepaddle==2.6.1" "paddleocr==2.7.3" flask
# 自行编写/复用 docker-compose.paddleocr.yml 里的 server.py 后：
PADDLEOCR_PORT=9300 python server.py

# 方案 B：任意 PP-OCR HTTP 服务（如官方 hubserving）
# 官方形态 {"results":[[{"text":...}]]} 平台侧已做兼容解析，无需改造
```

## 六、验证

```bash
# 1. 服务健康（容器启动完成后）
curl http://127.0.0.1:9300/health
# → {"ok":true,...}

# 2. 识别冒烟（任意图片 base64）
echo "{\"image\":\"$(base64 -i test.png)\"}" | curl -X POST http://127.0.0.1:9300/ocr -d @- -H 'Content-Type: application/json'

# 3. 端到端：配置 PADDLEOCR_URL 后向知识库上传扫描版 PDF →
#    解析日志页（GET /api/knowledge/:id/logs）应看到 success 且 chunk_count > 0
```

## 七、常见问题

- **首次请求慢**：模型懒加载，首个识别请求会加载模型（数十秒级），属预期；后续请求毫秒级。
- **上传未走 OCR**：依次确认 ①`PADDLEOCR_URL` 已在**平台进程**环境变量中（改后需重启平台）；②文本确实 <8 字符（可解析出文本的普通文件不会触发）；③`/health` 探测可达（`err_logs` 中 source=`kb-ocr` 的降级记录会给出原因）。
- **中文识别效果**：容器默认 `lang="ch"`（中英文模型）；纯英文文档可自行改 `lang="en"`。
- **安全**：服务仅监听容器端口，建议生产环境不对外网暴露 9300，仅平台进程内网可达（compose 端口已绑定 `127.0.0.1`，跨机部署改绑内网网卡 IP 并自行加访问控制）。
- **数据出网风险（V2.3 审查加固提示）**：OCR 识别会把**原始文件内容**（base64）发送到 `PADDLEOCR_URL` 指向的服务。若该地址配置为**公网第三方 OCR 服务**，上传的文档内容（可能含企业敏感数据）会出网——生产环境请仅配置本机/内网自建服务，禁用公网地址。

> AI生成
