#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BaselineMsiPath,

    [Parameter(Mandatory = $true)]
    [string]$UpgradeMsiPath,

    [string]$ExpectedBaselineVersion = "0.0.9",
    [string]$ExpectedUpgradeVersion = "0.1.0",
    [string]$OutputDirectory = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProductName = "Deep Monkey Studio"
$ProductExecutable = "bim-studio-desktop.exe"
$ProfileDirectory = "com.bimstudio.devstudio"

function Resolve-InstallerPath([string]$Path, [string]$Label) {
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    if (-not $resolved.Path.EndsWith(".msi", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label 必须是 MSI 文件：$($resolved.Path)"
    }
    return $resolved.Path
}

function Get-ProductEntries {
    $registryPaths = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    return @(
        foreach ($registryPath in $registryPaths) {
            Get-ItemProperty -Path $registryPath -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -eq $ProductName }
        }
    )
}

function Invoke-Msi([string]$Operation, [string]$MsiPath, [string]$LogPath) {
    $arguments = "$Operation `"$MsiPath`" /qn /norestart /L*v `"$LogPath`""
    $process = Start-Process -FilePath "msiexec.exe" -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -notin @(0, 1641, 3010)) {
        throw "Windows Installer 执行失败，退出码 $($process.ExitCode)，日志：$LogPath"
    }
    return $process.ExitCode
}

function Wait-ProductVersion([string]$ExpectedVersion, [int]$TimeoutSeconds = 30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $entry = Get-ProductEntries | Where-Object { $_.DisplayVersion -eq $ExpectedVersion } | Select-Object -First 1
        if ($entry) { return $entry }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    $actual = (Get-ProductEntries | Select-Object -ExpandProperty DisplayVersion) -join ", "
    throw "未检测到版本 $ExpectedVersion，当前登记版本：$actual"
}

function Resolve-InstalledExecutable($Entry) {
    $candidates = @()
    if ($Entry.InstallLocation) {
        $candidates += Join-Path $Entry.InstallLocation $ProductExecutable
    }
    $candidates += Join-Path $env:ProgramFiles "Deep Monkey Studio\$ProductExecutable"
    $executable = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $executable) { throw "安装登记存在，但没有找到桌面主程序" }
    return (Resolve-Path -LiteralPath $executable).Path
}

function Assert-PackagedAppStarts([string]$ExecutablePath) {
    $process = Start-Process -FilePath $ExecutablePath -WorkingDirectory (Split-Path -Parent $ExecutablePath) -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 4
    $process.Refresh()
    if ($process.HasExited) { throw "桌面程序启动后提前退出，退出码 $($process.ExitCode)" }
    Stop-Process -Id $process.Id -Force
    $process.WaitForExit()
}

function Uninstall-Product($Entry, [string]$LogPath) {
    $productCode = $Entry.PSChildName
    if ($productCode -notmatch '^\{[0-9A-Fa-f-]{36}\}$') {
        throw "安装登记缺少有效 ProductCode：$productCode"
    }
    return Invoke-Msi "/x" $productCode $LogPath
}

$baselineMsi = Resolve-InstallerPath $BaselineMsiPath "基线安装包"
$upgradeMsi = Resolve-InstallerPath $UpgradeMsiPath "升级安装包"
if ($baselineMsi -eq $upgradeMsi) { throw "基线包和升级包不能是同一个文件" }
if (Get-ProductEntries) { throw "当前系统已安装 $ProductName；生命周期测试只允许在干净 Windows 环境运行" }

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "industrial-studio-lifecycle-$([Guid]::NewGuid().ToString('N'))"
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$profileRoot = Join-Path $env:APPDATA $ProfileDirectory
$profilePath = Join-Path $profileRoot "server-profile.json"
if (Test-Path -LiteralPath $profilePath) { throw "测试配置已存在，拒绝覆盖：$profilePath" }

$report = [ordered]@{
    startedAt = [DateTime]::UtcNow.ToString("o")
    machine = $env:COMPUTERNAME
    baselineMsi = $baselineMsi
    upgradeMsi = $upgradeMsi
    baselineInstalled = $false
    packagedAppStarted = $false
    profilePreservedAfterUpgrade = $false
    upgradeInstalled = $false
    uninstallCompleted = $false
    profilePreservedAfterUninstall = $false
}

try {
    Invoke-Msi "/i" $baselineMsi (Join-Path $OutputDirectory "01-baseline-install.log") | Out-Null
    $baselineEntry = Wait-ProductVersion $ExpectedBaselineVersion
    $report.baselineInstalled = $true
    Assert-PackagedAppStarts (Resolve-InstalledExecutable $baselineEntry)
    $report.packagedAppStarted = $true

    # 用确定性哨兵验证升级不会误删用户服务器配置。
    New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null
    $profile = [ordered]@{
        id = "lifecycle-test"
        name = "生命周期测试服务器"
        baseUrl = "https://lifecycle.invalid"
        expectedServerInstanceId = "lifecycle-test-instance"
    }
    # Windows PowerShell 5 的 UTF8 会附带 BOM；应用配置统一写为无 BOM UTF-8。
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($profilePath, ($profile | ConvertTo-Json), $utf8WithoutBom)
    $profileHash = (Get-FileHash -LiteralPath $profilePath -Algorithm SHA256).Hash

    Invoke-Msi "/i" $upgradeMsi (Join-Path $OutputDirectory "02-major-upgrade.log") | Out-Null
    $upgradeEntry = Wait-ProductVersion $ExpectedUpgradeVersion
    $report.upgradeInstalled = $true
    $report.profilePreservedAfterUpgrade = (Test-Path -LiteralPath $profilePath) -and
        ((Get-FileHash -LiteralPath $profilePath -Algorithm SHA256).Hash -eq $profileHash)
    if (-not $report.profilePreservedAfterUpgrade) { throw "覆盖升级后服务器配置未完整保留" }
    Assert-PackagedAppStarts (Resolve-InstalledExecutable $upgradeEntry)

    Uninstall-Product $upgradeEntry (Join-Path $OutputDirectory "03-uninstall.log") | Out-Null
    if (Get-ProductEntries) { throw "卸载后仍存在产品安装登记" }
    $report.uninstallCompleted = $true
    $report.profilePreservedAfterUninstall = Test-Path -LiteralPath $profilePath
    if (-not $report.profilePreservedAfterUninstall) { throw "卸载不应删除用户服务器配置" }
}
finally {
    $remaining = Get-ProductEntries | Select-Object -First 1
    if ($remaining) {
        try { Uninstall-Product $remaining (Join-Path $OutputDirectory "99-cleanup-uninstall.log") | Out-Null } catch { }
    }
    $report.finishedAt = [DateTime]::UtcNow.ToString("o")
    $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDirectory "report.json") -Encoding UTF8
}

Write-Output "Windows 安装、覆盖升级、配置保留与卸载验收通过：$OutputDirectory"
