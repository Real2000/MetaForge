#!/bin/bash
# 智能体平台 - macOS/Linux 一键启动
# 双击运行时 GUI shell 不加载 nvm/homebrew 等初始化脚本，
# 因此这里自动探测 node 的常见安装位置。
cd "$(dirname "$0")"

echo "=============================================="
echo "  正在启动 智能体平台 ..."
echo "=============================================="

# ---- 探测 node ----
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

if [ ! -d node_modules ]; then
  echo "[1/2] 首次运行，安装依赖中..."
  npm install --no-audit --no-fund || { echo "依赖安装失败，请检查网络后重试"; read -p "按回车退出..."; exit 1; }
else
  echo "[1/2] 依赖已就绪"
fi

echo "[2/2] 启动服务..."
echo ""
echo "启动后将自动打开浏览器访问 http://localhost:3210"
echo "（关闭本窗口或按 Ctrl+C 即停止服务）"
echo ""
echo "  Docker 部署：docker compose up -d                 详见 docs/ 与根目录 Dockerfile"
echo "  Linux 部署：systemd 单元文件在 scripts/          详见 scripts/agent-platform.service"
echo ""./scripts/agent-platform.service"
echo ""
node server.js &
SERVER_PID=$!
sleep 2
# 尝试用系统默认浏览器打开
if command -v open >/dev/null 2>&1; then
  open "http://localhost:3210" 2>/dev/null
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:3210" 2>/dev/null
fi
wait $SERVER_PID
echo ""
read -p "服务已停止，按回车退出..."
