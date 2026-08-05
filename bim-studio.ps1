[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "restart", "status", "help")]
    [string]$Action = "status",

    [Parameter(Position = 1)]
    [ValidateSet("all", "app", "api", "web", "node-red", "minio", "postgres")]
    [string]$Target = "all",

    [switch]$Https
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDirectory = Join-Path $ProjectRoot "data\runtime"
$LogDirectory = Join-Path $ProjectRoot "data\logs"
$CacheDirectory = Join-Path $ProjectRoot ".cache"
$TemporaryDirectory = Join-Path $CacheDirectory "temp"
$EnvFile = Join-Path $ProjectRoot ".env"

function Write-Info([string]$Message) {
    Write-Host "[BIM Studio] $Message" -ForegroundColor Cyan
}

function Write-Success([string]$Message) {
    Write-Host "[BIM Studio] $Message" -ForegroundColor Green
}

function Write-WarningMessage([string]$Message) {
    Write-Host "[BIM Studio] $Message" -ForegroundColor Yellow
}

function Get-DotEnvValue([string]$Name) {
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        return $null
    }

    $match = Get-Content -LiteralPath $EnvFile |
        Where-Object { $_ -match "^$([regex]::Escape($Name))=" } |
        Select-Object -First 1
    if (-not $match) {
        return $null
    }

    return ($match -split "=", 2)[1].Trim().Trim('"').Trim("'")
}

function Import-DotEnvVariables([string[]]$Names) {
    foreach ($name in $Names) {
        $configuredValue = Get-DotEnvValue $name
        if ($null -ne $configuredValue) {
            Set-Item -Path "Env:$name" -Value $configuredValue
        }
    }
}

function Ensure-RuntimeDirectories {
    New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $TemporaryDirectory -Force | Out-Null
    $env:TEMP = $TemporaryDirectory
    $env:TMP = $TemporaryDirectory
    if (-not $env:BIM_STUDIO_WORKER_ROOT) {
        $configuredWorkerRoot = Get-DotEnvValue "BIM_STUDIO_WORKER_ROOT"
        $env:BIM_STUDIO_WORKER_ROOT = if ($configuredWorkerRoot) { $configuredWorkerRoot } else { Join-Path $CacheDirectory "revit-worker" }
    }
}

function Get-PidFile([string]$Name) {
    return Join-Path $RuntimeDirectory "$Name.pid"
}

function Read-ManagedProcessId([string]$Name) {
    $pidFile = Get-PidFile $Name
    if (-not (Test-Path -LiteralPath $pidFile)) {
        return $null
    }

    $value = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    $parsed = 0
    if ([int]::TryParse($value, [ref]$parsed)) {
        return $parsed
    }

    return $null
}

function Save-ManagedProcessId([string]$Name, [int]$ProcessIdValue) {
    Ensure-RuntimeDirectories
    Set-Content -LiteralPath (Get-PidFile $Name) -Value $ProcessIdValue -Encoding ascii
}

function Remove-ManagedProcessId([string]$Name) {
    $pidFile = Get-PidFile $Name
    if (Test-Path -LiteralPath $pidFile) {
        Remove-Item -LiteralPath $pidFile -Force
    }
}

function Test-ProcessExists([int]$ProcessIdValue) {
    return $null -ne (Get-Process -Id $ProcessIdValue -ErrorAction SilentlyContinue)
}

function Get-ListeningProcessId([int[]]$Ports) {
    foreach ($port in $Ports) {
        $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($listener) {
            return [int]$listener.OwningProcess
        }
    }

    return $null
}

function Test-ProjectProcess([int]$ProcessIdValue, [string]$Name) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessIdValue" -ErrorAction SilentlyContinue
    if (-not $process) {
        return $false
    }

    if ($Name -eq "minio") {
        $expectedPath = Get-MinioExecutable
        return $process.ExecutablePath -and
            ([string]::Equals($process.ExecutablePath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase))
    }

    if ($process.CommandLine -and
        $process.CommandLine.IndexOf($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $true
    }

    # A manually started API may use a relative entry path, so its command line
    # does not contain the project root. Confirm both its entry point and its
    # application-specific health response before allowing the script to stop it.
    if ($Name -eq "api" -and $process.CommandLine -match 'apps[\\/]api[\\/](dist[\\/]index\.js|src[\\/]index\.ts)') {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:4100/health" -TimeoutSec 3
            return $health.status -eq "ok" -and $health.service -eq "bim-studio-api"
        } catch {
            return $false
        }
    }

    return $false
}

