#!/bin/bash
# 智能体平台 - 停止服务（2026-11-12，与「启动平台.command」配套）
# 安全设计：按端口定位 → 校验进程命令行包含 server.js 才停止；
#           其他程序占用 3210 端口时只提示、不误杀
cd "$(dirname "$0")"

PORT=3210

PIDS="$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u)"
if [ -z "$PIDS" ]; then
  echo "[i] 平台当前未在运行（端口 ${PORT} 无监听）"
  sleep 2
  exit 0
fi

echo "正在停止智能体平台…"
for PID in $PIDS; do
  CMD="$(ps -p "${PID}" -o command= 2>/dev/null)"
  case "$CMD" in
    *server.js*)
      kill "${PID}" 2>/dev/null
      echo "  已发送停止信号 → PID ${PID}"
      ;;
    *)
      echo "  跳过 PID ${PID}（不是平台进程）：${CMD}"
      ;;
  esac
done

# 等待优雅退出，超时才强制
sleep 3
for PID in $PIDS; do
  CMD="$(ps -p "${PID}" -o command= 2>/dev/null)"
  if kill -0 "${PID}" 2>/dev/null && [ -n "$CMD" ] && case "$CMD" in *server.js*) true;; *) false;; esac; then
    kill -9 "${PID}" 2>/dev/null
    echo "  强制停止 PID ${PID}"
  fi
done

if lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
  echo "⚠️ 端口 ${PORT} 仍被占用，请查看上方提示确认占用进程"
  read -p "按回车退出..."
  exit 1
else
  echo "✅ 平台已停止（端口 ${PORT} 已释放）——重新启动请双击「启动平台.command」"
  sleep 2
  exit 0
fi
