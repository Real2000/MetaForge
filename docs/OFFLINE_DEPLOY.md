# 离线部署手册（信创环境：麒麟 Kylin / 统信 UOS）

> U2-1 / N7-P5 —— 面向无外网信创服务器的完全离线部署指引。
> 适用：ARM64/x86_64 的麒麟、统信等国产操作系统；生产/内网隔离环境。

## 一、总体流程

```
源机（可联网/有构建环境）                     目标机（内网，无外网）
  ① sh scripts/package-portable.sh   ──便携包.tar.gz──▶  ② 拷贝到目标机
                                                        ③ tar xzf 解压
                                                        ④ sh offline-install.sh（离线自检）
                                                        ⑤ sh start.sh
```

便携包内已含 **Node 运行时 + 全量 node_modules（含预编译原生模块）+ 应用代码**，
目标机**无需联网、无需 npm install、无需构建**即可启动。
仅当原生模块 ABI 与目标平台不匹配、且包内附带了 `npm-cache/` 时，才会用离线缓存 rebuild。

## 二、源机：构建便携包

```sh
# 在项目根目录执行
sh scripts/package-portable.sh
# 如需交叉打包目标平台（需备好目标平台 Node 二进制）
CROSS_PLATFORM=linux-x64 sh scripts/package-portable.sh
# 目标机缺少匹配的预编译二进制、需要离线 rebuild 时，附带 npm 离线缓存
INCLUDE_NPM_CACHE=1 sh scripts/package-portable.sh
```

输出：`dist/agent-platform-portable-<version>-<platform>-<arch>.tar.gz`

包内结构：

| 路径 | 说明 |
| --- | --- |
| `node/bin/node` | Node.js 运行时 |
| `app/` | 应用代码（`server.js`/`src-server`/`public`/`scripts`/`deploy`/`docs`） |
| `node_modules/` | 全量预编译依赖 |
| `npm-cache/` | （可选）npm 离线缓存，离线 rebuild 用 |
| `bin/litestream` | （可选）读写分离副本同步二进制 |
| `license.template.json` | 离线授权模板 |
| `start.sh` / `stop.sh` | 启停脚本 |
| `offline-install.sh` | 目标机离线安装与自检 |

> **原生模块平台匹配**：`better-sqlite3` 为原生模块，编译产物绑定「操作系统 × CPU 架构 × Node ABI」。
> 强烈建议**在目标同架构 Linux 上打包**，或确保包内二进制与目标平台一致；
> 否则需在目标机具备构建工具链（gcc/make/python3）时用 `npm-cache/` 离线 rebuild。

## 三、目标机：解压与安装

```sh
# 拷贝便携包到目标机（U 盘 / 内网传输均可）
tar xzf agent-platform-portable-*.tar.gz
cd agent-platform

# 离线安装自检（不联网）
sh offline-install.sh
```

`offline-install.sh` 依次检查并处理：
1. Node 运行时可用性；
2. `node_modules` 完整性；
3. `better-sqlite3` 原生模块 ABI（不匹配则尝试用 `npm-cache/` 离线 rebuild）；
4. `litestream` 是否随包/系统提供（可选）；
5. License 配置（可选，缺省运行社区版）。

自检通过后即可启动。

## 四、启动与停止

```sh
# 启动（默认端口 3210，数据目录 app/data）
PORT=3210 sh start.sh
# 停止
sh stop.sh
```

后台常驻（systemd，可选）：

```ini
# /etc/systemd/system/agent-platform.service
[Unit]
Description=Agent Platform
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/agent-platform/app
Environment=PORT=3210
Environment=AGENT_DATA_DIR=/opt/agent-platform/data
ExecStart=/opt/agent-platform/node/bin/node server.js
Restart=always
RestartSec=3
User=agent
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload && systemctl enable --now agent-platform
```

> 服务读取的数据目录环境变量是 **`AGENT_DATA_DIR`**（不是 `DATA_DIR`）；
> `start.sh` 已自动把 `DATA_DIR` 映射为 `AGENT_DATA_DIR`，自定义部署时请注意。

## 五、可选：读写分离（只读副本）

如需开启读写分离（降低主库读压力）：

```sh
# 1) 初始化只读副本（一致性快照）
AGENT_DATA_DIR=./app/data REPLICA_DIR=./replica sh app/scripts/replica-bootstrap.sh
# 2) 配置 litestream 持续同步（见 deploy/litestream.yml，替换实际路径）
# 3) 启动时指向副本
AGENT_DB_READONLY=./replica/platform.db PORT=3210 sh start.sh
```

- 仅「允许轻微延迟」的统计/看板查询走副本；写后立即读（强一致）仍走主库。
- 未设置 `AGENT_DB_READONLY` 时自动回退主库，行为与单库部署一致。

## 六、信创数据库（达梦 / 人大金仓）

平台支持切换到国产数据库：

```sh
export AGENT_DB_DRIVER=kingbase     # 或 dm
export SQL_DIALECT=kingbase         # 或 dm
export AGENT_DB_HOST=10.0.0.10
export AGENT_DB_PORT=54321
export AGENT_DB_USER=system
export AGENT_DB_PASSWORD=******
export AGENT_DB_NAME=agent_platform
```

- 金仓需安装 `pg` 依赖；达梦需安装 `dmdb` 依赖（未随包提供，需在目标机离线安装）。
- 默认 `AGENT_DB_DRIVER=sqlite` / `SQL_DIALECT=sqlite`，方言恒等转换，不影响现有部署。
- 方言适配覆盖：`datetime('now','localtime')`→`CURRENT_TIMESTAMP`、`AUTOINCREMENT`→`IDENTITY`/`SERIAL`、
  `INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`、`IFNULL`→`COALESCE` 等；未映射构造会显式告警，需人工确认。

## 七、常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动报 `NODE_MODULE_VERSION mismatch` / ABI 不兼容 | 原生模块与目标平台不匹配 | 目标同架构重新打包；或用 `npm-cache/` 离线 rebuild |
| `offline-install.sh` 报缺少构建工具 | 目标机无 gcc/make/python3 | 提供平台匹配的 prebuilt（目标同架构打包） |
| 调度任务在多节点重复触发 | 多进程未启用选主 | 设 `DEPLOY_MODE=cluster`（N7-P2 选主租约锁生效） |
| 长任务积压、内存队列跨进程不可见 | 多进程用内存队列 | 装 `bullmq`+`ioredis`，设 `QUEUE_DRIVER=redis` |
| 读数据滞后 | 读写分离副本同步延迟 | 强一致查询走主库；缩短 litestream `sync-interval` |

## 八、验证清单（部署后）

- [ ] `sh offline-install.sh` 自检通过（退出码 0）
- [ ] `sh start.sh` 后浏览器可访问 `http://<ip>:3210/`
- [ ] 默认账号登录成功（首次强制改密）
- [ ] 上传知识库文档、发起一次对话正常
- [ ] 多节点部署时：`WEB_CONCURRENCY`/PM2 下日志仅一个 leader 执行调度，无重复触发
- [ ] （可选）读写分离：横幅显示「读写分离: 启用」，统计页正常

> AI生成
