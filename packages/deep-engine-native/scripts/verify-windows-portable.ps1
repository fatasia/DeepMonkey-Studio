param(
  [Parameter(Mandatory)]
  [string]$PackageRoot,
  [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'portable-package-common.ps1')

$PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
$manifest = Test-ManifestPayload -PackageRoot $PackageRoot
$executable = Join-Path $PackageRoot ($manifest.binary.Replace('/', [IO.Path]::DirectorySeparatorChar))
Assert-ChildPath -Root $PackageRoot -Path $executable
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "Packaged executable is missing: $executable"
}

$purity = Test-PortablePurity -PackageRoot $PackageRoot -Executable $executable
if (-not $purity.passed) {
  throw "Portable purity check failed: $($purity | ConvertTo-Json -Depth 6 -Compress)"
}
$compatibilityWorker = if ($manifest.PSObject.Properties.Name -contains 'compatibilityWorker') {
  Test-CompatibilityWorker -PackageRoot $PackageRoot -Worker $manifest.compatibilityWorker
} else { $null }
$embeddedShaders = Test-EmbeddedShaders -PackageRoot $PackageRoot -Executable $executable
$smoke = @(Invoke-PortableSmoke -Executable $executable -PackageRoot $PackageRoot -IncludeRuntimeDetails)

if (-not $ArchivePath) { $ArchivePath = "$PackageRoot.zip" }
$ArchivePath = (Resolve-Path -LiteralPath $ArchivePath).Path
$zip = Test-ZipMatchesDirectory -SourceRoot $PackageRoot -ArchivePath $ArchivePath
$archiveSha256 = Get-FileSha256 -Path $ArchivePath
$hashPath = "$ArchivePath.sha256"
if (-not (Test-Path -LiteralPath $hashPath -PathType Leaf)) {
  throw "Archive checksum file is missing: $hashPath"
}
$expectedLine = "$archiveSha256  $([IO.Path]::GetFileName($ArchivePath))"
if ((Get-Content -LiteralPath $hashPath -Raw).Trim() -cne $expectedLine) {
  throw 'Archive checksum file does not match the verified ZIP.'
}

[ordered]@{
  schema = 'deep-engine.native-beta-verification'
  schemaVersion = 1
  package = $PackageRoot
  archive = $ArchivePath
  archiveBytes = (Get-Item -LiteralPath $ArchivePath).Length
  archiveSha256 = $archiveSha256
  payloadFiles = @($manifest.files).Count + 1
  zipEntries = $zip.entries
  purity = $purity
  compatibilityWorker = $compatibilityWorker
  embeddedShaders = $embeddedShaders
  smoke = $smoke
} | ConvertTo-Json -Depth 10