function Stop-ProcessTree([int]$ProcessIdValue) {
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessIdValue" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        Stop-ProcessTree ([int]$child.ProcessId)
    }

    if (Test-ProcessExists $ProcessIdValue) {
        Stop-Process -Id $ProcessIdValue -Force -ErrorAction SilentlyContinue
    }
}

function Wait-ForPort([int]$Port, [bool]$ShouldListen, [int]$TimeoutSeconds = 30) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $listening = $null -ne (Get-ListeningProcessId @($Port))
        if ($listening -eq $ShouldListen) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Get-PnpmExecutable {
    $command = Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue
    if (-not $command) {
        $command = Get-Command "pnpm" -ErrorAction SilentlyContinue
    }
    if (-not $command) {
        throw "找不到 pnpm。请先安装 pnpm，并确保它在 PATH 中。"
    }
    return $command.Source
}

function Get-MinioExecutable {
    if ($env:BIM_STUDIO_MINIO_EXE) {
        return $env:BIM_STUDIO_MINIO_EXE
    }

    $mcPath = Get-DotEnvValue "MINIO_MC_PATH"
    if ($mcPath) {
        return Join-Path (Split-Path -Parent $mcPath) "minio.exe"
    }

    return "D:\Documents\bim\minio\bin\minio.exe"
}

function Get-MinioDataDirectory {
    if ($env:BIM_STUDIO_MINIO_DATA) {
        return $env:BIM_STUDIO_MINIO_DATA
    }

    $minioExecutable = Get-MinioExecutable
    return Join-Path (Split-Path -Parent (Split-Path -Parent $minioExecutable)) "data"
}

function Get-PostgresServiceName {
    if ($env:BIM_STUDIO_POSTGRES_SERVICE) {
        return $env:BIM_STUDIO_POSTGRES_SERVICE
    }

    $service = Get-Service -Name "postgresql-x64-*" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if (-not $service) {
        throw "未找到 PostgreSQL Windows 服务。可通过 BIM_STUDIO_POSTGRES_SERVICE 指定服务名。"
    }
    return $service.Name
}

function Start-BackgroundService(
    [string]$Name,
    [string]$Executable,
    [string[]]$Arguments,
    [int]$Port
) {
    $existingId = Get-ListeningProcessId @($Port)
    if ($existingId) {
        Write-WarningMessage "$Name 已在运行（PID $existingId，端口 $Port）。"
        return
    }

    Ensure-RuntimeDirectories
    $stdout = Join-Path $LogDirectory "$Name.out.log"
    $stderr = Join-Path $LogDirectory "$Name.err.log"
    $startOptions = @{
        FilePath = $Executable
        ArgumentList = $Arguments
        WorkingDirectory = $ProjectRoot
        WindowStyle = "Hidden"
        RedirectStandardOutput = $stdout
        RedirectStandardError = $stderr
        PassThru = $true
    }
    $process = Start-Process @startOptions

    Save-ManagedProcessId $Name $process.Id
    if (-not (Wait-ForPort $Port $true 45)) {
        Stop-ProcessTree $process.Id
        Remove-ManagedProcessId $Name
        $errorTail = if (Test-Path -LiteralPath $stderr) {
            (Get-Content -LiteralPath $stderr -Tail 30) -join [Environment]::NewLine
        } else {
            "没有错误日志"
        }
        throw "$Name 启动超时，日志：$stderr`n$errorTail"
    }

    Write-Success "$Name 已启动（管理 PID $($process.Id)，端口 $Port）。"
}

function Stop-BackgroundService([string]$Name, [int[]]$Ports) {
    $managedId = Read-ManagedProcessId $Name
    if ($managedId -and (Test-ProcessExists $managedId)) {
        Stop-ProcessTree $managedId
        Remove-ManagedProcessId $Name
        foreach ($port in $Ports) {
            [void](Wait-ForPort $port $false 15)
        }
        Write-Success "$Name 已关闭。"
        return
    }

    Remove-ManagedProcessId $Name
    $listenerId = Get-ListeningProcessId $Ports
    if (-not $listenerId) {
        Write-Info "$Name 未运行。"
        return
    }

    if (-not (Test-ProjectProcess $listenerId $Name)) {
        throw "端口 $($Ports -join '/') 被非 BIM Studio 进程 PID $listenerId 占用，已拒绝关闭。"
    }

    Stop-ProcessTree $listenerId
    Write-WarningMessage "$Name 不是由本脚本启动，已关闭其监听进程 PID $listenerId；如果原终端有 watch 进程，请同时在原终端按 Ctrl+C。"
}

