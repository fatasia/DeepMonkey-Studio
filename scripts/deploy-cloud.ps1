param(
  [switch]$Check,
  [switch]$SkipBuild,
  [switch]$Stop,
  [switch]$NoAutostart
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $repositoryRoot ".runtime"
$runner = Join-Path $PSScriptRoot "run-production.ps1"
# Windows PowerShell 5.1 uses .NET Framework; avoid APIs added in modern .NET.
$sha256 = [System.Security.Cryptography.SHA256CryptoServiceProvider]::new()
try {
  $rootHashBytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($repositoryRoot))
} finally {
  if ($sha256) { $sha256.Dispose() }
}
$rootHash = (($rootHashBytes | ForEach-Object { $_.ToString("x2") }) -join "").Substring(0, 8)
$taskName = "DeepMonkeyStudioServer-$rootHash"
$pidFile = Join-Path $runtimeDirectory "production.pid"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Stop-NativeServer {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  if (Test-Path -LiteralPath $pidFile) {
    $savedPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -like "*$runner*") {
      & taskkill.exe /PID $savedPid /T /F | Out-Null
    }
    Remove-Item -LiteralPath $pidFile -Force
  }
}

Set-Location -LiteralPath $repositoryRoot
if ($Stop) {
  Stop-NativeServer
  Write-Output "原生云服务已停止。"
  exit 0
}

$env:NODE_ENV = "production"
pnpm --filter @bim-studio/api check:production
if ($LASTEXITCODE -ne 0) { throw "生产预检失败" }
if ($Check) { exit 0 }

if (-not $SkipBuild) {
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "依赖安装失败" }
  pnpm build
  if ($LASTEXITCODE -ne 0) { throw "生产构建失败" }
}

Stop-NativeServer
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$powershellPath = (Get-Command powershell.exe).Source

if ((Test-Administrator) -and -not $NoAutostart) {
  $action = New-ScheduledTaskAction -Execute $powershellPath -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -NodePath `"$nodePath`"" -WorkingDirectory $repositoryRoot
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -User "SYSTEM" | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Output "已注册原生 Windows 服务任务：$taskName"
} else {
  $process = Start-Process -FilePath $powershellPath -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $runner, "-NodePath", $nodePath) -WorkingDirectory $repositoryRoot -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
  Write-Warning "当前未注册开机自启；请以管理员运行，或移除 -NoAutostart。"
}

$apiPort = if ($env:API_PORT) { [int]$env:API_PORT } else { 4100 }
$healthUrl = "http://127.0.0.1:$apiPort/api/meta"
$deadline = (Get-Date).AddSeconds(90)
do {
  try {
    $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) {
      Write-Output "云服务部署成功：$healthUrl"
      exit 0
    }
  } catch { Start-Sleep -Milliseconds 800 }
} while ((Get-Date) -lt $deadline)

throw "服务健康检查超时，请查看 .runtime-logs\production.err.log"
