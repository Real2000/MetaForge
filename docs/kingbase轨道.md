# kingbase CI 轨道（M11 · IC-1）

> 交付日期：2026-11-26（M11）　上游：XC-1 kingbase V9R1C10 全链实测（2026-11-25）
> 决策依据：D-10「容器即用即删」——镜像常驻 Docker 本地磁盘（766MB，一次性导入），
> 容器按需冷启动（实测 ~45s）、用完即删，1 分钟固定成本由 `npm run test:tenant:kingbase` 工程化消化。

## 一、定位与验收

- 把 XC-1 演练资产转为**正式 CI 轨道**：kingbase（PG12 系协议，pg 驱动/同步桥同款）纳入日常回归；
- 验收标准（V1.2 计划表 IC-1）：**kingbase 轨道 e2e 29/29 纳入日常回归；一键可跑** ✅。

## 二、前置条件

1. Docker Desktop 运行中；
2. kingbase 镜像已导入（仅需一次，镜像常驻本地磁盘）：

```bash
docker load -i kingbase_v009r001c010b0004_single_x86.tar   # 官方 V9R1C10 单机版 Docker 镜像
docker images | grep kingbase
# kingbase_v009r001c010b0004_single_x86:v1   1.56GB（压缩 766MB）
```

## 三、一键运行

```bash
npm run test:tenant:kingbase
```

内部流程（`scripts/kingbase-track.js` 编排）：

| 步骤 | 动作 | 说明 |
|---|---|---|
| 1 | 前置检查 | 镜像在本地 + 端口 54321 未被占 + 清理同名残留容器 |
| 2 | 拉起容器 | `docker run -d --privileged=true -e DB_MODE=pg -e DB_USER=system -e DB_PASSWORD=… -p 54321:54321 <镜像>`（**必须 --privileged**，差异 #6；**密码必须经 DB_PASSWORD 注入**——镜像缺省为内部 default_pass，不注入则连接约定必然失败，见 §六） |
| 3 | 就绪等待 | admin 连接轮询（冷启动 ~45s，上限 120s） |
| 4 | 轨道复位 | `scripts/kingbase-track-reset.js`：角色/库/schema 冷启动（见 §四 差异适配） |
| 5 | tenant-e2e | `AGENT_DB_DRIVER=pg PG_CONN=<kingbase 54321> DB_DIALECT=kingbase node test/tenant-e2e.js` |
| 6 | 即用即删 | `docker rm -f kingbase-track`（**finally 保证：成功/失败/异常都删**） |

预期输出尾部：`结果：29 通过 / 0 失败`，退出码 0；容器已清理。

## 四、与 PG16 轨道的差异适配（仅一处）

| 项 | PG16 轨道（mt7-poc-pg） | kingbase 轨道（kingbase-track） |
|---|---|---|
| public schema 冷启动 | 库 owner（pg_database_owner）= mt7_app 可自建 | **PG12 系 public 归超户，库主无权 DROP**——由管理端 `DROP SCHEMA` + `CREATE SCHEMA public AUTHORIZATION mt7_app`（reset 脚本内建） |
| 端口 | 5432 | 54321（容器内同为 54321） |
| 超户 | postgres / postgres | system / Mt7kingbase2026 |
| 其余（建表/迁移/RLS/驱动/桥） | — | **零差异**（XC-1 全链实测；8 项差异清单见 `docs/XC-1kingbase实测差异清单.md`） |

连接参数可用环境变量覆盖：`KB_IMAGE / KB_CONTAINER / KB_PORT / KB_ADMIN_CONN / KB_E2E_CONN`。

## 五、诊断工具（独立，不纳入轨道）

```bash
# 前置：kingbase-track 容器已手动起（或临时保留）
node scripts/kingbase-rls-probe.js
```

八项 RLS 行为探针（superuser 旁路 / FORCE owner 受控 / 回退 '0' / SET LOCAL 注入 / 跨租户互不可见 /
WITH CHECK 写拦截 / 本租户写放行 / 事务复位）。⚠️ 探针会 **DROP 并重建 mt7_app 角色与本表**（自清理
语义，XC-1 同款）——运行后如需跑 e2e，先重跑 `kingbase-track-reset.js`。任一项失败退出码 1。

## 六、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `镜像 ... 不在本地` | 未导入 tar | `docker load -i kingbase_v009r001c010b0004_single_x86.tar` |
| `pam_open_session: Permission denied` 循环失败 | 缺 `--privileged=true` | 用轨道脚本（已内建），勿手工 `docker run` 裸起 |
| `端口 54321 被容器 X 占用` | 残留容器/他栈占用 | `docker rm -f X` 或 `KB_PORT` 换端口 |
| 就绪超时（120s） | 容器启动失败 | `docker logs kingbase-track` 查看；确认 Docker Desktop 资源充足 |
| 就绪超时 / `password authentication failed` | 容器未注入 `DB_PASSWORD`（镜像密码缺省为内部 default_pass，与 reset/probe 的 system/Mt7kingbase2026 约定不符——IC-1 首跑踩坑） | 用轨道脚本（已从 `KB_ADMIN_CONN` 派生注入）；手工 `docker run` 时带 `-e DB_USER=system -e DB_PASSWORD=…` |
| 硬杀进程后容器残留 | finally 未执行 | `docker rm -f kingbase-track`（脚本下次运行也会自动清理残留） |

## 七、资产清单

| 文件 | 角色 |
|---|---|
| `scripts/kingbase-track.js` | 轨道编排（起容器/就绪/复位/e2e/即删） |
| `scripts/kingbase-track-reset.js` | 轨道复位（角色/库/public schema 冷启动，差异 #2 适配点） |
| `scripts/kingbase-rls-probe.js` | 八项 RLS 行为探针（诊断，独立运行） |
| `package.json` → `test:tenant:kingbase` | 一键入口 |
| `test/smoke.js`（IC-1 守卫组） | 静态/行为锚点：privileged、DB_MODE=pg、finally 清理、ENABLE+FORCE 双语句等 |

## 八、验收记录

| 时间 | 内容 | 结果 |
|---|---|---|
| 2026-11-25 | XC-1 演练（同一资产前身 .temp 形态） | 全链零适配 + tenant-e2e **29/29** + RLS 探针 8/8 |
| 2026-11-26 | IC-1 转正后轨道复跑（首跑踩坑 DB_PASSWORD 未注入 → 修复后复跑） | **29/29 全绿（退出码 0，总耗时 19.7s）**；容器即用即删 ✓ |

> AI生成