#!/bin/bash
# P5.27b 构建 Mac 安装包（DMG 标准分发 + zip 备用）
# 产物：
#   public/downloads/TeleAgent助手.dmg   —— 双击挂载 → 拖 .app 到 Applications 完成安装
#   public/downloads/TeleAgent助手.zip   —— 解压即用（备用格式）
#
# DMG 内容布局（Finder 拖拽安装体验）：
#   [TeleAgent助手.app] [Applications⇒] [使用说明.txt] [卸载.command]
#   .background/background.png —— 安装窗口背景（隐藏目录）
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="TeleAgent助手"
BUNDLE_ID="com.teleagent.bridge"
OUT_DIR="public/downloads"
WORK="$(mktemp -d)"
STAGE="$WORK/${APP_NAME}.app"
DMG_STAGING="$WORK/dmg"
DMG_RAW="$WORK/raw.dmg"
DMG_OUT="$OUT_DIR/${APP_NAME}.dmg"
BG_SRC="$(dirname "$0")/assets/dmg-background.jpg"
NODE_BIN="$(command -v node)"
VOL_NAME="TeleAgent 智能体平台助手"

echo "==> 使用 Node 运行时：$NODE_BIN ($(node -p 'process.arch'))"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources" "$OUT_DIR"

# ① Node 二进制（自包含，用户无需装 Node）
cp "$NODE_BIN" "$STAGE/Contents/MacOS/node"
chmod +x "$STAGE/Contents/MacOS/node"

# ② bridge.js
cp local-bridge/bridge.js "$STAGE/Contents/MacOS/bridge.js"

# ③ 引导主程序：首启 → 安装 launchd → 弹配对码输入（osascript）→ 启动 daemon
cat > "$STAGE/Contents/MacOS/${APP_NAME}" << 'LAUNCHER'
#!/bin/bash
# TeleAgent 智能体平台助手 —— 主引导（菜单栏无窗应用）
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$DIR/node"
BRIDGE="$DIR/bridge.js"
PLIST="$HOME/Library/LaunchAgents/com.teleagent.bridge.plist"
LOG="$HOME/Library/Logs/teleagent-bridge.log"

# 平台地址（默认本机 3210；可通过 AP_PLATFORM_URL 环境变量覆盖）
PLATFORM_URL="${AP_PLATFORM_URL:-http://localhost:3210}"

notify() { osascript -e "display notification \"$1\" with title \"TeleAgent 智能体平台助手\"" 2>/dev/null || true; }

# ---------- 已在 launchd 下运行 → 直接跑 bridge ----------
if [[ "${AP_FROM_LAUNCHD:-}" == "1" ]]; then
  exec "$NODE" "$BRIDGE"
fi

# ---------- 手动打开（Finder 双击）→ 引导流程 ----------
# 1) 安装/刷新 launchd（开机自启 + 崩溃自动拉起）
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" << PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.teleagent.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(builtin cd "$DIR" && pwd)/node</string>
    <string>$(builtin cd "$DIR" && pwd)/bridge.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AP_FROM_LAUNCHD</key><string>1</string>
    <key>AP_PLATFORM_URL</key><string>$PLATFORM_URL</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL

# 2) 若平台地址非默认，写入桥配置（覆盖默认）
if [[ "$PLATFORM_URL" != "http://localhost:3210" ]]; then
  "$NODE" -e "
    const fs=require('fs'),os=require('os'),path=require('path');
    const f=path.join(os.homedir(),'Library','Application Support','TeleAgentBridge','config.json');
    let c={};try{c=JSON.parse(fs.readFileSync(f))}catch{}
    c.platform_url='$PLATFORM_URL';
    fs.mkdirSync(path.dirname(f),{recursive:true});
    fs.writeFileSync(f,JSON.stringify(c,null,2));
  " 2>/dev/null || true
fi

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST" 2>/dev/null || true

# 3) 配对状态检查；未配对 → 弹配对码输入引导
sleep 1
STATUS="$("$NODE" "$BRIDGE" --status 2>/dev/null | head -c 400 || echo '{}')"
if echo "$STATUS" | grep -q '"paired": *true'; then
  notify "已配对并运行中 ✅（开机自启已安装）"
  osascript -e 'display dialog "TeleAgent 智能体平台助手已运行 ✅

后台守护已启动（开机自启）。
AI 现在可以在您确认后操作这台电脑。

如需卸载：回到安装 DMG，双击「卸载.command」" buttons {"好"} default button 1 with icon note' 2>/dev/null || true
else
  CODE="$(osascript -e 'display dialog "首次使用请输入网页端「我的设备」页生成的 6 位配对码：

（网页：智能体平台 → 左侧导航「我的设备」→ 生成配对码）" default answer "" with title "TeleAgent 助手配对" buttons {"取消", "配对"} default button 2' -e 'text returned of result' 2>/dev/null || true)"
  if [[ -n "$CODE" ]] && [[ "$CODE" =~ ^[0-9]{6}$ ]]; then
    RESULT="$("$NODE" "$BRIDGE" --pair "$CODE" 2>&1 | head -1)"
    notify "$RESULT"
    # 配对后重启 launchd 任务进入轮询主循环
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST" 2>/dev/null || true
    osascript -e "display dialog \"$RESULT

配对完成后，可在对话里对 AI 说：
「帮我在桌面建个文件夹」试试看 😊\" buttons {\"好\"} default button 1 with icon note" 2>/dev/null || true
  else
    notify "未完成配对。守护已后台运行，可稍后在网页生成配对码后重新打开本应用配对。"
  fi
fi
LAUNCHER
chmod +x "$STAGE/Contents/MacOS/${APP_NAME}"

