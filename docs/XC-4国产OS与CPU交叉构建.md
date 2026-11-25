# XC-4 · 国产 OS × CPU 交叉构建方案（2026-11-25，第十轮）

> 验收对照（V1.1 计划表 XC-4）：「ARM64 构建链实测通过 ✅（§二）；LoongArch 构建方案文档定稿 ✅（§三）；
> 离线部署文档更新 ✅（§五）」。
> 本轮附带修复：Dockerfile `COPY docs/` 与 .dockerignore 自相矛盾（普通构建亦必炸的遗留 bug，
> XC-4 首轮构建实锤暴露）——运行时对 docs/ 零依赖（源码内引用均为注释），已移除。

## 一、原生依赖矩阵与多架构现状

| 依赖 | x86_64 | linux/arm64 | loong64 |
|---|---|---|---|
| better-sqlite3 | 官方 prebuilt ✓ | 官方 prebuilt ✓（回退源码编译 ✓） | **无官方 prebuilt → 源码编译必经**（loong64 工具链） |
| pg | 纯 JS ✓ | 纯 JS ✓ | 纯 JS ✓ |
| Node 运行时 | 官方 ✓ | 官方 node:18-slim ✓ | **官方无镜像** → 龙芯开源档案馆 node loong64 构建 |
| buildx QEMU 模拟 | — | Docker Desktop binfmt 内置 ✓（本轮实测） | **本机不可模拟**（binfmt 无 loong64） |

## 二、ARM64 交叉构建实测（鲲鹏/飞腾同类架构）

**环境**：x64 Mac（Docker Desktop 29.7.2 + buildx v0.36.0，QEMU binfmt 内置 linux/arm64）。

**构建命令**（项目根目录）：
```sh
docker buildx build --platform linux/arm64 -t metaforge:arm64 --load .
```
- 多阶段 Dockerfile：builder（node:18-slim + build-essential）内 npm install 于 ARM64 模拟环境执行，
  better-sqlite3 prebuilt 命中 arm64 即直装，未命中自动源码编译（QEMU 下约 3~5 倍耗时）；
- 运行时层仅 curl/sqlite3/ca-certificates，无原生编译点。

**产物验证三步**：
1. `docker image inspect` 确认 Architecture=arm64；
2. 模拟启动：`docker run --rm --platform linux/arm64 metaforge:xc4-arm64 node -e "require('better-sqlite3'); console.log(process.arch)"`
   ——require 通过 + `arch='arm64'`（原生模块 ABI 匹配的最终证据）；
3. 完整链：容器起服务 + `/api/health` OK。

实测结果见 §六（构建日志与验证记录）；镜像可 `docker save` 为 tar 离线导出，与
OFFLINE_DEPLOY.md 便携包路径并行（容器交付 vs 裸机便携包，按客户环境二选一）。

## 三、LoongArch（龙芯）构建方案（定稿）

### 3.1 约束与结论

- **本机（x64 Mac）不可模拟**：Docker Desktop 内置 binfmt 平台清单为 linux/amd64·arm64·arm·
  ppc64le 等，**不含 linux/loong64**；Node 官方亦无 loong64 镜像——任何「纯 x64 虚拟化」路线在
  本机不可行（区别于 ARM64 路线）。
- **可行路径为三类**，按推荐序：

### 3.2 路线一（推荐·首选）：龙芯实机构建

```
龙芯服务器（3A5000/3C5000，loongnix / 麒麟 LoongArch）
  └─ docker build -t metaforge:loong64 .     # Dockerfile 本身架构无关（XC-4 实测验证）
```
- 基础镜像替换：`FROM node:18-slim` → 龙芯维护镜像（`lcr.loongnix.cn` / 龙芯官方 Docker Hub
  镜像源的 node loong64 变体；无则改用龙芯档案馆 Node 二进制 + 基础 Debian loong64 镜像自建）；
- **better-sqlite3 必须源码编译**（无 loong64 prebuilt）：builder 阶段需 loongarch64 gcc ≥ 8 /
  make / python3（loongnix 的 build-essential 原生提供，node-gyp 直接可用）；
- Node loong64 运行时：龙芯开源档案馆 mirrors.loongnix.org/web/node/ 提供 Node 18/20 的
  loong64 构建（`process.arch === 'loong64'`）；
- 验收口径：实机容器启动 + `/api/health` OK + `require('better-sqlite3')` 通过 + 核心链路 e2e。

### 3.3 路线二（备选·CI 兜底）：第三方 binfmt 交叉构建

