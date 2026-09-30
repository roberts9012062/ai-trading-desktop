#!/usr/bin/env bash
# run-engine.sh —— 启动原生 GPU 引擎 sidecar(Run & Debug 统一入口)
#
# 用法:
#   ./scripts/native-engine/run-engine.sh            # 启动部署目录的引擎(默认 mixed 精度)
#   ./scripts/native-engine/run-engine.sh --precision f64
#
# 说明:
# - 引擎根目录默认取桌面端安装目录 O:/ai-trading-desktop/native-engine;
#   通过 NATIVE_ENGINE_DIR 环境变量可改指其他副本(如 src-tauri/target/release)。
# - 首次启动(或缓存被清理后)Blackwell(sm_120)显卡需要由驱动 JIT 逐个转译
#   全部 kernel,预热可能持续数十分钟;stdout 会持续输出 native_engine_boot
#   进度行,最终输出 native_engine_ready 即启动成功。
set -euo pipefail
cd "$(dirname "$0")/../.."

ENGINE_ROOT="${NATIVE_ENGINE_DIR:-O:/ai-trading-desktop/native-engine}"
PRECISION_ARGS=("$@")

exec "$ENGINE_ROOT/python/python.exe" -m engine "${PRECISION_ARGS[@]}"
