#!/usr/bin/env bash
# dev.sh —— 浏览器 dev server 启停(Run & Debug 统一入口)
#
# 用法:
#   ./scripts/dev.sh                 # 后端走 VITE_DEV_BACKEND(默认 127.0.0.1:8002)
#   VITE_DEV_BACKEND=https://uusb.eu.org:3051 ./scripts/dev.sh
#
# 说明:直接调用 node_modules 里的 vite,绕过 pnpm 在非 TTY 环境下的
# 依赖状态检查(它会尝试重装 node_modules 并因无 TTY 中止)。
set -euo pipefail
cd "$(dirname "$0")/.."

exec node node_modules/vite/bin/vite.js --port 5173 --strictPort
