param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$PublicOrigin = "http://localhost:4200",
  [string]$ChromiumPath = "C:\Program Files\Google\Chrome\Application\chrome.exe",
  [int]$Port = 4200,
  [switch]$Headless
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not (Test-Path -LiteralPath $ChromiumPath -PathType Leaf)) {
  throw "Chromium executable not found: $ChromiumPath"
}
$env:CLOUD_RENDER_WORKER_TOKEN = $Token
$env:CLOUD_RENDER_WORKER_PUBLIC_ORIGIN = $PublicOrigin
$env:CLOUD_RENDER_CHROMIUM_PATH = $ChromiumPath
$env:CLOUD_RENDER_WORKER_PORT = [string]$Port
$env:CLOUD_RENDER_HEADLESS = if ($Headless) { "true" } else { "false" }
pnpm --dir $workspace --filter @bim-studio/cloud-render-worker dev
