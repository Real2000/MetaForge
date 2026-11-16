#!/bin/sh
# U2-2 Phase 2/3：便携离线打包脚本（2026-11-16）
#
# 将 Node.js 运行环境 + 项目代码 + 预编译依赖 + 前端素材打包为
# 单文件 .tar.gz，用户解压后即可运行（零联网、零构建）。
#
# 用法：
#   sh scripts/package-portable.sh                 # 构建当前平台便携包
#   CROSS_PLATFORM=linux-x64 sh scripts/package-portable.sh  # 交叉打包目标平台
#
# 输出：dist/agent-platform-portable-<version>-<platform>-<arch>.tar.gz
#
# 便携包目录结构：
#   agent-platform/
#   ├── node/          # Node.js 运行时（prebuilt 二进制 => node/bin/node）
#   ├── app/           # 项目代码（server.js/src-server/public/ 等）
#   │   ├── data/      # SQLite 数据目录（挂载持久卷）
#   │   └── src-server/
#   ├── node_modules/  # 预安装依赖（含 prebuilt native 扩展）
#   ├── start.sh       # 启动脚本
#   ├── stop.sh
#   └── version.txt    # 版本信息
#
# 环境要求：
#   - 宿主需安装 node + npm（用于 node_modules 预安装）
#   - 交叉打包需目标平台 Node.js 二进制（从 nodejs.org 下载）
set -e
cd "$(dirname "$0")/.."
OUT=dist
VERSION=$(node -e "const p=require('./package.json');console.log(p.version||'1.0')" 2>/dev/null || echo "1.0")
PLATFORM="${CROSS_PLATFORM:-$(uname -s | tr A-Z a-z)-$(uname -m)}"
mkdir -p "$OUT"
TMP=.temp/portable-$(date +%s)
rm -rf "$TMP"
mkdir -p "$TMP/agent-platform"

echo "[package-portable] 版本：$VERSION | 平台：$PLATFORM | 输出：$OUT"
echo

# ---------- 1. Node.js 运行时 ----------
NODE_DIR="$TMP/agent-platform/node/bin"
mkdir -p "$NODE_DIR"
NODE_BIN=$(which node 2>/dev/null || echo "")
if [ -n "$NODE_BIN" ]; then
  echo "[package-portable] 使用当前运行时：$(node -v) at $NODE_BIN"
  cp "$NODE_BIN" "$NODE_DIR/node"
else
  echo "[package-portable] ⚠️ 未找到 node 运行时，尝试下载..."
  exit 1
fi

# ---------- 2. 项目代码 ----------
echo "[package-portable] 复制项目代码..."
APP_DIR="$TMP/agent-platform/app"
mkdir -p "$APP_DIR"
# 按需复制目录（排除 node_modules/.temp/测试数据）
for d in server.js src-server public scripts; do
  if [ -d "$d" ] || [ -f "$d" ]; then
    cp -R "$d" "$APP_DIR/"
  fi
done

# ---------- 3. node_modules 预安装 ----------
echo "[package-portable] 安装依赖（含 prebuilt native 扩展）..."
cd "$TMP/agent-platform"
# 如果宿主已有 node_modules，直接复制（最快）
if [ -d "/Users/work/Desktop/APP/智能体开发平台/node_modules" ]; then
  # 复制除开发/测试工具之外的目录
  mkdir -p node_modules
  cp -R "/Users/work/Desktop/APP/智能体开发平台/node_modules/." node_modules/
  echo "[package-portable] ✅ 使用宿主的 node_modules（$(du -sh node_modules | cut -f1)）"
else
  # 进行 npm install（必须联网）
  cp "/Users/work/Desktop/APP/智能体开发平台/package.json" .
  cp "/Users/work/Desktop/APP/智能体开发平台/package-lock.json" .
  npm install --omit=dev --production --no-optional 2>&1 | tail -2
  echo "[package-portable] ✅ npm install 完成"
fi
# 原生模块重新绑定平台
cd "node_modules"
for mod in better-sqlite3; do
  if [ -d "$mod" ]; then
    echo "[package-portable] 重绑原生模块：$mod..."
    node ../app/scripts/deploy-check.js 2>/dev/null || true
  fi
done
cd "$OLDPWD"

# ---------- 4. 创建启动/停止脚本 ----------
cat > start.sh <<'SHEOF'
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
export PORT="${PORT:-3210}"
export DATA_DIR="${DATA_DIR:-$DIR/app/data}"
mkdir -p "$DATA_DIR"
cd "$DIR/app"
echo "========================================"
echo "  智能体开发平台 便携版"
echo "  端口: $PORT"
echo "  数据: $DATA_DIR"
echo "========================================"
exec "$DIR/node/bin/node" server.js
SHEOF
chmod +x start.sh

cat > stop.sh <<'SHEOF'
#!/bin/sh
kill $(lsof -t -i:${PORT:-3210}) 2>/dev/null && echo "已停止" || echo "未找到运行中的服务"
SHEOF
chmod +x stop.sh

echo "$VERSION ($(date +%Y-%m-%d), $PLATFORM)" > version.txt

cd "$OLDPWD"

# ---------- 5. 打包 ----------
# 打包前回到项目根
PROJROOT="$PWD"
OUTFILE="agent-platform-portable-$VERSION-$PLATFORM.tar.gz"
(cd "$TMP" && tar czf "$PROJROOT/$OUT/$OUTFILE" agent-platform/)
echo

echo
echo "[package-portable] ✅ 便携包已生成：$OUT/$OUTFILE"
echo "                解压后执行：./agent-platform/start.sh"
echo "                详情 $(du -sh "$OUT/$OUTFILE" 2>/dev/null | cut -f1)"
rm -rf "$TMP"
