# 贡献指南（Contributing）

感谢你关注并愿意为 **智能体开发平台** 贡献力量！本文档说明参与协作的方式与工程约定。

## 行为准则

- 尊重、友善、就事论事，聚焦技术问题本身。
- 不提交任何真实密钥、口令、内网地址或用户隐私数据。
- 提交内容需为原创或已获授权，且与 Apache-2.0 许可兼容。

## 开发环境准备

```bash
# 要求 Node.js >= 18
node -v
npm ci          # 按 lockfile 精确安装依赖
npm test        # 冒烟测试（自研 TAP 风格，隔离在 .temp/test-data-* 临时目录）
npm start       # 本地启动，默认 http://127.0.0.1:3210
```

- 依赖零全局污染：所有测试数据写入 `.temp/`，运行结束自动清理。
- 验证请使用临时实例与临时数据目录，**切勿**用真实生产库：`AGENT_DATA_DIR=.temp/dev PORT=5680 node server.js`。

## 分支与提交规范

- 从 `main` 拉出特性分支：`feat/xxx`、`fix/xxx`、`docs/xxx`、`refactor/xxx`。
- 提交信息采用 `type(scope): 描述` 形式，描述用中文、简洁说明「为什么」：

  ```
  feat(channel): U0-1 公众号被动回复与客服接口
  fix(db): 集群多进程下迁移重复列报错幂等处理
  docs(readme): 开源 README 内网地址脱敏
  ```

  常用 `type`：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf`。

## 提交前自检（强制）

1. **`npm test` 必须全绿**，失败数为 0——这是本项目的验收红线，基线只增不减。
2. 新增功能请补充对应的冒烟/断言用例（`test/smoke.js` 内按模块分区追加）。
3. 不引入新的运行时依赖，除非确有必要并已确认许可为宽松许可（MIT / Apache-2.0 / BSD）。
4. 若改动了 `public/js`、`public/css`、`public/vendor`、`public/sw.js` 或 `index.html`，必须同步 bump `public/sw.js` 的 `SW_VERSION`。
5. 敏感信息不入库：密钥、口令、私钥、内网地址一律用环境变量或占位符。

## 提交 Pull Request

1. 确保分支基于最新 `main`，且工作区干净。
2. 在 PR 描述中说明：改动目的、影响范围、验证方式（贴 `npm test` 结果）。
3. 关联相关 Issue；如为破坏性变更，请在描述中显著标注。
4. 维护者会审查代码质量、安全性与测试覆盖；评审通过且 CI 全绿后合并。

## 代码风格

- 后端 Node.js / Express，CommonJS；前端原生 JS + 本地化静态资源（零外部请求）。
- 命名清晰、避免硬编码；数据库操作一律参数绑定（防注入）；用户输入输出注意转义（防 XSS）。
- 注释说明「为什么」，不堆砌显而易见的「是什么」。

## 报告问题

- 功能缺陷与建议请走 GitHub Issues，尽量附：版本、复现步骤、期望与实际、日志片段。
- 安全漏洞**请勿**公开提 Issue，改按 [SECURITY.md](SECURITY.md) 的私下披露流程。

## 许可证

本项目采用 [Apache-2.0](LICENSE)。你提交的贡献将以同一许可发布，请确认你有权这样做。

> AI生成