function Start-Api {
    Start-BackgroundService "api" (Get-PnpmExecutable) @("--filter", "@bim-studio/api", "dev") 4100
}

function Start-Web {
    if ($Https) {
        $env:BIM_STUDIO_HTTPS = "true"
    }
    Start-BackgroundService "web" (Get-PnpmExecutable) @("--filter", "@bim-studio/web", "dev") 5173
}

function Start-NodeRed {
    Import-DotEnvVariables @(
        "NODE_RED_HOST", "NODE_RED_PORT", "NODE_RED_CREDENTIAL_SECRET",
        "TDENGINE_REST_URL", "TDENGINE_WS_URL", "TDENGINE_DATABASE", "TDENGINE_USER", "TDENGINE_PASSWORD",
        "ORACLE_HOST", "ORACLE_PORT", "ORACLE_DATABASE", "ORACLE_USER", "ORACLE_PASSWORD",
        "BIM_MODEL_ID"
    )
    $nodeRedCredentials = Join-Path $ProjectRoot "apps\node-red\flows_cred.json"
    $nodeRedCredentialsTemplate = Join-Path $ProjectRoot "apps\node-red\flows_cred.example.json"
    if (-not (Test-Path -LiteralPath $nodeRedCredentials)) {
        Copy-Item -LiteralPath $nodeRedCredentialsTemplate -Destination $nodeRedCredentials
    }
    $oracleClientDirectory = if ($env:ORACLE_INSTANT_CLIENT_DIR) {
        $env:ORACLE_INSTANT_CLIENT_DIR
    } else {
        $configuredOracleDirectory = Get-DotEnvValue "ORACLE_INSTANT_CLIENT_DIR"
        if ($configuredOracleDirectory) { $configuredOracleDirectory } else { "D:\Documents\bim\oracle\instantclient_19_31" }
    }
    if (Test-Path -LiteralPath (Join-Path $oracleClientDirectory "oci.dll")) {
        $pathEntries = $env:Path -split ";"
        if ($pathEntries -notcontains $oracleClientDirectory) {
            $env:Path = "$oracleClientDirectory;$env:Path"
        }
        $env:ORACLE_INSTANT_CLIENT_DIR = $oracleClientDirectory
        if (-not $env:TNS_ADMIN) {
            $configuredTnsAdmin = Get-DotEnvValue "TNS_ADMIN"
            $env:TNS_ADMIN = if ($configuredTnsAdmin) { $configuredTnsAdmin } else { Join-Path $oracleClientDirectory "network\admin" }
        }
    }
    Start-BackgroundService "node-red" (Get-PnpmExecutable) @("--filter", "@bim-studio/node-red", "dev") 1880
}

function Start-Minio {
    $executable = Get-MinioExecutable
    $dataDirectory = Get-MinioDataDirectory
    if (-not (Test-Path -LiteralPath $executable)) {
        throw "MinIO 程序不存在：$executable"
    }
    if (-not (Test-Path -LiteralPath $dataDirectory)) {
        New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
    }

    Start-BackgroundService "minio" $executable @(
        "server", $dataDirectory,
        "--console-address", ":9001",
        "--address", ":9000"
    ) 9000
}

function Start-Postgres {
    $serviceName = Get-PostgresServiceName
    $service = Get-Service -Name $serviceName
    if ($service.Status -eq "Running") {
        Write-WarningMessage "postgres 已在运行（Windows 服务 $serviceName）。"
        return
    }

    try {
        Start-Service -Name $serviceName
        (Get-Service -Name $serviceName).WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
        Write-Success "postgres 已启动（Windows 服务 $serviceName）。"
    } catch {
        throw "PostgreSQL 启动失败。请以管理员身份运行 PowerShell。原始错误：$($_.Exception.Message)"
    }
}

function Stop-Postgres {
    $serviceName = Get-PostgresServiceName
    $service = Get-Service -Name $serviceName
    if ($service.Status -eq "Stopped") {
        Write-Info "postgres 未运行。"
        return
    }

    try {
        Stop-Service -Name $serviceName
        (Get-Service -Name $serviceName).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
        Write-Success "postgres 已关闭（Windows 服务 $serviceName）。"
    } catch {
        throw "PostgreSQL 关闭失败。请以管理员身份运行 PowerShell。原始错误：$($_.Exception.Message)"
    }
}

