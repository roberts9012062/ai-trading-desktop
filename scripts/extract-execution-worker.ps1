param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
$cacheRoot=[IO.Path]::GetFullPath((Join-Path (Split-Path $PSScriptRoot -Parent) '.local-data'))+[IO.Path]::DirectorySeparatorChar
$archivePath=[IO.Path]::GetFullPath($Archive)
$destinationPath=[IO.Path]::GetFullPath($Destination)
if (!$archivePath.StartsWith($cacheRoot,[StringComparison]::OrdinalIgnoreCase) -or !$destinationPath.StartsWith($cacheRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Directory]::Exists($destinationPath) -or [IO.File]::Exists($destinationPath)){throw 'Invalid execution archive destination'}
$source=[IO.File]::OpenRead($archivePath)
$zip=$null
try {
  $zip=[IO.Compression.ZipArchive]::new($source,[IO.Compression.ZipArchiveMode]::Read,$false)
  if ($zip.Entries.Count -gt 10000){throw 'Too many execution archive entries'}
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $total=[long]0
  foreach($entry in $zip.Entries){
    $name=$entry.FullName.TrimEnd('/')
    if (!$name -or $name.Length -gt 512 -or $name -match '[\\:\x00-\x1f\x7f]' -or (($name -split '/') | Where-Object { !$_ -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[. ]$' -or $_ -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$' }) -or !$seen.Add($name) -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000){throw 'Unsafe execution archive entry'}
    if ($entry.Length -lt 0 -or $entry.Length -gt 1GB){throw 'Execution archive entry is too large'}
    $total+=$entry.Length
    if ($total -gt 2GB){throw 'Execution archive exceeds total size limit'}
  }
  [IO.Directory]::CreateDirectory($destinationPath) | Out-Null
  $prefix=$destinationPath+[IO.Path]::DirectorySeparatorChar
  foreach($entry in $zip.Entries){
    $target=[IO.Path]::GetFullPath((Join-Path $destinationPath $entry.FullName))
    if (!$target.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Execution archive path escaped destination'}
    if ($entry.FullName.EndsWith('/')){[IO.Directory]::CreateDirectory($target) | Out-Null;continue}
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
    $inputStream=$entry.Open();$outputStream=$null
    try {
      $outputStream=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      $buffer=[byte[]]::new(65536);$written=[long]0
      while(($count=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0){
        $written+=$count
        if ($written -gt $entry.Length -or $written -gt 1GB){throw 'Execution archive entry length mismatch'}
        $outputStream.Write($buffer,0,$count)
      }
      if ($written -ne $entry.Length){throw 'Truncated execution archive entry'}
    } finally {if($outputStream){$outputStream.Dispose()};$inputStream.Dispose()}
  }
} finally {if($zip){$zip.Dispose()};$source.Dispose()}
