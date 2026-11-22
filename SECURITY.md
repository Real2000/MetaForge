# 安全政策（Security Policy）

## 支持的版本

项目处于活跃开发阶段，安全修复仅针对最新 `main` 分支及最新发布版本提供。请在 `main` 上复现问题后再行披露。

| 版本 | 是否支持安全更新 |
|---|---|
| 最新 `main` / 最新发布 | ✅ |
| 更早的历史提交 | ❌ |

## 报告漏洞（私下披露）

**请勿通过公开 Issue 披露安全漏洞。** 请选择以下任一私下渠道：

1. **GitHub 私密安全通告（推荐）**：仓库页面 → Security → Advisories → Report a vulnerability（Private vulnerability reporting）。
2. **邮件**：发送至 `security@example.com`（发布前请替换为项目实际安全联系邮箱）。

报告请尽量包含：

- 漏洞类型与影响（例如：越权访问、SSRF、SQL 注入、XSS、密钥泄露、鉴权绕过）。
- 受影响的版本 / 提交、复现步骤或最小验证样例、必要时的日志片段。
- 是否已在公开渠道泄露、是否愿意公开致谢。

> 请勿在报告中附带真实生产密钥、用户个人数据或内网地址；如需提供，请先做脱敏处理。

## 响应流程

- **48 小时内**确认收到报告并给出初步评估。
- **7 个工作日内**给出处置方案或进展说明。
- 修复后经你确认，在 `SECURITY.md` / 发布说明中对报告者致谢（若你同意）。

## 安全设计基线（供参考）

- 密钥与私钥不入库：`data/` 目录（含 `platform.db`、`secrets.json`）已被 `.gitignore` 排除，生产部署请显式设置 `AGENT_JWT_SECRET` 等环境变量。
- 敏感信息只在服务端处理；对外输入经敏感词检测、输出自动脱敏。敏感值（API Key、供应商密钥、SSO 密钥等）以 AES-256-GCM 加密落库；加密密钥 `ENCRYPTION_KEY` 缺失时写入 **fail-closed 拒绝**（不再静默明文落库），并提供存量明文巡检脚本 `scripts/scan-plaintext-secrets.js`。
- 数据库操作参数绑定，防 SQL 注入；用户输入展示转义，防 XSS。
- 网络出口具备 SSRF 防护：统一由 `src-server/lib/ssrf-guard.js` 实现（仅允许 http(s) + 字面量/解析后 IP 的私网、环回、链路本地、云元数据黑名单 + 重定向逐跳校验）。已接入点：工具 `web_fetch`、工作流 `http_request` 节点、用户自有模型源（`usermodels`）、平台模型供应商（`providers`）、SSO 端点（`sso`）、MCP 服务 URL（`mcp`）、向量/重排网关（`retriever`）。内网地址场景需管理员显式设 `AGENT_FETCH_ALLOW_PRIVATE=1` 放行。
- 会话安全：认证 Cookie（`ap_token`）为 HttpOnly + SameSite=Lax，生产环境强制 `Secure`；支持用户级令牌吊销（改密 / 管理员重置密码 / 停用账号即踢出该用户全部登录端）；按 IP 限流仅在配置受信代理（`AGENT_TRUST_PROXY`）后采信 `X-Forwarded-For`，默认直连以 TCP 源地址为准（防伪造 XFF 绕过爆破锁定）。
- 全局安全响应头：所有响应注入 `X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`；非分享页注入 `X-Frame-Options: SAMEORIGIN` 与 Report-Only CSP；生产启用 HSTS。
- 依赖全部为宽松许可（MIT / Apache-2.0 / BSD），无 GPL/AGPL 传染。

详见仓库内 [docs/开源就绪检查清单.md](docs/开源就绪检查清单.md) 与相关安全评估记录。

> AI生成
