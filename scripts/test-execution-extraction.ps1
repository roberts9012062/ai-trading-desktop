$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
$repository=Split-Path $PSScriptRoot -Parent
$directory=Join-Path $repository ('.local-data/execution-extract-test-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($directory) | Out-Null
$cases=@(
  @{Names=@('execution-worker.exe','nested/native.dll');Valid=$true},
  @{Names=@('../outside.dll');Valid=$false},
  @{Names=@('C:/outside.dll');Valid=$false},
  @{Names=@('nested\outside.dll');Valid=$false},
  @{Names=@('A.dll','a.dll');Valid=$false},
  @{Names=@('NUL.dll');Valid=$false},
  @{Names=@('link.dll');Valid=$false;Link=$true}
)
$index=0
foreach($case in $cases){
  $archive=Join-Path $directory ('case-'+$index+'.zip')
  $destination=Join-Path $directory ('case-'+$index)
  $stream=[IO.File]::Open($archive,[IO.FileMode]::CreateNew)
  $zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
  try {
    foreach($name in $case.Names){
      $entry=$zip.CreateEntry($name)
      if($case.Link){$entry.ExternalAttributes=[int]0xA1FF0000}
      $writer=$entry.Open()
      try{$bytes=[Text.Encoding]::UTF8.GetBytes('synthetic compiled file');$writer.Write($bytes,0,$bytes.Length)}finally{$writer.Dispose()}
    }
  }finally{$zip.Dispose();$stream.Dispose()}
  $accepted=$true
  try{& (Join-Path $PSScriptRoot 'extract-execution-worker.ps1') -Archive $archive -Destination $destination}catch{if($case.Valid){throw};$accepted=$false}
  if($accepted -ne $case.Valid){throw "Archive extraction case $index returned an unexpected result"}
  if($case.Valid -and [IO.File]::ReadAllText((Join-Path $destination 'nested/native.dll')) -ne 'synthetic compiled file'){throw 'Extracted file did not match'}
  $index++
}
Write-Output "Archive extraction: $index real ZIP cases passed"
