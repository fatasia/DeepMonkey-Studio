param()

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $repositoryRoot ".runtime-logs"
$webDirectory = Join-Path $repositoryRoot "apps\web\dist"
$apiEntry = Join-Path $repositoryRoot "apps\api\dist\index.js"

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
if (-not (Test-Path -LiteralPath $apiEntry)) { throw "API 构建产物不存在：$apiEntry" }
if (-not (Test-Path -LiteralPath (Join-Path $webDirectory "index.html"))) { throw "Web 构建产物不存在：$webDirectory" }

$env:NODE_ENV = "production"
$env:WEB_DIST_DIR = $webDirectory
Set-Location -LiteralPath $repositoryRoot

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -LiteralPath (Join-Path $logDirectory "production.out.log") -Value "[$timestamp] production process starting"
& node $apiEntry 1>> (Join-Path $logDirectory "production.out.log") 2>> (Join-Path $logDirectory "production.err.log")
exit $LASTEXITCODE
