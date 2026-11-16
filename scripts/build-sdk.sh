#!/bin/sh
# U1-8 SDK 构建打包：TS/Node 包 → tgz；Python 包 → whl（纯 Python wheel，零构建依赖）
# 产物归档到 public/downloads/（平台「API 密钥」弹窗与 SDK 中心提供下载）。
# 幂等可重跑；不依赖 Java/openapi-generator（SDK 手写轻量实现，契约与 OpenAPI 规范对齐）。
set -e
cd "$(dirname "$0")/.."
OUT=public/downloads
mkdir -p "$OUT"

# ---------- TypeScript/Node 包 → agent-platform-sdk-x.y.z.tgz ----------
TS_DIR=.temp/sdk-build/ts
rm -rf "$TS_DIR"
mkdir -p "$TS_DIR"
cp sdk/typescript/package.json sdk/typescript/index.js sdk/typescript/index.d.ts sdk/typescript/README.md "$TS_DIR/"
TS_VER=$(node -e "console.log(require('./$TS_DIR/package.json').version)")
(cd "$TS_DIR" && npm pack --silent >/dev/null 2>&1 && mv "agent-platform-sdk-$TS_VER.tgz" "$OLDPWD/$OUT/agent-platform-sdk-$TS_VER.tgz")
echo "[sdk] TS 包已打包：$OUT/agent-platform-sdk-$TS_VER.tgz"

# ---------- Python 包 → agent_platform_sdk-x.y.z-py3-none-any.whl ----------
PY_DIR=.temp/sdk-build/py
rm -rf "$PY_DIR"
mkdir -p "$PY_DIR"
cp -R sdk/python/pyproject.toml sdk/python/README.md sdk/python/agent_platform "$PY_DIR/"
PY_VER=$(python3 -c "import re;s=open('$PY_DIR/pyproject.toml').read();print(re.search(r'version = \"([^\"]+)\"',s).group(1))")
(cd "$PY_DIR" && python3 -m pip wheel . --no-deps -w . --quiet >/dev/null 2>&1 && mv "agent_platform_sdk-$PY_VER-py3-none-any.whl" "$OLDPWD/$OUT/agent_platform_sdk-$PY_VER-py3-none-any.whl")
echo "[sdk] Python whl 已打包：$OUT/agent_platform_sdk-$PY_VER-py3-none-any.whl"

echo "[sdk] 完成。产物列表："
ls -la "$OUT" | grep -E "agent.platform|agent_platform"
