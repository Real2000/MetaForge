#!/bin/bash
# ============================================================
# 一键提交脚本：把改动存档到 git，并自动上传 GitHub
# 用法：在 Finder 里双击本文件
# ============================================================
cd "$(dirname "$0")" || exit 1

echo "======================================"
echo "        一键提交并上传 GitHub"
echo "======================================"
echo
echo "【当前改动】"
git status --short
echo

if [ -z "$(git status --porcelain)" ]; then
  echo "没有需要提交的改动。"
  read -p "按回车键关闭..."
  exit 0
fi

read -p "请输入本次提交说明（直接回车使用默认）: " MSG
if [ -z "$MSG" ]; then
  MSG="更新代码 $(date '+%Y-%m-%d %H:%M')"
fi

git add -A
git commit -m "$MSG"
echo
echo "已提交，正在后台自动上传 GitHub（约需几秒）..."
sleep 6
echo
echo "【最近推送记录】"
tail -3 .git/auto-push.log 2>/dev/null || echo "（暂无日志）"
echo
read -p "完成，按回车键关闭..."
