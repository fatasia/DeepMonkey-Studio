# V3 Unity WebGL 本机导出驱动：提取 Unity Hub 会话凭据 → batchmode 真实构建 WebGL → 校验 bridge 注入与 ZIP。
# 用法：pwsh -File tools/unity/v3-webgl-e2e/run-v3-webgl-build.ps1 [-UnityEditor <path>] [-OutputRoot <dir>]
param(
  [string]$UnityEditor = "D:\Soft\Unity\6000.0.52f1\Editor\Unity.exe",
  [string]$OutputRoot = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
if (-not $OutputRoot) { $OutputRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot "..\..\..\test-output\v3-unity-webgl-20260923")) }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$buildRoot = Join-Path $OutputRoot "build\WebGL"
$zipPath = Join-Path $OutputRoot "build\bim-studio-webgl.zip"
$logsRoot = Join-Path $OutputRoot "logs"
New-Item -ItemType Directory -Force -Path $buildRoot, $logsRoot | Out-Null

if (-not (Test-Path -LiteralPath $UnityEditor)) { throw "Unity 编辑器不存在：$UnityEditor" }
$editorVersionRoot = Split-Path (Split-Path $UnityEditor -Parent) -Parent
$webGlSupport = Join-Path $editorVersionRoot "Editor\Data\PlaybackEngines\WebGLSupport"
if (-not (Test-Path -LiteralPath $webGlSupport)) { throw "该 Unity 版本未安装 WebGL 模块：$webGlSupport" }
$editorVersion = Split-Path $editorVersionRoot -Leaf

$hubLog = Join-Path $env:APPDATA "UnityHub\logs\info-log.json"
$launchEntry = Get-Content -LiteralPath $hubLog | Select-String -Pattern "-hubSessionId" | Select-Object -Last 1
if (-not $launchEntry) { throw "未找到 Unity Hub 会话记录；先从 Unity Hub 打开一次工程以便批处理复用许可会话。" }
$message = ($launchEntry.Line | ConvertFrom-Json).message
$sessionMatch = [regex]::Match($message, "'-hubSessionId',\s*'([^']+)'", "IgnoreCase")
$tokenMatch = [regex]::Match($message, "'-accessToken',\s*'([^']+)'", "IgnoreCase")
if (-not $sessionMatch.Success -or -not $tokenMatch.Success) { throw "无法解析 Unity Hub 会话凭据。" }

$logPath = Join-Path $logsRoot "unity-build.log"
$arguments = @(
  "-batchmode", "-quit", "-nographics", "-projectPath", $projectRoot,
  "-executeMethod", "V3ProbeBuilder.Build", "-logFile", $logPath,
  "-useHub", "-hubIPC", "-hubSessionId", $sessionMatch.Groups[1].Value, "-accessToken", $tokenMatch.Groups[1].Value
)
$env:BIM_V3_BUILD_OUTPUT = $buildRoot
$env:BIM_V3_ZIP_OUTPUT = $zipPath

$startedAt = Get-Date
Write-Host "[v3-build] Unity $editorVersion 开始构建（batchmode，日志 $logPath）…"
$process = Start-Process -FilePath $UnityEditor -ArgumentList $arguments -PassThru -WindowStyle Hidden
while (-not $process.HasExited) { Start-Sleep -Seconds 2; $process.Refresh() }
$elapsed = ((Get-Date) - $startedAt).TotalSeconds

$log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { "" }
$safeLog = $log -replace '(?i)(access token)\s+\S+', '$1 <redacted>'
$safeLog = $safeLog -replace "(?i)('-accessToken',\s*')[^']+", '$1<redacted>'
Set-Content -LiteralPath $logPath -Value $safeLog -Encoding UTF8

$summary = [ordered]@{
  editor = $UnityEditor; editorVersion = $editorVersion; webGlModule = $webGlSupport
  exitCode = $process.ExitCode; elapsedSeconds = [math]::Round($elapsed, 1)
  buildRoot = $buildRoot; zipPath = $zipPath; logPath = $logPath
  succeeded = $false; checks = @{}
}
if ($process.ExitCode -ne 0 -or $safeLog -notmatch "Deep Monkey Studio V3 WebGL build succeeded") {
  $tail = ($safeLog -split "`r?`n" | Select-Object -Last 40) -join [Environment]::NewLine
  $summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputRoot "build-summary.json") -Encoding UTF8
  throw "Unity 构建失败（exit=$($process.ExitCode)）。`n$tail"
}

$index = Get-Content -LiteralPath (Join-Path $buildRoot "index.html") -Raw
$summary.checks.bridgeInjected = ($index -match 'unity-bridge\.js') -and ($index -match 'BimStudioUnityBridge\.register') -and ($index -match 'BimStudioUnityBridge\.createTrackedInstance')
$manifest = Get-Content -LiteralPath (Join-Path $buildRoot "bim-studio.manifest.json") -Raw | ConvertFrom-Json
$summary.checks.manifestValid = ($manifest.schemaVersion -eq 1) -and ($manifest.bridgeVersion -eq 1) -and ($manifest.unityVersion -eq $editorVersion)
$buildFiles = @(Get-ChildItem -LiteralPath $buildRoot -Recurse -File)
$summary.checks.runtimeArtifacts = @()
foreach ($pattern in @('\.loader\.js$', '\.framework\.js$', '\.wasm$', '\.data$')) {
  $hit = $buildFiles | Where-Object { $_.Name -match $pattern } | Select-Object -First 1 -ExpandProperty Name
  if (-not $hit) { throw "构建产物缺少匹配 $pattern 的运行时文件。" }
  $summary.checks.runtimeArtifacts += $hit
}
$summary.checks.uncompressed = @($buildFiles | Where-Object { $_.Name -match '\.(br|gz|unityweb)$' }).Count -eq 0
if (-not (Test-Path -LiteralPath $zipPath)) { throw "一键 ZIP 未生成：$zipPath" }
$zip = Get-Item -LiteralPath $zipPath
$summary.checks.zipBytes = $zip.Length
$summary.checks.zipSha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$summary.checks.fileCount = $buildFiles.Count
$summary.succeeded = $true

$summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputRoot "build-summary.json") -Encoding UTF8
Write-Host "[v3-build] 构建成功：$($summary.checks.fileCount) 个文件，ZIP $($summary.checks.zipBytes) 字节，耗时 $([math]::Round($elapsed,1))s"
