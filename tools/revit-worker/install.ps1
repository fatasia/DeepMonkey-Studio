[CmdletBinding()]
param(
    [ValidateSet("2023", "2026", "all")]
    [string]$Version = "all"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ToolRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ToolRoot)
$WorkerProject = Join-Path $ToolRoot "src\BimStudio.RevitWorker\BimStudio.RevitWorker.csproj"
$AddinProject = Join-Path $ToolRoot "src\BimStudio.RevitAddin\BimStudio.RevitAddin.csproj"
$PublishDirectory = Join-Path $ToolRoot "publish"
$BuildDirectory = Join-Path $ToolRoot "build"
$TemplatePath = Join-Path $ToolRoot "BimStudio.RevitAddin.addin.template"
$EnvFile = Join-Path $ProjectRoot ".env"

function Get-DotEnvValue([string]$Name) {
    if (-not (Test-Path -LiteralPath $EnvFile)) { return $null }
    $line = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -First 1
    if (-not $line) { return $null }
    return ($line -split "=", 2)[1].Trim().Trim('"').Trim("'")
}

$WorkerCacheRoot = Get-DotEnvValue "BIM_STUDIO_WORKER_ROOT"
if (-not $WorkerCacheRoot) { $WorkerCacheRoot = Join-Path $ProjectRoot ".cache\revit-worker" }
$WorkerCacheRoot = [System.IO.Path]::GetFullPath($WorkerCacheRoot)
New-Item -ItemType Directory -Path $WorkerCacheRoot -Force | Out-Null

function Get-RevitDirectory([string]$TargetVersion) {
    $executable = Get-DotEnvValue "REVIT_${TargetVersion}_PATH"
    if ($executable -and (Test-Path -LiteralPath $executable)) { return Split-Path -Parent $executable }
    $fallback = Join-Path $env:ProgramFiles "Autodesk\Revit $TargetVersion"
    if (Test-Path -LiteralPath (Join-Path $fallback "Revit.exe")) { return $fallback }
    throw "找不到 Revit $TargetVersion。请在 .env 配置 REVIT_${TargetVersion}_PATH。"
}

function Get-BimStudioSigningCertificate {
    $subject = "CN=BIM Studio Internal"
    $certificate = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
        Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date).AddDays(30) } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1
    if (-not $certificate) {
        $certificate = New-SelfSignedCertificate `
            -Type CodeSigningCert `
            -Subject $subject `
            -CertStoreLocation Cert:\CurrentUser\My `
            -KeyAlgorithm RSA `
            -KeyLength 3072 `
            -HashAlgorithm SHA256 `
            -KeyExportPolicy Exportable `
            -NotAfter (Get-Date).AddYears(5)
    }

    $certificateFile = Join-Path ([System.IO.Path]::GetTempPath()) "bim-studio-internal-signing.cer"
    Export-Certificate -Cert $certificate -FilePath $certificateFile -Force | Out-Null
    Import-Certificate -FilePath $certificateFile -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
    Import-Certificate -FilePath $certificateFile -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
    Remove-Item -LiteralPath $certificateFile -Force
    return $certificate
}

dotnet publish $WorkerProject -c Release -o $PublishDirectory --nologo
if ($LASTEXITCODE -ne 0) { throw "Revit Worker 发布失败" }

$signingCertificate = Get-BimStudioSigningCertificate
$versions = if ($Version -eq "all") { @("2023", "2026") } else { @($Version) }
foreach ($targetVersion in $versions) {
    $revitDirectory = Get-RevitDirectory $targetVersion
    $outputDirectory = Join-Path $BuildDirectory $targetVersion
    dotnet build $AddinProject -c Release -o $outputDirectory -p:RevitVersion=$targetVersion "-p:RevitInstallDir=$revitDirectory" --nologo
    if ($LASTEXITCODE -ne 0) { throw "Revit $targetVersion Add-in 编译失败" }

    $manifestDirectory = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$targetVersion"
    $installDirectory = Join-Path $manifestDirectory "BimStudio"
    New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
    Copy-Item -Path (Join-Path $outputDirectory "*") -Destination $installDirectory -Force
    Set-Content -LiteralPath (Join-Path $installDirectory "worker-root.txt") -Value $WorkerCacheRoot -Encoding utf8
    $assemblyPath = Join-Path $installDirectory "BimStudio.RevitAddin.dll"
    $signature = Set-AuthenticodeSignature -FilePath $assemblyPath -Certificate $signingCertificate -HashAlgorithm SHA256
    if ($signature.Status -ne "Valid") { throw "Revit $targetVersion Add-in 签名失败：$($signature.StatusMessage)" }
    $manifest = (Get-Content -LiteralPath $TemplatePath -Raw).Replace("{{ASSEMBLY_PATH}}", $assemblyPath)
    Set-Content -LiteralPath (Join-Path $manifestDirectory "BimStudio.RevitAddin.addin") -Value $manifest -Encoding utf8
    Write-Host "[BIM Studio] Revit $targetVersion Add-in 已安装：$assemblyPath" -ForegroundColor Green
    Write-Host "[BIM Studio] Add-in 已使用当前用户的 BIM Studio Internal 证书签名。" -ForegroundColor Green
}

Write-Host "[BIM Studio] 常驻 Worker 已发布：$(Join-Path $PublishDirectory 'BimStudio.RevitWorker.exe')" -ForegroundColor Green
Write-Host "[BIM Studio] Worker 缓存目录：$WorkerCacheRoot" -ForegroundColor Green
Write-Host "[BIM Studio] 请重启已打开的 Revit，使 Add-in 生效。" -ForegroundColor Yellow
