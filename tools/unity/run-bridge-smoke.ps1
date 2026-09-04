param(
  [string[]]$Only = @()
)

$ErrorActionPreference = "Stop"
$toolRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$templateRoot = [IO.Path]::GetFullPath((Join-Path $toolRoot "bridge-smoke"))
$bridgePackagePath = Join-Path $toolRoot "com.bim-studio.bridge\package.json"
$bridgePackageVersion = ([IO.File]::ReadAllText($bridgePackagePath, [Text.Encoding]::UTF8) | ConvertFrom-Json).version
$runsRoot = [IO.Path]::GetFullPath((Join-Path $toolRoot ".smoke-runs"))
if (-not $runsRoot.StartsWith($toolRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Smoke run root escaped the Unity tools directory."
}

$versions = @(
  @{ Name = "2022.3"; Version = "2022.3.62f1"; Editor = "D:\Soft\Unity\2022.3.62f1\Editor\Unity.exe" },
  @{ Name = "6000.0"; Version = "6000.0.52f1"; Editor = "D:\Soft\Unity\6000.0.52f1\Editor\Unity.exe" }
)
if ($Only.Count -gt 0) {
  $versions = @($versions | Where-Object { $Only -contains $_.Name })
}
if ($versions.Count -eq 0) { throw "No Unity versions selected." }

$hubLog = Join-Path $env:APPDATA "UnityHub\logs\info-log.json"
$launchEntry = Get-Content -LiteralPath $hubLog | Select-String -Pattern "-hubSessionId" | Select-Object -Last 1
if (-not $launchEntry) { throw "Open a Unity project from Unity Hub once so batch validation can reuse the licensed Hub session." }
$message = ($launchEntry.Line | ConvertFrom-Json).message
$sessionMatch = [regex]::Match($message, "'-hubSessionId',\s*'([^']+)'", "IgnoreCase")
$tokenMatch = [regex]::Match($message, "'-accessToken',\s*'([^']+)'", "IgnoreCase")
if (-not $sessionMatch.Success -or -not $tokenMatch.Success) { throw "Unity Hub session credentials could not be resolved." }
$hubSessionId = $sessionMatch.Groups[1].Value
$hubAccessToken = $tokenMatch.Groups[1].Value

New-Item -ItemType Directory -Force -Path $runsRoot | Out-Null
$runStamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$results = @()
$hadFailures = $false
foreach ($item in $versions) {
  if (-not (Test-Path -LiteralPath $item.Editor)) {
    $results += [pscustomobject]@{ Version = $item.Version; Package = "editor missing"; WebGL = "not run" }
    continue
  }

  $projectRoot = [IO.Path]::GetFullPath((Join-Path $runsRoot "$($item.Name)-$runStamp"))
  if (-not $projectRoot.StartsWith($runsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unity smoke project escaped the run directory."
  }
  New-Item -ItemType Directory -Force -Path $projectRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $templateRoot "Assets") -Destination $projectRoot -Recurse
  Copy-Item -LiteralPath (Join-Path $templateRoot "Packages") -Destination $projectRoot -Recurse
  Copy-Item -LiteralPath (Join-Path $templateRoot "ProjectSettings") -Destination $projectRoot -Recurse
  $manifestPath = Join-Path $projectRoot "Packages\manifest.json"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $manifestContent = (Get-Content -LiteralPath $manifestPath -Raw).Replace('file:../../com.bim-studio.bridge', 'file:../../../com.bim-studio.bridge')
  [IO.File]::WriteAllText($manifestPath, $manifestContent, $utf8NoBom)
  [IO.File]::WriteAllText((Join-Path $projectRoot "ProjectSettings\ProjectVersion.txt"), "m_EditorVersion: $($item.Version)`n", $utf8NoBom)

  $logPath = Join-Path $projectRoot "unity.log"
  $webGlSupport = Join-Path (Split-Path (Split-Path $item.Editor -Parent) -Parent) "Editor\Data\PlaybackEngines\WebGLSupport"
  $method = if (Test-Path -LiteralPath $webGlSupport) { "BridgeSmokeBuilder.Build" } else { "BridgeSmokeBuilder.Validate" }
  $arguments = @(
    "-batchmode", "-quit", "-nographics", "-projectPath", $projectRoot,
    "-executeMethod", $method, "-logFile", $logPath,
    "-useHub", "-hubIPC", "-hubSessionId", $hubSessionId, "-accessToken", $hubAccessToken
  )
  $process = Start-Process -FilePath $item.Editor -ArgumentList $arguments -PassThru -WindowStyle Hidden
  while (-not $process.HasExited) {
    Start-Sleep -Seconds 1
    $process.Refresh()
  }
  $log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { "" }
  $safeLog = $log -replace '(?i)(access token)\s+\S+', '$1 <redacted>'
  $safeLog = $safeLog -replace "(?i)('-accessToken',\s*')[^']+", '$1<redacted>'
  if (Test-Path -LiteralPath $logPath) {
    for ($writeAttempt = 0; $writeAttempt -lt 10; $writeAttempt++) {
      try {
        Set-Content -LiteralPath $logPath -Value $safeLog -Encoding UTF8
        break
      } catch [IO.IOException] {
        if ($writeAttempt -eq 9) { Write-Warning "Unity log remained locked; continuing with the in-memory redacted log." }
        else { Start-Sleep -Milliseconds 250 }
      }
    }
  }
  $log = $safeLog
  if ($process.ExitCode -ne 0 -or $log -notmatch "Deep Monkey Studio Unity bridge (smoke build|package validation) succeeded") {
    $tail = ($log -split "`r?`n" | Select-Object -Last 30) -join [Environment]::NewLine
    Write-Warning "Unity $($item.Version) validation failed.`n$tail"
    $results += [pscustomobject]@{ Version = $item.Version; Package = "failed"; WebGL = if ($method -eq "BridgeSmokeBuilder.Build") { "failed" } else { "not run" } }
    $hadFailures = $true
    continue
  }

  if ($method -eq "BridgeSmokeBuilder.Build") {
    $buildRoot = Join-Path $projectRoot "Build\WebGL"
    $manifestPath = Join-Path $buildRoot "bim-studio.manifest.json"
    $indexPath = Join-Path $buildRoot "index.html"
    $bridgePath = Join-Path $buildRoot "unity-bridge.js"
    $zipPath = Join-Path (Split-Path $buildRoot -Parent) "bim-studio-webgl.zip"
    if (-not (Test-Path -LiteralPath $manifestPath) -or -not (Test-Path -LiteralPath $bridgePath)) {
      throw "Unity $($item.Version) build did not contain Deep Monkey Studio bridge artifacts."
    }
    $index = Get-Content -LiteralPath $indexPath -Raw
    if ($index -notmatch 'unity-bridge\.js' -or $index -notmatch 'BimStudioUnityBridge\.register' -or $index -notmatch 'BimStudioUnityBridge\.createTrackedInstance') {
      throw "Unity $($item.Version) player did not register the Deep Monkey Studio browser bridge with tracked startup progress."
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.unityVersion -ne $item.Version -or $manifest.bridgeVersion -ne 1 -or $manifest.bridgePackageVersion -ne $bridgePackageVersion) {
      throw "Unity $($item.Version) manifest metadata is invalid."
    }
    $buildFiles = @(Get-ChildItem -LiteralPath $buildRoot -Recurse -File | ForEach-Object { $_.Name })
    foreach ($pattern in @('\.loader\.js$', '\.framework\.js(?:\.br|\.gz|\.unityweb)?$', '\.wasm(?:\.br|\.gz|\.unityweb)?$', '\.data(?:\.br|\.gz|\.unityweb)?$')) {
      if (-not ($buildFiles | Where-Object { $_ -match $pattern })) {
        throw "Unity $($item.Version) build is missing runtime artifact matching $pattern."
      }
    }
    if (-not (Test-Path -LiteralPath $zipPath)) { throw "Unity $($item.Version) one-click ZIP was not created." }
    $results += [pscustomobject]@{ Version = $item.Version; Package = "passed"; WebGL = "built + bridge injected" }
  } else {
    $results += [pscustomobject]@{ Version = $item.Version; Package = "passed"; WebGL = "module not installed" }
  }
}

$results | Format-Table -AutoSize
if ($hadFailures) { exit 1 }
