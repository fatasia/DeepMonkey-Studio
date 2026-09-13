param(
  [ValidateSet("debug", "release", "all")]
  [string]$Profile = "all",
  [switch]$SkipTests,
  [switch]$SmokeFrame
)

$ErrorActionPreference = "Stop"
$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $packageRoot "Cargo.toml"
$targetTriple = "x86_64-pc-windows-msvc"

& (Join-Path $PSScriptRoot "verify-dependencies.ps1") -Target $targetTriple
if (-not $SkipTests) {
  & cargo test --locked --manifest-path $manifestPath --target $targetTriple
  if ($LASTEXITCODE -ne 0) { throw "cargo test failed" }
}

$profiles = if ($Profile -eq "all") { @("debug", "release") } else { @($Profile) }
$artifacts = @()
foreach ($item in $profiles) {
  if ($item -eq "release") {
    & cargo build --locked --manifest-path $manifestPath --target $targetTriple --release
  } else {
    & cargo build --locked --manifest-path $manifestPath --target $targetTriple
  }
  if ($LASTEXITCODE -ne 0) { throw "cargo build $item failed" }
  $binary = Join-Path $packageRoot "target/$targetTriple/$item/deep-engine-native.exe"
  if (-not (Test-Path -LiteralPath $binary)) { throw "missing native binary: $binary" }
  $file = Get-Item -LiteralPath $binary
  $artifacts += [ordered]@{
    profile = $item
    path = $file.FullName
    bytes = $file.Length
    sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

if ($SmokeFrame) {
  $smokeBinary = Join-Path $packageRoot "target/$targetTriple/debug/deep-engine-native.exe"
  if (-not (Test-Path -LiteralPath $smokeBinary)) {
    & cargo build --locked --manifest-path $manifestPath --target $targetTriple
  }
  & $smokeBinary --smoke-frame
  if ($LASTEXITCODE -ne 0) { throw "native smoke frame failed" }
}

$artifactDirectory = Join-Path $packageRoot "artifacts"
New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
$manifest = [ordered]@{
  schema = "deep-engine.native-build"
  version = 1
  target = $targetTriple
  rustc = (& rustc --version)
  cargo = (& cargo --version)
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  smokeFrameVerified = [bool]$SmokeFrame
  artifacts = $artifacts
}
$output = Join-Path $artifactDirectory "native-build-manifest.json"
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $output -Encoding utf8
Write-Output "Native build manifest: $output"
