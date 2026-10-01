#!/usr/bin/env bash
# unlock-update.sh —— 一键清理残留挖掘引擎,解除更新安装器的文件锁
#
# 现象:更新安装器弹 "Error opening file for writing:
#       O:\ai-trading-desktop\native-engine\python\DLLs\*.pyd"
# 根因:主进程退出/被强杀后,其子进程(挖掘引擎 python.exe)残留为孤儿,
#       继续锁住安装目录下的 DLL,导致新文件写不进去。
# 注意:主应用若还在运行会立刻重新拉起引擎,因此必须先关主应用再杀引擎。
# 用法:在错误对话框弹出后运行本脚本,完成后回对话框点 Retry。
set -euo pipefail

INSTALL_DIR='O:/ai-trading-desktop'

echo "== [1/3] 关闭主应用(否则它会立刻重启引擎,锁清不掉) =="
powershell -NoProfile -Command '
$app = Get-Process -Name "ai-trading-desktop" -ErrorAction SilentlyContinue
if ($app) {
    foreach ($a in $app) { Write-Output ("关闭主应用 PID " + $a.Id) }
    Stop-Process -Name "ai-trading-desktop" -Force
} else {
    Write-Output "主应用未在运行"
}'

echo "== [2/3] 终结残留引擎进程 =="
sleep 2
powershell -NoProfile -Command '
$targets = Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "python.exe" -and $_.CommandLine -match "native-engine" }
if (-not $targets) {
    Write-Output "未发现残留引擎进程"
} else {
    foreach ($t in $targets) {
        Write-Output ("杀掉引擎 PID " + $t.ProcessId)
        Stop-Process -Id $t.ProcessId -Force
    }
}'

echo "== [3/3] 验证安装目录文件已解锁 =="
sleep 3
powershell -NoProfile -Command '
$probe = Join-Path "'"$INSTALL_DIR"'" "native-engine/python/DLLs/_asyncio.pyd"
try {
    $f = [System.IO.File]::Open($probe, "Open", "ReadWrite", "None")
    $f.Close()
    Write-Output "已解锁:现在回安装器点 Retry 即可继续"
} catch {
    Write-Output ("仍被占用: " + $_.Exception.Message)
    exit 1
}'
