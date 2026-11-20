#!/bin/sh
# ============================================================
# 安装「提交后自动推送 GitHub」钩子
# ------------------------------------------------------------
# 用途：为当前仓库安装 post-commit 钩子，实现 git commit 后
#       自动（后台异步）推送当前分支到 github remote。
# 场景：首次启用；换机 / 重新 git clone 后重装（钩子不进版本控制）
# 用法：sh scripts/install-auto-push.sh
# ============================================================
set -eu

REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "❌ 请在 git 仓库内运行"; exit 1; }
HOOK="$REPO/.git/hooks/post-commit"

# 校验 github 远程存在
if ! git -C "$REPO" remote get-url github >/dev/null 2>&1; then
  echo "❌ 未找到 github 远程，请先添加：git remote add github <仓库地址>"
  exit 1
fi

cat > "$HOOK" <<'EOF'
#!/bin/sh
# post-commit：提交后自动推送到 GitHub（后台异步，不阻塞提交；失败重试 3 次）
REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -z "$REPO" ] && exit 0
LOG="$REPO/.git/auto-push.log"
BRANCH="$(git -C "$REPO" symbolic-ref --short HEAD 2>/dev/null)" || exit 0
[ -z "$BRANCH" ] && exit 0
COMMIT="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)"
(
  for i in 1 2 3; do
    if git -C "$REPO" -c http.version=HTTP/1.1 push github "$BRANCH" >>"$LOG" 2>&1; then
      printf '[%s] OK  %s %s (第%d次尝试)\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$BRANCH" "$COMMIT" "$i" >>"$LOG"
      exit 0
    fi
    printf '[%s] 重试 %s %s 第%d次失败\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$BRANCH" "$COMMIT" "$i" >>"$LOG"
    sleep 5
  done
  printf '[%s] 失败 %s %s：3 次尝试均未成功，请手动执行 git push github %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$BRANCH" "$COMMIT" "$BRANCH" >>"$LOG"
) >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
EOF

chmod +x "$HOOK"
# 确保用 HTTP/1.1（规避 GitHub HTTP2 framing 问题）
git -C "$REPO" config http.version HTTP/1.1

echo "✅ 已安装自动推送钩子：$HOOK"
echo "   此后每次 git commit 成功后，会自动在后台推送到 github"
echo "   日志：$REPO/.git/auto-push.log"
echo "   关闭：rm \"$HOOK\""