function Start-One([string]$Name) {
    switch ($Name) {
        "postgres" { Start-Postgres }
        "minio" { Start-Minio }
        "api" { Start-Api }
        "web" { Start-Web }
        "node-red" { Start-NodeRed }
        default { throw "未知服务：$Name" }
    }
}

function Stop-One([string]$Name) {
    switch ($Name) {
        "web" { Stop-BackgroundService "web" @(5173) }
        "node-red" { Stop-BackgroundService "node-red" @(1880) }
        "api" { Stop-BackgroundService "api" @(4100) }
        "minio" { Stop-BackgroundService "minio" @(9000, 9001) }
        "postgres" { Stop-Postgres }
        default { throw "未知服务：$Name" }
    }
}

function Get-TargetServices([string]$Name, [bool]$Reverse = $false) {
    [string[]]$services = switch ($Name) {
        "all" { @("postgres", "minio", "node-red", "api", "web") }
        "app" { @("node-red", "api", "web") }
        default { @($Name) }
    }

    if ($Reverse) {
        [array]::Reverse($services)
    }
    return $services
}

function Get-ServiceStatusRow([string]$Name, [int[]]$Ports) {
    $listenerId = Get-ListeningProcessId $Ports
    $managedId = Read-ManagedProcessId $Name
    $managed = $managedId -and (Test-ProcessExists $managedId)
    return [pscustomobject]@{
        Service = $Name
        Status = if ($listenerId) { "running" } else { "stopped" }
        Port = $Ports -join "/"
        Pid = if ($listenerId) { $listenerId } else { "-" }
        Managed = if ($managed) { "yes" } else { "no" }
    }
}

function Show-Status([string[]]$Names) {
    $rows = foreach ($name in $Names) {
        switch ($name) {
            "api" { Get-ServiceStatusRow "api" @(4100) }
            "web" { Get-ServiceStatusRow "web" @(5173) }
            "node-red" { Get-ServiceStatusRow "node-red" @(1880) }
            "minio" { Get-ServiceStatusRow "minio" @(9000, 9001) }
            "postgres" {
                $serviceName = Get-PostgresServiceName
                $service = Get-Service -Name $serviceName
                $postgresProcessId = Get-ListeningProcessId @(5432)
                [pscustomobject]@{
                    Service = "postgres"
                    Status = $service.Status.ToString().ToLowerInvariant()
                    Port = "5432"
                    Pid = if ($postgresProcessId) { $postgresProcessId } else { "-" }
                    Managed = "windows-service"
                }
            }
        }
    }

    $rows | Format-Table -AutoSize
}

function Show-Help {
    Write-Host @"
BIM Studio 服务管理

用法：
  .\bim-studio.ps1 <start|stop|restart|status> <all|app|api|web|node-red|minio|postgres> [-Https]

示例：
  .\bim-studio.ps1 start all        启动全部服务
  .\bim-studio.ps1 stop app         只关闭 API 和 Web
  .\bim-studio.ps1 restart api      只重启 API
  .\bim-studio.ps1 status all       查看全部状态

端口：
  Web 5173 | API 4100 | Node-RED 1880 | MinIO 9000/9001 | PostgreSQL 5432

日志：
  $LogDirectory

说明：
  PostgreSQL 是 Windows 服务，启动或关闭它可能需要管理员权限。
  如果 PowerShell 禁止执行脚本，可使用：
  powershell -ExecutionPolicy Bypass -File .\bim-studio.ps1 status all
"@
}

try {
    if ($Action -eq "help") {
        Show-Help
        exit 0
    }

    $serviceNames = Get-TargetServices $Target ($Action -eq "stop")
    switch ($Action) {
        "start" {
            foreach ($name in $serviceNames) { Start-One $name }
            Show-Status (Get-TargetServices $Target)
        }
        "stop" {
            foreach ($name in $serviceNames) { Stop-One $name }
            Show-Status (Get-TargetServices $Target)
        }
        "restart" {
            $stopNames = Get-TargetServices $Target $true
            foreach ($name in $stopNames) { Stop-One $name }
            foreach ($name in (Get-TargetServices $Target)) { Start-One $name }
            Show-Status (Get-TargetServices $Target)
        }
        "status" {
            Show-Status $serviceNames
        }
    }
} catch {
    Write-Host "[BIM Studio] 失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
