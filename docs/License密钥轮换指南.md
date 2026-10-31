# License 密钥轮换指南

> 适用版本：V2.3（2026-10-31）｜相关代码：`src-server/lib/edition.js`（验签）、`scripts/issue-license.js`（签发）、`scripts/verify-license.js`（自检）、`POST /api/edition/reload`（热重载）

## 一、为什么要轮换（轮换动机）

`src-server/lib/edition.js` 内置的 `PUBLIC_KEY_HEX` 当前为**开发/联调测试钥**：

- 测试钥随源码分发，任何拿到源码的人都能用配套签发流程**自签出合法 License**，解锁专业版/企业版全部特性——商业授权体系在私有化交付场景下形同虚设；
- 一旦测试私钥意外泄露（早期调试机、备份、聊天记录截图），风险等同「公开的万能钥匙」，必须视为已泄露处理；
- 生产交付前替换为专用钥，是 License 体系上线的前置条件（对标 MaxKB 专业版买断授权的交付基线）。

## 二、轮换步骤

> 前提：准备一台**签发机**（保存新私钥，与部署机物理/逻辑隔离）与目标**部署机**。全程零第三方依赖，仅需 Node.js。

### ① 签发机：生成新钥并签发 License

```bash
# 首次执行时自动生成 Ed25519 密钥对：私钥写入 --private-key 指定路径（权限 600），公钥 hex 打印到 stderr
node scripts/issue-license.js --private-key ./prod-license.key \
  --customer "客户公司名称" --edition professional --days 365 --out ./license.json
```

控制台会打印类似输出，**抄下公钥 hex**（64 个十六进制字符）：

```
🔑 已生成新密钥对：./prod-license.key（新建文件已设 600 权限，请妥善保管，绝不提交仓库/上传服务器）
   公钥 hex（请更新到 src-server/lib/edition.js 的 PUBLIC_KEY_HEX，或部署机设环境变量 LICENSE_PUBKEY_HEX）：
   3bf4c8…（完整 64 位）
```

> 若已有私钥只想补签 License：同一 `--private-key` 路径复用即可，不会再生成新钥。

### ② 部署机：替换公钥（两种方式二选一）

| 方式 | 操作 | 适用场景 |
| --- | --- | --- |
| A. 改代码常量 | 修改 `src-server/lib/edition.js` 顶部 `PUBLIC_KEY_HEX` 为新 hex | 常规发版交付（公钥随代码走，可审计、可追溯） |
| B. 环境变量 | 部署机设置 `LICENSE_PUBKEY_HEX=<新hex>` 后重启 | 应急轮换/无法发版时（**仅限过渡期**，见第五节安全提醒） |

### ③ 生效方式（免重启热重载或重启）

将新签发的 `license.json` 放到部署机数据目录（默认 `data/license.json`），然后：

> ⚠️ **原子替换（V2.3 审查加固 S3-4）**：请用 `mv` 或「写临时文件后 rename」替换，不要直接 `cp`/`>` 覆盖——
> 直接覆盖过程中恰好触发 reload 或 24h 定时器重读时，可能读到半截 JSON 瞬时降级（可自愈但会造成误报工单）。

```bash
# 方式一：热重载（推荐，V2.3 Y7 新增——License 文件替换后免重启进程生效）
curl -X POST http://<部署机>:3210/api/edition/reload \
  -H "Authorization: Bearer <管理员token>"

# 方式二：重启服务进程（传统方式，等效）
```

`POST /api/edition/reload` 仅管理员可调用，会写 `op_logs` 审计（action=`License热重载`，detail 记录重载后版本与到期/降级原因）。

### ④ 自检（上线前必做）

```bash
# 显式指定新公钥验证签名链路（最稳：不依赖部署机当前生效的是哪把公钥）
node scripts/verify-license.js --file data/license.json --pubkey <新hex>

# 也可省略 --pubkey，走部署机当前配置（内置常量或环境变量）
node scripts/verify-license.js --file data/license.json
```

有效输出示例（退出码 0）：

```
✅ 专业版，客户 客户公司名称，到期 2027-10-31，剩余 365 天
```

无效输出示例（退出码 1，部署将降级为社区版）：

```
❌ License 无效（部署将降级为社区版）——降级原因：验签失败（内容被篡改或公钥不匹配）
```

退出码约定：**0 = 有效 / 1 = 无效**，可直接串联进部署脚本（`node scripts/verify-license.js --file ... --pubkey ... && <重启/热重载动作>`，自检不过不继续上线）。

热重载生效后再查一次版本快照确认（管理员可见完整字段）：

```bash
curl http://<部署机>:3210/api/edition -H "Authorization: Bearer <管理员token>"
```

## 三、旧 License 收敛策略

- 轮换后**旧钥签发、仍在有效期内的 License 会验签失败**（公钥已换，`badsig` 降级社区版）——需要为客户重签新 License 再替换文件。注意：**运行中的进程持有启动时刻（或上次 reload 时）的验签缓存**，公钥替换后须重启或 `POST /api/edition/reload` 才会重新验签（V2.3 审查加固 P2-6：原文「立即验签失败」仅在已完成生效动作的语境下成立）；
- 存量客户如果暂不替换：旧 License 在**旧公钥下继续有效直到自然到期**；若公钥已整体切换为新钥，则旧 License 直接降级，请按新钥统一重签；
- 已过期的旧 License 无需处理（`expired` 降级，到期日当天仍有效、次日起失效）；
- 重签时保持 `customer` 不变可延续客户标识，`issued_at/expires_at/license_key` 按新签发时间重新生成。

## 四、时钟要求（F2：到期判断依赖本地日期）

License 的到期判断使用**部署机本地日期**（`'YYYY-MM-DD'` 字符串比较，到期日当天仍有效）。因此：

- 部署机**必须启用 NTP 时间同步**（`chronyd` 或 `ntpd`），禁止长期手动改钟；
- **时钟回拨风险**：
  - 本地时间被拨到过去 → 已过期 License 可能**复活**（`expires_at < 今天` 判定失效，越过期线）；
  - 本地时间被拨到未来 → 未过期 License 可能**提前失效**（误判已过期，降级社区版）；
- 排查「License 明明没到期却被降级」类工单时，第一步先核对部署机系统时间与 NTP 状态（`timedatectl` / `chronyc tracking`）。

## 五、安全提醒

1. **生产部署机禁设 `LICENSE_PUBKEY_HEX` 环境变量**：该口子等价于「拿到 shell 权限即可自签 License 解锁全部特性」，代码在检测到该变量时会 `console.warn` 告警（留审计痕迹）。它只应出现在签发机/联调环境的轮换过渡期，正式部署一律走「改 `PUBLIC_KEY_HEX` 常量 + 发版」；
2. **私钥绝不入库/仓库/服务器**：签发私钥只存在签发机（`issue-license.js` 已设 600 权限），不得提交 Git、不得上传部署机、不得写入任何备份/网盘/聊天工具；泄露即视为需要立即再次轮换；
3. 签发机与部署机分离，签发机建议全盘加密 + 最小授权访问；
4. 轮换完成后，旧私钥文件在签发机上归档或销毁由安全策略决定——保留期间等同于现役私钥对待；
5. `GET /api/edition` 对普通用户已做字段脱敏（不含客户名/到期日/License 编号），防止授权商业信息被普通用户探测。

> AI生成
