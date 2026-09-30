#!/usr/bin/env bash
# build-local.sh —— 本地构建桌面端测试包(Run & Debug 统一入口)
#
# 对齐 .github/workflows/release.yml 的构建链,但跳过发布侧(签名密钥/
# GitHub Release/gist 清单),产物用于本地部署验证:
#   1. uv 冻结环境(requirements-native.lock 哈希校验)→ 组装原生引擎
#      运行时到 resources/native-engine(含共享 CPU 内核 resources/public)
#   2. vite build 前端 → dist/
#   3. tauri build → src-tauri/target/release/bundle/nsis/*.setup.exe
#      (本地测试临时关闭 createUpdaterArtifacts,构建后还原配置)
#
# 用法: ./scripts/build-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."

CONF="src-tauri/tauri.conf.json"

echo "== [1/3] 组装原生引擎运行时 =="
uv python install 3.11.14
if [ ! -d .local-data/native-engine-venv ] || [ ! -x .local-data/native-engine-venv/Scripts/python.exe ]; then
  uv venv .local-data/native-engine-venv --python 3.11.14
  uv pip install --python .local-data/native-engine-venv/Scripts/python.exe \
    --require-hashes -r requirements-native.lock
fi
BASE_PREFIX="$(.local-data/native-engine-venv/Scripts/python.exe -c 'import sys; print(sys.base_prefix)')"
.local-data/native-engine-venv/Scripts/python.exe scripts/assemble-native-engine.py \
  --python "$BASE_PREFIX" --venv .local-data/native-engine-venv
test -f resources/native-engine/python/python.exe
test -f resources/native-engine/VERSION

echo "== [2/3] 前端构建 =="
node node_modules/vite/bin/vite.js build

echo "== [3/3] Tauri 打包(本地无签名,临时关闭 updater 产物) =="
python - <<'EOF'
import json
p = "src-tauri/tauri.conf.json"
c = json.load(open(p, encoding="utf-8"))
c["bundle"]["createUpdaterArtifacts"] = False
json.dump(c, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
EOF
restore() {
  git checkout -- "$CONF" 2>/dev/null || true
}
trap restore EXIT
node node_modules/@tauri-apps/cli/tauri.js build

echo "== 完成 =="
ls -la src-tauri/target/release/bundle/nsis/*.exe 2>/dev/null || true
ls -la src-tauri/target/release/ai-trading-desktop.exe
