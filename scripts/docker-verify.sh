#!/usr/bin/env bash
# ================================================================
#  B1 Docker 部署一键自验（2026-11-10 V3.2 收尾）
#  用途：docker compose up 前的全链路实测——构建 → 起容器 → 健康检查 → HTTP 冒烟 → 清理
#  背景：开发机 Docker Desktop 代理受限时无法拉取基础镜像，本脚本在任意可拉镜像的环境
#        （服务器/网络恢复后）单命令完成验证闭环，输出结构化结果。
#
#  用法：
#    bash scripts/docker-verify.sh              # 完整验证（构建+启动+冒烟+清理）
#    bash scripts/docker-verify.sh --keep       # 验证后保留容器与镜像（便于人工检查）
#    bash scripts/docker-verify.sh --port 3299  # 换宿主端口（默认 3299 避开本机 3210）
#
#  退出码：0 全过 / 1 任一环节失败（输出会标注失败环节）
# ================================================================
set -uo pipefail

PORT="${B1_PORT:-3299}"
PROJ="b1-verify"
KEEP=0
for a in "$@"; do
  case "$a" in
    --keep) KEEP=1 ;;
    --port) shift_next=1 ;;
    *) [ "${shift_next:-0}" = "1" ] && PORT="$a" && shift_next=0 ;;
  esac
done

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; FAILS=$((FAILS+1)); }
FAILS=0
STEP=""

note()  { echo; echo "──── $1 ────"; STEP="$1"; }

note "[1/6] 前置检查（docker daemon / compose）"
if docker info >/dev/null 2>&1; then pass "docker daemon 运行中"; else fail "docker daemon 未运行（先启动 Docker Desktop）"; exit 1; fi
if docker compose version >/dev/null 2>&1; then pass "docker compose 可用"; else fail "docker compose 不可用"; exit 1; fi

note "[2/6] 语法校验（compose 编排）"
if docker compose -p "$PROJ" config --quiet 2>&1; then pass "compose 语法正确（默认仅 platform，OCR 需 --profile ocr）"; else fail "compose 语法错误"; exit 1; fi

note "[3/6] 镜像构建（多阶段 + 原生模块编译，首次约 3~10 分钟）"
if docker compose -p "$PROJ" build 2>&1 | tail -3; then pass "镜像构建成功"; else fail "镜像构建失败（检查网络/基础镜像拉取）"; exit 1; fi

note "[4/6] 启动容器（端口 ${PORT}）"
if docker compose -p "$PROJ" up -d --no-build 2>&1 | tail -2; then pass "容器已启动"; else fail "容器启动失败"; exit 1; fi

note "[5/6] 健康检查（HTTP /api/health）"
ok=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -m 4 -w "%{http_code}" "http://127.0.0.1:${PORT}/api/health" 2>/dev/null)
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 2
done
if [ "$ok" = "1" ]; then pass "healthcheck 200（第 $((i*2))s 内就绪）"; else fail "150 秒内未就绪"; fi

# 冒烟：首页可达 + 登录端点拒绝匿名（401 预期）
body_code=$(curl -s -o /dev/null -m 4 -w "%{http_code}" "http://127.0.0.1:${PORT}/" 2>/dev/null)
[ "$body_code" = "200" ] && pass "首页 200" || fail "首页返回 $body_code"
auth_code=$(curl -s -o /dev/null -m 4 -w "%{http_code}" "http://127.0.0.1:${PORT}/api/auth/me" 2>/dev/null)
[ "$auth_code" = "401" ] && pass "未登录访问 /api/auth/me 正确返回 401（鉴权生效）" || fail "鉴权异常：$auth_code"
login_code=$(curl -s -o /dev/null -m 6 -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' "http://127.0.0.1:${PORT}/api/auth/login" 2>/dev/null)
[ "$login_code" = "200" ] && pass "admin 登录 200（种子数据与密码校验全链路通）" || fail "登录失败：$login_code（注意首次登录强制改密不影响本端点）"

note "[6/6] 清理"
if [ "$KEEP" = "1" ]; then
  echo "  ⏸ --keep：保留容器与镜像（手动清理：docker compose -p $PROJ down -v --rmi local）"
else
  docker compose -p "$PROJ" down -v --rmi local >/dev/null 2>&1 && pass "容器/卷/镜像已清理" || echo "  ⚠ 清理非完全成功（可手动 docker compose -p $PROJ down -v）"
fi

echo
if [ "$FAILS" = "0" ]; then
  echo "════ B1 Docker 验证结论：全部通过 ════"
  exit 0
else
  echo "════ B1 Docker 验证结论：${FAILS} 项失败（首个失败环节：${STEP}）════"
  exit 1
fi
