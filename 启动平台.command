#!/bin/bash
# MetaForge - macOS 一键启动（可靠版，2026-11-12 修复）
# 修复内容：
#   ① 原脚本存在未闭合引号的语法错误（echo ""/scripts/...），
#      bash 解析直接失败——node server.js 与自动开浏览器的代码从未执行
#   ② 原先 node server.js & + wait 模式：关闭终端窗口后服务易被 SIGHUP 连带终止
# 现在的行为：
#   - 平台已在运行 → 直接打开浏览器，不重复启动
#   - 未运行 → nohup 常驻启动（关闭本窗口不影响服务），
#     健康检查通过后自动打开浏览器
#   - 启动失败 → 展示日志尾部并保留窗口，便于排查
cd "$(dirname "$0")"

PORT=3210
URL="http://localhost:${PORT}"
LOG_DIR="logs"
LOG_FILE="${LOG_DIR}/server.log"

echo "=============================================="
echo "  正在启动 MetaForge ..."
echo "=============================================="

# ---- 0. 已在运行则直接打开浏览器（不重复启动）----
if lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
  echo "[i] 检测到平台已在运行（端口 ${PORT}），直接打开浏览器"
  echo "    如需重新加载最新代码：先双击「停止平台.command」，再双击本脚本"
  command -v open >/dev/null 2>&1 && open "${URL}" 2>/dev/null
  sleep 2
  exit 0
fi

# ---- 1. 探测 node ----
# 双击运行时 GUI shell 不加载 nvm/homebrew 等初始化脚本，
# 因此这里自动探测 node 的常见安装位置。
if ! command -v node >/dev/null 2>&1; then
  FOUND=""
  # 常见安装位置按优先级探测（必须在当前 shell 中 export PATH）
  for CAND in \
    "$HOME/.local/share/TeleAgent/runtimes/node/bin" \
    /opt/homebrew/bin \
    /usr/local/bin \
    "$HOME/.volta/bin" \
    "$HOME/Library/pnpm"
  do
    if [ -x "$CAND/node" ]; then
      export PATH="$CAND:$PATH"
      FOUND="$CAND"
      break
    fi
  done
  # nvm 多版本目录（取最新已安装版本）
  if [ -z "$FOUND" ] && [ -d "$HOME/.nvm/versions/node" ]; then
    for V in "$HOME"/.nvm/versions/node/*/bin; do
      if [ -x "$V/node" ]; then
        export PATH="$V:$PATH"
        FOUND="$V"
        break
      fi
    done
  fi
  if [ -n "$FOUND" ]; then
    echo "[i] 已自动定位 Node: $FOUND"
  else
    echo ""
    echo "[错误] 未找到 Node.js 运行环境。"
    echo ""
    echo "请先安装 Node.js（≥ 18），任选其一："
    echo "  1) 官网下载: https://nodejs.org/zh-cn （推荐 LTS 版本）"
    echo "  2) Homebrew:  brew install node"
    echo "  3) nvm:       curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash && nvm install --lts"
    echo ""
    echo "安装完成后重新双击本脚本即可。"
    read -p "按回车退出..."
    exit 1
  fi
fi

echo "Node 版本: $(node -v)"

# ---- 2. 依赖检查 ----
if [ ! -d node_modules ]; then
  echo "[1/3] 首次运行，安装依赖中..."
  npm install --no-audit --no-fund || { echo "依赖安装失败，请检查网络后重试"; read -p "按回车退出..."; exit 1; }
else
  echo "[1/3] 依赖已就绪"
fi

# ---- 3a. 数据库切换点（PG-4，2026-11-24）：存在 db.env 则加载 ----
# 用途：sqlite→PG 切换（AGENT_DB_DRIVER=pg + PG_CONN）零编辑脚本——
#   切换：创建 db.env（模板见 docs/PG切换runbook.md）；回滚：删除 db.env。
# 无 db.env 时行为不变（缺省 sqlite，生产零影响）。set -a 使变量随 nohup 传给 node。
if [ -f "db.env" ]; then
  set -a; . "db.env"; set +a
  echo "[i] 已加载数据库配置 db.env（AGENT_DB_DRIVER=${AGENT_DB_DRIVER:-sqlite}）"
fi

# ---- 3. 常驻启动（nohup：关闭窗口服务不停止；日志落盘）----
echo "[2/3] 启动服务…（常驻后台，关闭本窗口不影响运行）"
echo "      Docker 部署：docker compose up -d（详见 docs/ 与根目录 Dockerfile）"
echo "      Linux 部署：systemd 单元（详见 scripts/agent-platform.service）"
mkdir -p "$LOG_DIR"
nohup node server.js >>"$LOG_FILE" 2>&1 &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true

# ---- 4. 健康检查通过后自动打开浏览器 ----
echo "[3/3] 等待服务就绪（最长 40 秒）…"
OK=""
for i in $(seq 1 40); do
  if curl -sf -m 2 "${URL}/api/health" >/dev/null 2>&1; then OK="1"; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi   # 进程夭折则提前失败
  sleep 1
done

if [ -n "$OK" ]; then
  echo ""
  echo "✅ 平台已启动：${URL}（进程 ${SERVER_PID}）"
  echo "   浏览器即将自动打开；若未打开请手动访问上述地址"
  echo "   运行日志：${LOG_FILE}（滚动追加，可随时查看）"
  echo "   停止服务：双击「停止平台.command」"
  command -v open >/dev/null 2>&1 && open "${URL}" 2>/dev/null
  sleep 3
  exit 0
else
  echo ""
  echo "❌ 服务启动失败，最近日志（${LOG_FILE}）如下："
  echo "----------------------------------------"
  tail -n 25 "$LOG_FILE" 2>/dev/null
  echo "----------------------------------------"
  echo "常见原因：依赖损坏（试试 rm -rf node_modules 后重跑）/ 数据库被锁 / 端口被其他程序占用"
  read -p "按回车退出..."
  exit 1
fi
