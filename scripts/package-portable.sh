#!/bin/sh
# U2-2 Phase 2/3 + U2-1/N7-P5：便携离线打包脚本
#
# 将 Node.js 运行时 + 项目代码 + 预编译依赖 + 前端素材（+ 可选 npm 离线缓存、
# litestream 二进制、license 模板）打包为单文件 .tar.gz，目标机解压即可运行（零联网、零构建）。
#
# 用法：
#   sh scripts/package-portable.sh                          # 构建当前平台便携包
#   CROSS_PLATFORM=linux-x64 sh scripts/package-portable.sh # 交叉打包（需目标平台 Node 二进制）
#   INCLUDE_NPM_CACHE=1 sh scripts/package-portable.sh       # 额外收录 npm 离线缓存（体积较大，目标机需 rebuild 时用）
#
# 输出：dist/agent-platform-portable-<version>-<platform>-<arch>.tar.gz
#
# 便携包目录结构：
#   agent-platform/
#   ├── node/bin/node        # Node.js 运行时
#   ├── app/                 # 项目代码（server.js/src-server/public/scripts/deploy/docs/...）
#   │   ├── data/            # SQLite 数据目录（持久化）
#   │   └── src-server/
#   ├── node_modules/        # 预安装依赖（含 prebuilt native 扩展，全量）
#   ├── npm-cache/           # （可选）npm 离线缓存，供目标机 npm rebuild 使用
#   ├── bin/litestream       # （可选）litestream 二进制（读写分离副本同步）
#   ├── license.template.json# License 模板（离线授权）
#   ├── start.sh / stop.sh   # 启停脚本
#   ├── offline-install.sh   # 目标机离线安装 + 自检
#   └── version.txt
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT=dist
VERSION=$(node -e "const p=require('./package.json');console.log(p.version||'1.0')" 2>/dev/null || echo "1.0")
PLATFORM="${CROSS_PLATFORM:-$(uname -s | tr A-Z a-z)-$(uname -m)}"
mkdir -p "$OUT"
TMP="$ROOT/.temp/portable-$(date +%s)"
rm -rf "$TMP"
PKG="$TMP/agent-platform"
mkdir -p "$PKG"

echo "[package-portable] 版本：$VERSION | 平台：$PLATFORM | 输出：$OUT"
echo

# ---------- 1. Node.js 运行时 ----------
NODE_DIR="$PKG/node/bin"
mkdir -p "$NODE_DIR"
# IC-3（2026-11-26）：目标平台二进制注入——交叉打包时由 release-offline.sh 从目标架构镜像
# （node:18-slim 系）提取 node 与 node_modules 后传入；缺省仍用宿主二进制（仅宿主可用包）
NODE_BIN=$(command -v node 2>/dev/null || echo "")
if [ -n "${NODE_BIN_SRC:-}" ] && [ -x "$NODE_BIN_SRC" ]; then
  echo "[package-portable] 使用注入的目标平台运行时：$NODE_BIN_SRC"
  cp "$NODE_BIN_SRC" "$NODE_DIR/node"
elif [ -n "$NODE_BIN" ]; then
  echo "[package-portable] 使用当前运行时：$(node -v) at $NODE_BIN"
  cp "$NODE_BIN" "$NODE_DIR/node"
else
  echo "[package-portable] ❌ 未找到 node 运行时（请先安装 Node.js，或设 NODE_BIN_SRC）" >&2
  exit 1
fi
chmod +x "$NODE_DIR/node"

# ---------- 2. 项目代码 ----------
echo "[package-portable] 复制项目代码..."
APP_DIR="$PKG/app"
mkdir -p "$APP_DIR"
for d in server.js ecosystem.config.js src-server public scripts deploy docs; do
  if [ -e "$ROOT/$d" ]; then cp -R "$ROOT/$d" "$APP_DIR/"; fi
done
for f in package.json package-lock.json; do
  if [ -e "$ROOT/$f" ]; then cp "$ROOT/$f" "$APP_DIR/"; fi
done
mkdir -p "$APP_DIR/data"

# ---------- 3. node_modules 全量预安装 ----------
echo "[package-portable] 收录依赖（node_modules 全量，含 prebuilt native 扩展）..."
NM_SRC="${NODE_MODULES_SRC:-$ROOT/node_modules}"
if [ -d "$NM_SRC" ]; then
  cp -R "$NM_SRC" "$PKG/node_modules"
  echo "[package-portable] ✅ 使用 node_modules（来源：$NM_SRC，$(du -sh "$PKG/node_modules" | cut -f1)）"
else
  ( cd "$APP_DIR" && npm install --omit=dev >/dev/null 2>&1 ) && cp -R "$APP_DIR/node_modules" "$PKG/node_modules" && rm -rf "$APP_DIR/node_modules"
  echo "[package-portable] ✅ npm install 完成（$(du -sh "$PKG/node_modules" | cut -f1)）"
