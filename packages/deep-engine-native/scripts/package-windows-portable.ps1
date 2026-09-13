param(
  [string]$OutputRoot,
  [ValidatePattern('^[A-Za-z0-9_.-]+-pc-windows-msvc$')]
  [string]$Target = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'portable-package-common.ps1')
& (Join-Path $PSScriptRoot 'portable-package-common.test.ps1')

$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot = (Resolve-Path (Join-Path $packageRoot '../..')).Path
$cargoManifest = Join-Path $packageRoot 'Cargo.toml'
$cargoLock = Join-Path $packageRoot 'Cargo.lock'
if (-not $OutputRoot) {
  $OutputRoot = Join-Path $packageRoot 'artifacts/windows-portable'
} elseif (-not [IO.Path]::IsPathRooted($OutputRoot)) {
  $OutputRoot = Join-Path $packageRoot $OutputRoot
}
[void](New-Item -ItemType Directory -Force -Path $OutputRoot)
$OutputRoot = (Resolve-Path $OutputRoot).Path

$metadataJson = & cargo metadata --locked --format-version 1 --no-deps --manifest-path $cargoManifest
if ($LASTEXITCODE -ne 0) { throw 'cargo metadata failed.' }
$metadata = $metadataJson | ConvertFrom-Json
$package = @($metadata.packages | Where-Object name -eq 'deep-engine-native')
if ($package.Count -ne 1) { throw 'Cannot resolve the deep-engine-native package metadata.' }
$version = $package[0].version
$bundleName = "deep-engine-native-$version-$Target"
$stagingRoot = Join-Path $OutputRoot ".$bundleName.staging"
$stagedPackage = Join-Path $stagingRoot $bundleName
$temporaryArchive = Join-Path $stagingRoot "$bundleName.zip"
$temporaryArchiveHash = "$temporaryArchive.sha256"
$finalPackage = Join-Path $OutputRoot $bundleName
$finalArchive = Join-Path $OutputRoot "$bundleName.zip"
$finalArchiveHash = "$finalArchive.sha256"
$previousRoot = Join-Path $OutputRoot ".$bundleName.previous"
foreach ($path in @(
  $stagingRoot, $stagedPackage, $temporaryArchive, $temporaryArchiveHash,
  $finalPackage, $finalArchive, $finalArchiveHash, $previousRoot
)) {
  Assert-ChildPath -Root $OutputRoot -Path $path
}

if (Test-Path -LiteralPath $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
[void](New-Item -ItemType Directory -Path $stagedPackage)

try {
  $targetDirectory = Join-Path $packageRoot 'target/portable-windows'
  $rustFlagsName = 'CARGO_TARGET_' + $Target.ToUpperInvariant().Replace('-', '_') + '_RUSTFLAGS'
  $previousRustFlags = [Environment]::GetEnvironmentVariable($rustFlagsName, 'Process')
  try {
    [Environment]::SetEnvironmentVariable(
      $rustFlagsName,
      '-C target-feature=+crt-static',
      'Process'
    )
    & cargo build --locked --release --manifest-path $cargoManifest --target $Target --target-dir $targetDirectory
    if ($LASTEXITCODE -ne 0) { throw 'cargo release build failed.' }
  } finally {
    [Environment]::SetEnvironmentVariable($rustFlagsName, $previousRustFlags, 'Process')
  }

  $builtExecutable = Join-Path $targetDirectory "$Target/release/deep-engine-native.exe"
  if (-not (Test-Path -LiteralPath $builtExecutable -PathType Leaf)) {
    throw "Release executable is missing: $builtExecutable"
  }
  $binDirectory = Join-Path $stagedPackage 'bin'
  $fixtureDirectory = Join-Path $stagedPackage 'fixtures'
  $shaderDirectory = Join-Path $stagedPackage 'assets/shaders'
  $licenseDirectory = Join-Path $stagedPackage 'licenses'
  foreach ($directory in @($binDirectory, $fixtureDirectory, $shaderDirectory, $licenseDirectory)) {
    [void](New-Item -ItemType Directory -Force -Path $directory)
  }
  Copy-Item -LiteralPath $builtExecutable -Destination (Join-Path $binDirectory 'deep-engine-native.exe')
  Get-ChildItem -LiteralPath (Join-Path $packageRoot 'fixtures') -File -Filter '*.json' |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $fixtureDirectory }
  Copy-Item -LiteralPath (Join-Path $packageRoot 'tests/fixtures/runtime-package-v1.json') -Destination $fixtureDirectory
  Copy-Item -LiteralPath (Join-Path $packageRoot 'tests/fixtures/runtime-package-lod-v1.json') -Destination $fixtureDirectory
  Copy-Item -LiteralPath (Join-Path $packageRoot 'tests/fixtures/runtime-package-shader-v2.json') -Destination $fixtureDirectory
  Get-ChildItem -LiteralPath (Join-Path $packageRoot 'assets/shaders') -File -Filter '*.wgsl' |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $shaderDirectory }
  foreach ($licenseName in @('LICENSE', 'LICENSE.zh-CN.md', 'LICENSING.md', 'THIRD_PARTY_NOTICES.md')) {
    $source = Join-Path $repositoryRoot $licenseName
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Required repository license file is missing: $licenseName"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $licenseDirectory $licenseName)
  }

  $launcher = @'
