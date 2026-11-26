#!/bin/sh
# IC-3（M11，2026-11-26）：信创多架构离线交付包构建
#
# 产物（dist/，均附 sha256 清单）：
#   metaforge-<ver>-linux-amd64.tar.gz                 docker 镜像归档（x86_64）
#   metaforge-<ver>-linux-arm64.tar.gz                 docker 镜像归档（arm64，鲲鹏/飞腾）
#   agent-platform-portable-<ver>-linux-x86_64.tar.gz  便携包（x86_64）
#   agent-platform-portable-<ver>-linux-arm64.tar.gz   便携包（arm64）
#   SHA256SUMS / RELEASE_MANIFEST.md
#
# 机制（真交叉，非仅改名——XC-4 打通 QEMU binfmt 的兑现）：
#   ① buildx 双架构构建（linux/amd64 + linux/arm64），层缓存复用；
#   ② docker save | gzip 导出镜像归档；
#   ③ 从各架构镜像内提取 node 运行时（/usr/local/bin/node）与 node_modules
#      （builder 阶段在目标架构内 npm install，better-sqlite3 等原生模块按架构预编译）；
#   ④ NODE_BIN_SRC/NODE_MODULES_SRC 注入 package-portable.sh 组装便携包——
#      产物含目标架构真二进制，目标机零联网、零构建可跑。
#
# 用法：sh scripts/release-offline.sh           # 全流程
#       SKIP_IMAGES=1 sh scripts/release-offline.sh   # 仅重组便携包（镜像已构建时复用）
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION=$(node -e "console.log(require('./package.json').version||'1.0')" 2>/dev/null || echo 1.0)
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
OUT=dist
STAGE="$ROOT/.temp/ic3-stage"
mkdir -p "$OUT"
rm -rf "$STAGE"
mkdir -p "$STAGE"
AMD="metaforge:$VERSION-amd64"
ARM="metaforge:$VERSION-arm64"

sha256_of() { # macOS shasum / Linux sha256sum 双环境
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [ "${SKIP_IMAGES:-0}" != "1" ]; then
  echo "[release-offline] ① buildx 双架构构建（linux/amd64 + linux/arm64）..."
  docker buildx build --platform linux/amd64 -t "$AMD" --load .
  docker buildx build --platform linux/arm64 -t "$ARM" --load .
  echo "[release-offline] ② 导出镜像归档（docker save | gzip）..."
  docker save "$AMD" | gzip -9 > "$OUT/metaforge-$VERSION-linux-amd64.tar.gz"
  docker save "$ARM" | gzip -9 > "$OUT/metaforge-$VERSION-linux-arm64.tar.gz"
fi

echo "[release-offline] ③ 提取目标架构运行时并组装便携包矩阵..."
for ARCH in x86_64 arm64; do
  if [ "$ARCH" = "x86_64" ]; then DPLAT=linux/amd64; IMG="$AMD"; else DPLAT=linux/arm64; IMG="$ARM"; fi
  mkdir -p "$STAGE/$ARCH"
  # 从镜像提取（--platform 指定架构；create 不运行，docker cp 取文件，跨架构安全）
  CID=$(docker create --platform "$DPLAT" "$IMG")
  docker cp "$CID:/usr/local/bin/node" "$STAGE/$ARCH/node"
  docker cp "$CID:/app/node_modules" "$STAGE/$ARCH/node_modules"
  docker rm "$CID" >/dev/null
  chmod +x "$STAGE/$ARCH/node"
  echo "[release-offline]   - $ARCH 便携包组装（node=$(file -b "$STAGE/$ARCH/node" | cut -c1-40)...）"
  CROSS_PLATFORM="linux-$ARCH" NODE_BIN_SRC="$STAGE/$ARCH/node" NODE_MODULES_SRC="$STAGE/$ARCH/node_modules" \
    sh scripts/package-portable.sh
done

echo "[release-offline] ④ 生成 sha256 清单与版本清单..."
: > "$OUT/SHA256SUMS"
for f in "$OUT"/*.tar.gz; do printf '%s  %s\n' "$(sha256_of "$f")" "$(basename "$f")" >> "$OUT/SHA256SUMS"; done
{
  echo "# MetaForge 信创多架构离线交付包 · 发布清单"
  echo
  echo "- 版本：$VERSION（package.json）　提交：$COMMIT"
  echo "- 构建时间：$(date '+%Y-%m-%d %H:%M')　构建机：$(uname -sm)"
  echo "- 镜像基础：node:18-slim（Dockerfile 多阶段构建）"
  echo
  echo "| 产物 | 大小 |"
  echo "| --- | --- |"
  for f in "$OUT"/*.tar.gz; do echo "| $(basename "$f") | $(du -h "$f" | cut -f1) |"; done
  echo
  echo '```'
  cat "$OUT/SHA256SUMS"
  echo '```'
  echo
  echo "校验：目标机执行 \`sha256sum -c SHA256SUMS\`（Linux）或 \`shasum -a 256 -c SHA256SUMS\`（macOS）。"
  echo
  echo "> AI生成"
} > "$OUT/RELEASE_MANIFEST.md"
rm -rf "$STAGE"

echo
echo "[release-offline] ✅ 完成。产物："
ls -lh "$OUT"/*.tar.gz "$OUT/SHA256SUMS" "$OUT/RELEASE_MANIFEST.md" | awk '{print "   ", $5, $9}'