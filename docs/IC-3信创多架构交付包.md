# MetaForge 信创多架构离线交付包（M11 · IC-3）

> 交付日期：2026-11-26　上游：XC-4 国产 OS/CPU 交叉构建打通（2026-11-25）
> 构建入口：`sh scripts/release-offline.sh`（产物落 `dist/`，sha256 全链校验）
> 配套手册：`docs/OFFLINE_DEPLOY.md`（目标机部署）· `docs/XC-4国产OS与CPU交叉构建.md`（loong64 路线）

## 一、交付物矩阵

| 产物（dist/） | 架构 | 用途 | 大小 | sha256 |
|---|---|---|---|---|
| `metaforge-1.0.0-linux-amd64.tar.gz` | x86_64 | Docker 镜像归档（`docker load -i`） | 138 MB | `73d0f636…8477804f` |
| `metaforge-1.0.0-linux-arm64.tar.gz` | arm64（鲲鹏/飞腾） | Docker 镜像归档 | 136 MB | `df48c0cb…ade15035` |
| `agent-platform-portable-1.0.0-linux-x86_64.tar.gz` | x86_64 | 便携包（零依赖解压即用） | 190 MB | `2888c361…db958828` |
| `agent-platform-portable-1.0.0-linux-arm64.tar.gz` | arm64 | 便携包 | 189 MB | `c2aaf8f7…dd0e0871` |

完整校验清单见 `dist/SHA256SUMS` 与 `dist/RELEASE_MANIFEST.md`（含提交号与构建信息）。

```text
c2aaf8f75ccd33c2ff4a73b6f85e65e53a38757dc7ad1826c92810c2dd0e0871  agent-platform-portable-1.0.0-linux-arm64.tar.gz
2888c3611a388bdaccf5c67229134eca9c90ef074539957370df8710db958828  agent-platform-portable-1.0.0-linux-x86_64.tar.gz
73d0f63677062a7e96e58b7b63327b5e5deb801adf336c3a0b54634e8477804f  metaforge-1.0.0-linux-amd64.tar.gz
df48c0cbdfef33a11ffc8c177f84319db639b2ab31404c3ee9ba8876ade15035  metaforge-1.0.0-linux-arm64.tar.gz
```

## 二、构建链（release-offline.sh 四步）

1. **buildx 双架构构建**（linux/amd64 + linux/arm64，QEMU binfmt 交叉——XC-4 打通的能力兑现）；
2. **镜像导出**：`docker save | gzip -9`（目标机 `docker load -i` 即用）；
3. **真交叉便携包组装**（本任务核心修复）：
   - 从**各架构镜像内**提取 node 运行时（`/usr/local/bin/node`）与 `node_modules`
     （builder 阶段在目标架构内 `npm install`，better-sqlite3 等原生模块按架构预编译）；
   - `NODE_BIN_SRC/NODE_MODULES_SRC` 注入 `package-portable.sh` 组装——
     **不再是「宿主二进制改个名」**（原脚本 `cp $(command -v node)` 只对宿主有效，
     交叉打包会产生架构错误的假包）；
4. **sha256 清单 + 发布清单**（macOS `shasum` / Linux `sha256sum` 双环境）。

增量复用：`SKIP_IMAGES=1 sh scripts/release-offline.sh` 可只重组便携包（镜像已构建时）。

## 三、验证记录（导出导入演练，2026-11-26 实跑）

| # | 验证项 | 结果 |
|---|---|---|
| ① | amd64 镜像导入 + 起服 | `docker load` ✓ → 容器起服 → **health OK（3s）** → 清理 ✓ |
| ② | arm64 镜像导入 + 架构校验 | `Architecture=arm64 OS=linux` ✓ |
| ③ | arm64 运行时（QEMU 模拟） | `node -e` → **arm64 v18.20.8** ✓；整服起服 **health OK（16s）** ✓（强于预期——实机验证仍归 IC-5） |
| ④ | 便携包结构 | 两包各 15605 条目；`node/bin/node`（构建日志：ELF x86-64 / ELF ARM aarch64）、`start.sh`/`offline-install.sh`/`version.txt`/`app/server.js` 全在位 |
| ⑤ | x86_64 便携包**真离线**自检 | 容器内 `--network none` 执行 `offline-install.sh`：**5/5 通过**——node v18.20.8、node_modules 完整、**better-sqlite3 ABI 可用（linux-x64）**、litestream/license 可选跳过 |

## 四、目标机落地

```sh
# 镜像路径（二选一）
sha256sum -c SHA256SUMS                      # 先校验
docker load -i metaforge-1.0.0-linux-<arch>.tar.gz
docker run -d --name metaforge -p 3210:3210 -v /opt/metaforge/data:/app/data metaforge:1.0.0-<arch>

# 便携包路径
sha256sum -c SHA256SUMS && tar xzf agent-platform-portable-1.0.0-linux-<arch>.tar.gz
cd agent-platform && sh offline-install.sh && PORT=3210 sh start.sh
```

## 五、边界与后续

- 麒麟/统信 **ARM64 实机**上的完整链路（登录/知识库/对话/租户）归 **IC-5 交付演练**（目标机到位即执行；
  本任务已在 QEMU 下完成 health 级验证兜底）；
- **loong64（龙芯）** 无本地构建/模拟能力，归 **IC-4 实机构建**（路线见 XC-4 文档 §三）；
- 镜像/便携包内容与当前提交同步构建（见 RELEASE_MANIFEST 的 commit 字段）；后续代码变更需重跑
  `sh scripts/release-offline.sh` 重新出包。

> AI生成