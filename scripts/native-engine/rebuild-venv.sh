#!/usr/bin/env bash
# rebuild-venv.sh —— 重建原生 GPU 引擎的开发 venv
#
# 背景:旧 .local-data/native-engine-venv 是从其他机器(用户 bbsx1)拷贝而来的,
# pyvenv.cfg 的 home 指向不存在的 C:\Users\bbsx1\...,本机无法启动 python,
# 任何依赖该 venv 的调试/验证脚本都会直接失败。
#
# 依赖版本与部署目录 native-engine/site-packages 的 dist-info 逐一对齐:
#   taichi==1.7.4  numpy==1.26.4  msgpack==1.1.1  websockets==15.0.1
# (colorama/dill/markdown-it-py/mdurl/pygments/rich 均为传递依赖,自动带出)
#
# 用法: ./scripts/native-engine/rebuild-venv.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

VENV_DIR=".local-data/native-engine-venv"

# 删除损坏的旧 venv(整体由 uv 重建,不保留任何旧内容)
rm -rf "$VENV_DIR"

# uv 自动拉取 python-build-standalone 的 CPython 3.11(与部署目录嵌入式 3.11 同小版本线)
uv venv --python 3.11 "$VENV_DIR"

# 一次性安装全部直接依赖;国内网络可先配 UV_INDEX_URL 镜像
uv pip install --python "$VENV_DIR/Scripts/python.exe" \
  "taichi==1.7.4" "numpy==1.26.4" "msgpack==1.1.1" "websockets==15.0.1"

# 健康自检:解释器可启动、四大依赖可导入、版本与部署目录一致
# 注意:taichi 的 __version__ 是元组 (1, 7, 4),与字符串比较会恒为假
"$VENV_DIR/Scripts/python.exe" - <<'EOF'
import taichi, numpy, msgpack, websockets
assert tuple(map(str, taichi.__version__)) == ("1", "7", "4"), taichi.__version__
assert numpy.__version__ == "1.26.4", numpy.__version__
assert msgpack.version == (1, 1, 1), msgpack.version
assert websockets.__version__ == "15.0.1", websockets.__version__
print("venv 重建完成: taichi", ".".join(map(str, taichi.__version__)), "| numpy", numpy.__version__,
      "| msgpack", msgpack.version, "| websockets", websockets.__version__)
EOF