fi

# ---------- 4. npm 离线缓存（可选，目标机需 npm rebuild 时使用）----------
if [ "${INCLUDE_NPM_CACHE:-0}" = "1" ]; then
  CACHE_SRC="$(npm config get cache 2>/dev/null || echo "")"
  if [ -n "$CACHE_SRC" ] && [ -d "$CACHE_SRC" ]; then
    echo "[package-portable] 收录 npm 离线缓存（$CACHE_SRC）..."
    mkdir -p "$PKG/npm-cache"
    cp -R "$CACHE_SRC/." "$PKG/npm-cache/" 2>/dev/null || true
    echo "[package-portable] ✅ npm-cache（$(du -sh "$PKG/npm-cache" | cut -f1)）"
  else
    echo "[package-portable] ⚠️ 未找到 npm 缓存目录，跳过"
  fi
else
  echo "[package-portable] 跳过 npm 离线缓存（如需请设 INCLUDE_NPM_CACHE=1）"
fi

# ---------- 5. litestream 二进制校验与收录（可选）----------
echo "[package-portable] 校验 litestream（读写分离副本同步，可选）..."
LITE_BIN=$(command -v litestream 2>/dev/null || echo "")
if [ -n "$LITE_BIN" ]; then
  if "$LITE_BIN" version >/dev/null 2>&1 || "$LITE_BIN" --version >/dev/null 2>&1; then
    mkdir -p "$PKG/bin"
    cp "$LITE_BIN" "$PKG/bin/litestream"
    chmod +x "$PKG/bin/litestream"
    echo "[package-portable] ✅ 已收录 litestream（$("$LITE_BIN" version 2>/dev/null | head -n1 || echo ok)）"
  else
    echo "[package-portable] ⚠️ litestream 存在但无法执行，跳过"
  fi
else
  echo "[package-portable] ⚠️ 未找到 litestream，跳过（读写分离副本同步需目标机自行安装）"
fi

# ---------- 6. License 模板 ----------
cat > "$PKG/license.template.json" <<'LICEOF'
{
  "_comment": "离线授权模板：填写后另存为 app/data/license.json 生效；字段以 scripts/issue-license.js 产出为准",
  "edition": "enterprise",
  "customer": "示例客户",
  "issued_at": "2026-01-01",
  "expires_at": "2027-01-01",
  "machine_id": "",
  "signature": ""
}
LICEOF

# ---------- 7. 启停脚本 ----------
cat > "$PKG/start.sh" <<'SHEOF'
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3210}"
DATA_DIR="${DATA_DIR:-$DIR/app/data}"
mkdir -p "$DATA_DIR"
# 关键：服务读取 AGENT_DATA_DIR（非 DATA_DIR），此处映射保证数据落持久目录
export PORT AGENT_DATA_DIR="$DATA_DIR"
[ -n "${AGENT_DB_READONLY:-}" ] && export AGENT_DB_READONLY
cd "$DIR/app"
echo "========================================"
echo "  智能体开发平台 便携版"
echo "  端口: $PORT"
echo "  数据: $DATA_DIR"
echo "========================================"
exec "$DIR/node/bin/node" server.js
SHEOF
chmod +x "$PKG/start.sh"

cat > "$PKG/stop.sh" <<'SHEOF'
#!/bin/sh
PIDS=$(lsof -t -i:"${PORT:-3210}" 2>/dev/null || true)
if [ -n "$PIDS" ]; then kill $PIDS 2>/dev/null && echo "已停止" || echo "停止失败"; else echo "未找到运行中的服务"; fi
SHEOF
chmod +x "$PKG/stop.sh"

echo "$VERSION ($(date +%Y-%m-%d), $PLATFORM)" > "$PKG/version.txt"

# ---------- 8. 离线安装脚本（从 app/scripts 复制到包根）----------
if [ -f "$APP_DIR/scripts/offline-install.sh" ]; then
  cp "$APP_DIR/scripts/offline-install.sh" "$PKG/offline-install.sh"
  chmod +x "$PKG/offline-install.sh"
fi

# ---------- 9. 打包 ----------
OUTFILE="agent-platform-portable-$VERSION-$PLATFORM.tar.gz"
( cd "$TMP" && tar czf "$ROOT/$OUT/$OUTFILE" agent-platform/ )
echo
echo "[package-portable] ✅ 便携包已生成：$OUT/$OUTFILE（$(du -sh "$OUT/$OUTFILE" 2>/dev/null | cut -f1)）"
echo "                解压后：tar xzf $OUTFILE && cd agent-platform && sh offline-install.sh"
echo "                启动：sh start.sh"
rm -rf "$TMP"
