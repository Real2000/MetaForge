@echo off
chcp 65001 >nul
title 智能体平台
cd /d "%~dp0"
echo ==============================================
echo   正在启动 智能体平台 ...
echo ==============================================
if not exist node_modules (
  echo [1/2] 首次运行，安装依赖中...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo 依赖安装失败 & pause & exit /b 1
  )
)
echo [2/2] 启动服务...
echo.
node server.js
pause