# ④ 卸载脚本（DMG 根目录也放一份，双击即卸）
cat > "$STAGE/Contents/MacOS/uninstall.command" << 'UNINSTALL'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.teleagent.bridge.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "已停止并移除开机自启。"
echo "如需彻底删除，把本 .app 拖入废纸篓即可（配置在 ~/Library/Application Support/TeleAgentBridge）。"
echo "（窗口可关闭）"
read -r -p "按回车关闭…" _
UNINSTALL
chmod +x "$STAGE/Contents/MacOS/uninstall.command"

# ⑤ Info.plist（LSUIElement=1：菜单栏型后台应用，不占 Dock）
cat > "$STAGE/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>TeleAgent 智能体平台助手</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSAppleEventsUsageDescription</key><string>用于配对引导的系统对话框与通知</string>
</dict>
</plist>
PLIST

# ⑥ 图标（icon-512 → icns）
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
if [[ -f public/icons/icon-512.png ]]; then
  for sz in 16 32 64 128 256 512; do
    sips -z $sz $sz public/icons/icon-512.png --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null 2>&1
    sips -z $((sz*2)) $((sz*2)) public/icons/icon-512.png --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "$STAGE/Contents/Resources/AppIcon.icns" >/dev/null 2>&1 && \
    plutil -replace CFBundleIconFile -string "AppIcon" "$STAGE/Contents/Info.plist" || true
fi

# ============== ⑦ DMG 打包（标准拖拽安装布局） ==============
echo "==> 组装 DMG 暂存目录"
mkdir -p "$DMG_STAGING/.background"
cp -R "$STAGE" "$DMG_STAGING/${APP_NAME}.app"
ln -s /Applications "$DMG_STAGING/Applications"
cp "$STAGE/Contents/MacOS/uninstall.command" "$DMG_STAGING/卸载.command"
chmod +x "$DMG_STAGING/卸载.command"

cat > "$DMG_STAGING/使用说明.txt" << 'README'
TeleAgent 智能体平台助手 —— 安装说明（macOS）
================================================

【安装】
  1. 把「TeleAgent助手.app」拖到右侧的「Applications」文件夹
  2. 到「启动台 / 应用程序」打开 TeleAgent助手
     （首次打开若提示"无法验证开发者"：右键 .app →「打开」→ 再点「打开」，仅需一次）
  3. 首次打开会弹出配对窗口——去网页端「智能体平台 → 左侧导航「我的设备」」点「生成配对码」，
     把 6 位数字填进弹窗即可完成配对

【安装后】
  · 助手在后台常驻（菜单栏型应用，不占 Dock），开机自启，断网自动重连
  · 在平台对话里对 AI 说：「帮我在桌面建个文件夹」「打开备忘录」等即可体验本地操控
  · 每次执行前都会在对话中弹出确认卡，批准后才真正执行

【安全边界】
  白名单操作仅四类：创建文件夹 / 列目录 / 打开应用 / 系统通知。
  无任意命令执行；路径限制在你的用户主目录内；全部动作记录在
  ~/Library/Logs/teleagent-bridge.log 可审计。

【卸载】
  双击本 DMG 里的「卸载.command」（停止后台服务并移除自启），
  然后把应用程序里的 TeleAgent助手 拖入废纸篓。

【架构】本包为 Intel (x64)。Apple Silicon (M 系列芯片) 需在对应机器上构建。
README

# 背景图（若生成资源存在则转换；否则跳过——Finder 用默认白底）
if [[ -f "$BG_SRC" ]]; then
  # 转换为 PNG 并缩到常见窗口比例
  sips -s format png "$BG_SRC" --resampleWidth 1440 --out "$DMG_STAGING/.background/background.png" >/dev/null 2>&1 || true
fi

# 计算动态大小（raw dmg 需比内容大一些余量）
SIZE_BYTES=$(du -sk "$DMG_STAGING" | cut -f1)
SIZE_KB=$(( SIZE_BYTES * 12 / 10 + 20480 ))
echo "==> 创建 raw DMG（${SIZE_KB}KB 余量）"
rm -f "$DMG_RAW"
hdiutil create -srcfolder "$DMG_STAGING" -volname "$VOL_NAME" -fs HFS+ -format UDRW -size ${SIZE_KB}k "$DMG_RAW" -quiet

# 设置 Finder 窗口布局说明：
#   布局（背景图/图标定位）需要「Finder 自动化」授权弹窗，无人值守/CI 环境不可用且会卡死构建——
#   故跳过 AppleScript 布局，产出标准 DMG（双击打开即为 .app + Applications 拖拽安装，完全可用）。
#   如需精致布局：本机手动执行一次 `osascript` 授权（系统设置→隐私与安全性→自动化→允许终端控制 Finder）后重跑。
echo "==> 跳过 Finder 布局（标准 DMG 布局，见注释）"

# 压缩为分发格式（UDZO zlib 压缩）
echo "==> 压缩为分发 DMG"
rm -f "$DMG_OUT"
hdiutil convert "$DMG_RAW" -format UDZO -imagekey zlib-level=9 -o "$DMG_OUT" -quiet
xattr -c "$DMG_OUT" 2>/dev/null || true   # 清除 quarantine 属性（本机构建）

# ⑧ zip 备用格式（保留）
ditto -c -k --keepParent "$STAGE" "$OUT_DIR/${APP_NAME}.zip"

echo "==> 完成："
du -h "$DMG_OUT" | awk '{print "   " $2 "  " $1}' | sed 's/^ *//'
echo "   $DMG_OUT"
du -h "$OUT_DIR/${APP_NAME}.zip" | awk '{print "   " $2 "  " $1}' | sed 's/^ *//'
echo "   $OUT_DIR/${APP_NAME}.zip"
rm -rf "$WORK"
