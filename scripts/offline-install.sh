#!/bin/sh
# U2-1/N7-P5：目标机完全离线安装 + 部署自检（麒麟 Kylin / 统信 UOS 等信创系统）
#
# 在便携包根目录执行（与 node/ app/ node_modules/ 同级）：
#   sh offline-install.sh
#
# 全程不联网：优先直接使用包内预编译依赖；仅当原生模块与目标平台 ABI 不匹配时，
# 若包内附带了 npm-cache/，则用其离线 rebuild（不触网）。
set -e

# 定位包根：优先脚本所在目录；若在 app/scripts 下则回退到两级上
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$SELF_DIR/node" ] && [ -d "$SELF_DIR/app" ]; then
  ROOT="$SELF_DIR"
elif [ -d "$SELF_DIR/../node" ]; then
  ROOT="$(cd "$SELF_DIR/../.." && pwd)"
else
  ROOT="$SELF_DIR"
fi
cd "$ROOT"

echo "=============================================="
echo "  智能体开发平台 · 离线安装与自检"
echo "  包目录：$ROOT"
echo "=============================================="

NODE="$ROOT/node/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node || true)"

FAIL=0

# ---------- 1. Node 运行时 ----------
echo
echo "[1/5] Node.js 运行时"
if [ -n "$NODE" ] && "$NODE" -v >/dev/null 2>&1; then
  echo "  ✅ $($NODE -v) @ $NODE"
else
  echo "  ❌ 未找到可用的 node 运行时" >&2
  FAIL=1
fi

# ---------- 2. 依赖完整性 ----------
echo
echo "[2/5] 依赖完整性（node_modules）"
if [ -d "$ROOT/node_modules" ]; then
  echo "  ✅ node_modules 存在（$(du -sh "$ROOT/node_modules" 2>/dev/null | cut -f1)）"
else
  echo "  ⚠️ 未找到 node_modules（若包内含 npm-cache 将尝试离线安装）"
fi

# ---------- 3. 原生模块 ABI 自检（跨平台拷贝最常见问题） ----------
echo
echo "[3/5] 原生模块 ABI 自检（better-sqlite3）"
if [ -n "$NODE" ] && ( cd "$ROOT/app" && "$NODE" scripts/deploy-check.js ) ; then
  echo "  ✅ 原生模块可用"
else
  echo "  ⚠️ 原生模块不可用，尝试离线修复..."
  NPM="$(command -v npm || true)"
  CACHE="$ROOT/npm-cache"
  if [ -n "$NPM" ] && [ -d "$CACHE" ]; then
    echo "  使用包内 npm 离线缓存 rebuild（--offline）..."
    ( cd "$ROOT/app" && "$NPM" rebuild better-sqlite3 --cache "$CACHE" --offline --update-binary ) || \
      echo "  ❌ 离线 rebuild 失败：目标机需具备构建工具链（gcc/make/python3）"
  else
    echo "  ❌ 无法离线修复：包内无 npm-cache，且目标机缺少构建工具。"
    echo "     建议在目标平台重新打包，或提供平台匹配的 prebuilt 二进制。"
    FAIL=1
  fi
fi

# ---------- 4. litestream（可选） ----------
echo
echo "[4/5] litestream（读写分离副本同步，可选）"
if [ -x "$ROOT/bin/litestream" ]; then
  echo "  ✅ 已随包提供：$ROOT/bin/litestream"
elif command -v litestream >/dev/null 2>&1; then
  echo "  ✅ 系统已安装 litestream"
else
  echo "  ⚠️ 未找到 litestream（不使用读写分离副本时可忽略）"
fi

# ---------- 5. License（可选） ----------
echo
echo "[5/5] License（可选）"
if [ -f "$ROOT/app/data/license.json" ]; then
  echo "  ✅ 已存在 app/data/license.json"
elif [ -f "$ROOT/license.template.json" ]; then
  echo "  ⚠️ 未配置 License，将运行社区版。模板：license.template.json → 另存为 app/data/license.json"
else
  echo "  ⚠️ 未配置 License，将运行社区版"
fi

echo
echo "=============================================="
if [ "$FAIL" = "0" ]; then
  echo "  ✅ 离线安装自检通过"
  echo "  启动：  PORT=3210 sh start.sh"
  echo "  停止：  sh stop.sh"
  echo "  可选读写分离：先 sh app/scripts/replica-bootstrap.sh，再设 AGENT_DB_READONLY 启动"
else
  echo "  ❌ 自检未通过，请按上方提示处理后重试"
fi
echo "=============================================="
exit "$FAIL"
