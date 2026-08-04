[CmdletBinding()]
param(
  [string]$Version = "0.14"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDirectory = Join-Path $PSScriptRoot "libredwg"
$archivePath = Join-Path ([System.IO.Path]::GetTempPath()) "bim-studio-libredwg-$Version-win64.zip"
$downloadUrl = "https://github.com/LibreDWG/libredwg/releases/download/$Version/libredwg-$Version-win64.zip"
$licenseUrl = "https://raw.githubusercontent.com/LibreDWG/libredwg/$Version/COPYING"

Write-Host "Downloading GNU LibreDWG $Version from the official release..."
Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
Expand-Archive -LiteralPath $archivePath -DestinationPath $targetDirectory -Force
Invoke-WebRequest -Uri $licenseUrl -OutFile (Join-Path $targetDirectory "COPYING")

$converter = Join-Path $targetDirectory "dwg2dxf.exe"
if (-not (Test-Path -LiteralPath $converter)) {
  throw "LibreDWG installed but dwg2dxf.exe was not found in $targetDirectory"
}

Write-Host "LibreDWG is ready: $converter"
Write-Host "Restart BIM Studio. The API discovers this path automatically; no .env change is required."
