@echo off
chcp 65001 >nul
title 双面板 · 共识文档工作台
cd /d "%~dp0app"

echo.
echo   双面板 · 共识文档工作台
echo   ----------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [x] 没找到 node。
  echo.
  echo       这个应用需要 Node.js 18 或更高版本。
  echo       国内下载：https://npmmirror.com/mirrors/node/
  echo       官网下载：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist node_modules\electron (
  echo   [1/2] 正在安装依赖 ...
  echo         第一次会慢一点：要下载 Electron，本体大约 100MB。
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [!] 从官方源安装失败，换国内镜像再试一次 ...
    echo.
    set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    call npm install
    if errorlevel 1 (
      echo.
      echo   [x] 还是装不上。常见原因：
      echo         - 网络不通 / 需要代理
      echo         - Node.js 版本太老（要 18+）
      echo       装好后可以手动执行：npm install
      echo.
      pause
      exit /b 1
    )
  )
) else (
  echo   [1/2] 依赖已经装过了，跳过。
)

echo.
echo   [2/2] 正在启动应用 ...
  echo.
call npm start
if errorlevel 1 (
  echo.
  echo   [!] 应用退出了。上面的报错信息就是原因。
  pause
)
