# Native Engine Diagnostic Script
Write-Host "=== Native Engine Diagnostic ===" -ForegroundColor Cyan
Write-Host ""

# 1. Check Python
Write-Host "[1/5] Checking Python..." -ForegroundColor Yellow
$pythonPath = ".local-data/native-engine-venv/Scripts/python.exe"
if (Test-Path $pythonPath) {
    Write-Host "  [OK] Python found: $pythonPath" -ForegroundColor Green
    $version = & $pythonPath --version 2>&1
    Write-Host "  [OK] Version: $version" -ForegroundColor Green
} else {
    Write-Host "  [ERROR] Python not found: $pythonPath" -ForegroundColor Red
    exit 1
}

# 2. Check engine module
Write-Host ""
Write-Host "[2/5] Checking engine module..." -ForegroundColor Yellow
$engineMain = "native-engine/engine/__main__.py"
if (Test-Path $engineMain) {
    Write-Host "  [OK] Engine entry found: $engineMain" -ForegroundColor Green
} else {
    Write-Host "  [ERROR] Engine entry not found: $engineMain" -ForegroundColor Red
    exit 1
}

# 3. Check CUDA
Write-Host ""
Write-Host "[3/5] Checking CUDA..." -ForegroundColor Yellow
try {
    $nvidiaSmi = nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] NVIDIA driver installed" -ForegroundColor Green
        Write-Host "  GPU: $nvidiaSmi" -ForegroundColor Green
    } else {
        Write-Host "  [ERROR] nvidia-smi failed" -ForegroundColor Red
    }
} catch {
    Write-Host "  [ERROR] nvidia-smi not found" -ForegroundColor Red
}

# 4. Check running processes
Write-Host ""
Write-Host "[4/5] Checking Python processes..." -ForegroundColor Yellow
$pythonProcesses = Get-Process python -ErrorAction SilentlyContinue
if ($pythonProcesses) {
    Write-Host "  Found $($pythonProcesses.Count) Python process(es):" -ForegroundColor Yellow
    foreach ($proc in $pythonProcesses) {
        $mem = [math]::Round($proc.WorkingSet64/1MB, 2)
        Write-Host "    PID: $($proc.Id) | Memory: ${mem}MB" -ForegroundColor Gray
    }
} else {
    Write-Host "  No Python processes running" -ForegroundColor Gray
}

# 5. Test engine startup
Write-Host ""
Write-Host "[5/5] Testing engine startup (10 seconds)..." -ForegroundColor Yellow
Write-Host "  Command: python -u -m engine --precision mixed" -ForegroundColor Gray

$env:PYTHONPATH = "native-engine;native-engine/site-packages"
$env:PYTHONNOUSERSITE = "1"

$job = Start-Job -ScriptBlock {
    param($pythonPath, $engineDir)
    Set-Location $engineDir
    $env:PYTHONPATH = ".;./site-packages"
    $env:PYTHONNOUSERSITE = "1"
    & $pythonPath -u -m engine --precision mixed 2>&1
} -ArgumentList (Resolve-Path $pythonPath), (Resolve-Path "native-engine")

Write-Host "  Waiting 10 seconds..." -ForegroundColor Gray
Start-Sleep -Seconds 10

$output = Receive-Job $job
Stop-Job $job
Remove-Job $job

if ($output) {
    Write-Host ""
    Write-Host "  Output (first 20 lines):" -ForegroundColor Cyan
    $output | Select-Object -First 20 | ForEach-Object {
        if ($_ -match "native_engine_ready") {
            Write-Host "  [OK] $_" -ForegroundColor Green
        } elseif ($_ -match "error|failed|exception") {
            Write-Host "  [ERROR] $_" -ForegroundColor Red
        } else {
            Write-Host "  $_" -ForegroundColor Gray
        }
    }
    
    $ready = $output | Select-String -Pattern "native_engine_ready"
    if ($ready) {
        Write-Host ""
        Write-Host "=== [SUCCESS] Engine can start normally ===" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "=== [FAILED] Engine did not start in 10 seconds ===" -ForegroundColor Red
        Write-Host "Possible reasons:" -ForegroundColor Yellow
        Write-Host "  1. CUDA JIT compilation (first time): wait 2-6 minutes" -ForegroundColor Yellow
        Write-Host "  2. CUDA driver/GPU compatibility issue" -ForegroundColor Yellow
        Write-Host "  3. Missing Python dependencies" -ForegroundColor Yellow
    }
} else {
    Write-Host "  [ERROR] No output (process may have crashed)" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Diagnostic Complete ===" -ForegroundColor Cyan