@echo off
setlocal
"%~dp0bin\deep-engine-native.exe" --package "%~dp0fixtures\runtime-package-v1.json"
exit /b %ERRORLEVEL%
'@
  Write-Utf8File -Path (Join-Path $stagedPackage 'Run-Viewer.cmd') -Content $launcher
  $lodLauncher = @'
@echo off
setlocal
"%~dp0bin\deep-engine-native.exe" --package "%~dp0fixtures\runtime-package-lod-v1.json"
exit /b %ERRORLEVEL%
'@
  Write-Utf8File -Path (Join-Path $stagedPackage 'Run-LOD.cmd') -Content $lodLauncher
  $shaderLauncher = @'
@echo off
setlocal
"%~dp0bin\deep-engine-native.exe" --package "%~dp0fixtures\runtime-package-shader-v2.json"
exit /b %ERRORLEVEL%
'@
  Write-Utf8File -Path (Join-Path $stagedPackage 'Run-Shaders.cmd') -Content $shaderLauncher
  $readme = @"
Deep Engine Native Player $version ($Target)

Run-Viewer.cmd starts the native Player with the bundled runtime package.
The package contains the 3D scene, environment lighting and Deep2D content.
The EXE contains the WGSL shaders and does not require a WebView or browser runtime.
Run-LOD.cmd opens the LOD fixture using GPU selection for color and cascaded shadows.
Run-Shaders.cmd opens authored DeepSL materials with five texture slots, LOD and cascaded shadows.

Headless checks:
  bin\deep-engine-native.exe --headless-package fixtures\runtime-package-v1.json
  bin\deep-engine-native.exe --headless-contract fixtures\render_packet_v1.json
  bin\deep-engine-native.exe --headless-pbr fixtures\render_packet_textured_v1.json
