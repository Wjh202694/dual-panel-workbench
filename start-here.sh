#!/usr/bin/env bash
# 双面板 · 共识文档工作台 —— 一键安装并启动（macOS / Linux）
# 用法：bash 一键启动.sh
# 如果下载后提示没有执行权限：chmod +x 一键启动.sh

set -e
cd "$(dirname "$0")/app"

echo
echo "  双面板 · 共识文档工作台"
echo "  ----------------------------------------"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  [x] 没找到 node。"
  echo
  echo "      这个应用需要 Node.js 18 或更高版本。"
  echo "      macOS: brew install node"
  echo "      官网下载：https://nodejs.org/"
  echo
  exit 1
fi

if [ ! -d node_modules/electron ]; then
  echo "  [1/2] 正在安装依赖 ..."
  echo "        第一次会慢一点：要下载 Electron，本体大约 100MB。"
  echo
  npm install
else
  echo "  [1/2] 依赖已经装过了，跳过。"
fi

echo
echo "  [2/2] 正在启动应用 ..."
echo
npm start