在 **x86_64 Linux 主机**（非 macOS）注册 loongarch64 binfmt：
```sh
# QEMU ≥ 8.1 含 loongarch64-linux-user；社区 binfmt 镜像或自编译 qemu-static
docker run --privileged --rm <loong64-binfmt-image> --install loongarch64
docker buildx build --platform linux/loong64 --load .
```
- 适用：客户无龙芯实机但需提前产出镜像做适配评估；
- 风险：模拟编译耗时约 3~5 倍；基础镜像与 loong64 Node 二进制仍需龙芯源（同路线一）；
- CI 建议：GitLab/Jenkins 自托管 runner 上做 nightly，模拟构建仅验证编译可行性，
  **发布产物仍以路线一实机构建为准**（模拟环境不做性能与发布基线）。

### 3.4 路线三（并行·裸机）：便携包路径扩展（OFFLINE_DEPLOY.md 既有机制）

`scripts/package-portable.sh` 已支持 `CROSS_PLATFORM` 预编译形态，扩展点：
- 准备 loong64 Node 二进制（龙芯档案馆）→ 源机 `CROSS_PLATFORM=linux-loong64` 打包；
- better-sqlite3 loong64 产物：源机交叉工具链（loongarch64-linux-gnu-gcc）npm rebuild，
  或目标机附 `INCLUDE_NPM_CACHE=1` 离线缓存首次启动时 rebuild；
- 适用：客户拒绝容器化、要求裸机 systemd 部署的场景（与 OFFLINE_DEPLOY.md §一流程同构）。

### 3.5 待客户环境确认项（联调收口清单）

1. 目标机 LoongArch 发行版与版本（loongnix / 麒麟 V10 LoongArch / 统信——影响工具链与镜像源）；
2. 容器化 vs 裸机的部署形态选择（决定路线一/三）；
3. 龙芯源可达性（内网环境需镜像同步 lcr.loongnix.cn 与 npm 离线缓存）；
4. 性能基线：better-sqlite3 在 3A5000 的检索压测（衔接 OPS-1 基线口径，复测 P0 指标）。

## 四、Dockerfile 修复记录（XC-4 附带产出）

- 原第 40 行 `COPY package.json server.js src-server/ public/ docs/ scripts/ ./` 与
  .dockerignore 的 `docs/` 排除项自相矛盾——任何平台构建在 checksum 阶段必炸
  （`failed to calculate checksum: "/docs": not found`，XC-4 首轮实锤）；
- 运行时对 docs/ 零依赖（grep 实证：源码内 docs/ 引用全部为注释）；
- 修复：COPY 移除 docs/（顺应「文档不入生产镜像」既定决策），普通与交叉构建同修。

## 五、OFFLINE_DEPLOY.md 增补（见该文档「多架构矩阵」节）

| 架构 | 便携包路径 | 容器路径 | 状态 |
|---|---|---|---|
| linux/x86_64 | package-portable.sh ✓ | docker build ✓ | 既有可用 |
| linux/arm64（鲲鹏/飞腾） | CROSS_PLATFORM 预编译 ✓ | **buildx 交叉 ✓（本轮实测）** | 本轮打通 |
| loong64（龙芯） | 待扩展（§3.4） | 待实机（§3.2） | 方案定稿，待客户环境 |

## 六、实测记录（ARM64，2026-11-25）

| 步骤 | 结果 |
|---|---|
| buildx 交叉构建 `--platform linux/arm64 --load` | ✅（builder 层 ARM64 模拟环境 npm install：better-sqlite3 prebuilt 命中 arm64） |
| 镜像架构 | ✅ Architecture=arm64 / Os=linux（143MB） |
| 原生模块 ABI（QEMU 模拟运行） | ✅ `require('better-sqlite3')` 建/插/读通过，`process.arch='arm64'`；pg 加载 OK |
| 完整服务链（修复 COPY 路径后第三轮） | ✅ **145/145 迁移** ARM64 环境跑完 → `MetaForge 智能体平台已启动` → `/api/health` {"ok":true} + 健康监控在线 |
| 镜像留档 | `metaforge:xc4-arm64`（docker save 可离线导出交付目标机） |

构建过程实锤两个 Dockerfile 历史遗留 bug（见 §四）：首轮 `docs/ COPY 与 .dockerignore 矛盾`；
次轮 `COPY 目录摊平语义——src-server/ 内容落 /app 根（项目早期布局的残留，src-server/ 化重构
后从未同步，此 Dockerfile 也从未成功构建过）`。修复后同 Dockerfile 双平台可用
（x86 直接 build / arm64 buildx 交叉）。

> AI生成