"@
  Write-Utf8File -Path (Join-Path $stagedPackage 'README.txt') -Content $readme

  $packagedExecutable = Join-Path $binDirectory 'deep-engine-native.exe'
  $purity = Test-PortablePurity -PackageRoot $stagedPackage -Executable $packagedExecutable
  if (-not $purity.passed) {
    throw "Portable purity check failed: $($purity | ConvertTo-Json -Depth 6 -Compress)"
  }
  $embeddedShaders = Test-EmbeddedShaders -PackageRoot $stagedPackage -Executable $packagedExecutable
  $smokeChecks = @(Invoke-PortableSmoke -Executable $packagedExecutable -PackageRoot $stagedPackage)
  $payload = @(Get-PayloadInventory -PackageRoot $stagedPackage)
  $manifest = [ordered]@{
    schema = 'deep-engine.native-portable'
    schemaVersion = 2
    name = 'deep-engine-native'
    version = $version
    channel = 'beta'
    target = $Target
    profile = 'release'
    binary = 'bin/deep-engine-native.exe'
    launcher = 'Run-Viewer.cmd'
    shadersEmbedded = $true
    runtime = [ordered]@{
      rendering = 'wgpu'
      windowing = 'winit'
      browserShell = $false
    }
    toolchain = [ordered]@{
      rustc = (& rustc --version)
      cargo = (& cargo --version)
      staticCrt = $true
    }
    source = [ordered]@{
      cargoLockSha256 = Get-FileSha256 -Path $cargoLock
    }
    purity = $purity
    embeddedShaders = $embeddedShaders
    smoke = [ordered]@{
      passed = @($smokeChecks | Where-Object { -not $_.passed }).Count -eq 0
      checks = $smokeChecks
    }
    inventoryExcludes = @('manifest.json')
    files = $payload
  }
  $manifestJson = ($manifest | ConvertTo-Json -Depth 10) + "`n"
  Write-Utf8File -Path (Join-Path $stagedPackage 'manifest.json') -Content $manifestJson
  [void](Test-ManifestPayload -PackageRoot $stagedPackage)

  New-DeterministicZip -SourceRoot $stagedPackage -ArchivePath $temporaryArchive
  $zipVerification = Test-ZipMatchesDirectory -SourceRoot $stagedPackage -ArchivePath $temporaryArchive
  $archiveSha256 = Get-FileSha256 -Path $temporaryArchive
  Write-Utf8File -Path $temporaryArchiveHash -Content "$archiveSha256  $bundleName.zip`n"

  if (Test-Path -LiteralPath $previousRoot) {
    Remove-Item -LiteralPath $previousRoot -Recurse -Force
  }
  [void](New-Item -ItemType Directory -Path $previousRoot)
  foreach ($path in @($finalPackage, $finalArchive, $finalArchiveHash)) {
    if (Test-Path -LiteralPath $path) {
      Move-Item -LiteralPath $path -Destination $previousRoot
    }
  }
  try {
    Move-Item -LiteralPath $stagedPackage -Destination $finalPackage
    Move-Item -LiteralPath $temporaryArchive -Destination $finalArchive
    Move-Item -LiteralPath $temporaryArchiveHash -Destination $finalArchiveHash
  } catch {
    foreach ($path in @($finalPackage, $finalArchive, $finalArchiveHash)) {
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    Get-ChildItem -LiteralPath $previousRoot -Force | ForEach-Object {
      Move-Item -LiteralPath $_.FullName -Destination $OutputRoot
    }
    throw
  }
  Remove-Item -LiteralPath $previousRoot -Recurse -Force
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force

  [void](Test-ManifestPayload -PackageRoot $finalPackage)
  [void](Test-ZipMatchesDirectory -SourceRoot $finalPackage -ArchivePath $finalArchive)
  [void](Invoke-PortableSmoke -Executable (Join-Path $finalPackage 'bin/deep-engine-native.exe') -PackageRoot $finalPackage)
  if ((Get-FileSha256 -Path $finalArchive) -ne $archiveSha256) {
    throw 'Published ZIP hash changed after verification.'
  }
  [ordered]@{
    packageDirectory = $finalPackage
    archive = $finalArchive
    archiveSize = (Get-Item -LiteralPath $finalArchive).Length
    archiveSha256 = $archiveSha256
    files = $payload.Count + 1
    zipEntries = $zipVerification.entries
    smokeChecks = $smokeChecks.Count
    purityPassed = $purity.passed
  } | ConvertTo-Json -Depth 4
} catch {
  if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
  throw
}
