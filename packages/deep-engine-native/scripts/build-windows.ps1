param(
  [ValidateSet("debug", "release", "all")]
  [string]$Profile = "all",
  [switch]$SkipTests,
  [switch]$SmokeFrame
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'portable-provenance.ps1')
$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $packageRoot "Cargo.toml"
$targetTriple = "x86_64-pc-windows-msvc"
$buildInputFingerprint = Get-NativeBuildInputFingerprint -PackageRoot $packageRoot

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
    path = Get-ProvenanceRelativeUnixPath -Root $packageRoot -Path $file.FullName
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
$sbomPath = Join-Path $artifactDirectory 'native-build-sbom-input.json'
$supplyChain = Write-NativeSupplyChainEvidence -PackageRoot $packageRoot -Target $targetTriple `
  -Destination $sbomPath -LogicalPath 'native-build-sbom-input.json' -Profile $Profile -RustFlags ''
if ($supplyChain.buildInputFingerprint -cne $buildInputFingerprint) {
  throw 'Native build inputs changed while the Windows artifacts were being compiled or tested.'
}
$manifest = [ordered]@{
  schema = "deep-engine.native-build"
  version = 2
  target = $targetTriple
  supplyChain = $supplyChain
  smokeFrameVerified = [bool]$SmokeFrame
  artifacts = $artifacts
}
$output = Join-Path $artifactDirectory "native-build-manifest.json"
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $output -Encoding utf8
Write-Output "Native build manifest: $output"
