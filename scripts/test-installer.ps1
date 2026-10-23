param([Parameter(Mandatory=$true)][string]$Installer,[string]$BaselineTag='v0.2.205')
$ErrorActionPreference='Stop'
# This gate installs only into an ephemeral CI account, never the developer's
# existing installation, registry registration, credentials or trading state.
if($env:GITHUB_ACTIONS -ne 'true'){throw 'Installer lifecycle acceptance requires an ephemeral GitHub Actions runner'}
$candidate=(Resolve-Path -LiteralPath $Installer).Path
$version=(Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
if((Split-Path $candidate -Leaf) -ne "ai-trading-desktop_${version}_x64-setup.exe"){throw 'Candidate version mismatch'}
$testRoot=Join-Path $env:RUNNER_TEMP ('atd-install-'+[guid]::NewGuid().ToString('N'))
$installRoot=Join-Path $testRoot 'app'
$baselineRoot=Join-Path $testRoot 'baseline'
New-Item -ItemType Directory -Path $baselineRoot -Force | Out-Null
& gh release download $BaselineTag --repo roberts9012062/ai-trading-desktop --pattern '*_x64-setup.exe' --dir $baselineRoot
if($LASTEXITCODE -ne 0){throw 'Baseline installer download failed'}
$baseline=@(Get-ChildItem -LiteralPath $baselineRoot -Filter '*_x64-setup.exe' -File)
if($baseline.Count -ne 1){throw 'Ambiguous baseline installer'}
function Install-Candidate([string]$File,[bool]$Upgrade){
    $arguments='/S /NS '+$(if($Upgrade){'/UPDATE '}else{''})+"/D=$installRoot"
    $process=Start-Process -FilePath $File -ArgumentList $arguments -PassThru -WindowStyle Hidden
    if(-not $process.WaitForExit(180000)){throw 'Installer did not finish in time'}
    if($process.ExitCode -ne 0){throw "Installer failed: $($process.ExitCode)"}
}
Install-Candidate $candidate $false
if(-not(Test-Path -LiteralPath (Join-Path $installRoot 'execution-worker/manifest.json'))){throw 'Clean candidate installation missing native runtime'}
$uninstaller=Start-Process -FilePath (Join-Path $installRoot 'uninstall.exe') -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
if($uninstaller.ExitCode -ne 0){throw 'Test candidate uninstaller failed'}
Install-Candidate $baseline[0].FullName $false
if(-not(Test-Path -LiteralPath (Join-Path $installRoot 'ai-trading-desktop.exe'))){throw 'Clean baseline installation missing application'}
$dataRoot=Join-Path $env:APPDATA 'com.aitrading.desktop'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$marker=Join-Path $dataRoot 'release-acceptance.marker'
$markerValue='preserve-local-state-'+[guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText($marker,$markerValue)
Install-Candidate $candidate $true
if([IO.File]::ReadAllText($marker) -ne $markerValue){throw 'Upgrade changed existing user data'}
$application=Join-Path $installRoot 'ai-trading-desktop.exe'
if(-not([Diagnostics.FileVersionInfo]::GetVersionInfo($application).ProductVersion.StartsWith($version))){throw 'Installed application version mismatch'}
$runtime=@(Get-ChildItem -LiteralPath $installRoot -Recurse -Filter manifest.json -File | Where-Object {$_.Directory.Name -eq 'execution-worker'})
if($runtime.Count -ne 1){throw 'Installed executor missing or ambiguous'}
$env:ATD_INSTALLED_RUNTIME=$runtime[0].Directory.FullName
& node --input-type=module -e 'import fs from "node:fs/promises";import assert from "node:assert/strict";import {verifyExecutionArtifact} from "./scripts/execution-worker.mjs";const lock=JSON.parse(await fs.readFile("execution-worker.lock.json","utf8"));const dir=process.env.ATD_INSTALLED_RUNTIME;const m=await verifyExecutionArtifact(dir);assert.equal(m.build_id,lock.build_id);console.log(JSON.stringify({installed_runtime:m.build_id,files:m.files.length,verified:true}));'
if($LASTEXITCODE -ne 0){throw 'Installed executor full manifest failed'}
$info=[Diagnostics.ProcessStartInfo]::new((Join-Path $env:ATD_INSTALLED_RUNTIME 'execution-worker.exe'),'--self-test')
$info.WorkingDirectory=$env:ATD_INSTALLED_RUNTIME;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.Environment.Clear()
foreach($name in @('SYSTEMROOT','WINDIR','TEMP','TMP')){$value=[Environment]::GetEnvironmentVariable($name);if($value){$info.Environment[$name]=$value}}
$info.Environment['PATH']="$env:SYSTEMROOT\System32;$env:SYSTEMROOT";$info.Environment['EXECUTOR_ISOLATED']='1'
$worker=[Diagnostics.Process]::Start($info)
$stdout=$worker.StandardOutput.ReadToEndAsync();$stderr=$worker.StandardError.ReadToEndAsync()
if(-not $worker.WaitForExit(90000)){throw 'Installed executor self-test timed out'}
$reply=$stdout.GetAwaiter().GetResult() | ConvertFrom-Json
if($worker.ExitCode -ne 0 -or $reply.type -ne 'executor-runtime' -or -not $reply.sqlite -or -not $reply.private_strategy -or -not $reply.isolated){throw 'Installed executor failed native self-test'}
# First launch uses the runner's empty profile and has no market/exchange Key.
$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $testRoot 'webview'
$app=Start-Process -FilePath $application -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 8
if($app.HasExited){throw 'Installed application exited during first launch'}
& taskkill /PID $app.Id /T /F | Out-Null
if($LASTEXITCODE -ne 0){throw 'Test application process tree cleanup failed'}
Write-Output ('{"baseline":"'+$BaselineTag+'","installed_version":"'+$version+'","clean_install":true,"upgrade_preserves_user_data":true,"full_runtime_manifest":true,"native_self_test":true,"first_launch":true,"financial_requests_sent":false}')
