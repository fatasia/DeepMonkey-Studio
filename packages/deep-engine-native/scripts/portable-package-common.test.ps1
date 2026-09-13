$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'portable-package-common.ps1')

function Assert-Rejected {
  param([scriptblock]$Action, [string]$Message)
  try { & $Action | Out-Null }
  catch {
    if ($_.Exception.Message.Contains($Message)) { return }
    throw "Expected '$Message', got: $($_.Exception.Message)"
  }
  throw "Expected rejection: $Message"
}

$testParent = Join-Path $PSScriptRoot '../target/package-verifier-tests'
$testRoot = Join-Path $testParent ([Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Force -Path $testRoot)
$testParent = (Resolve-Path -LiteralPath $testParent).Path
$testRoot = (Resolve-Path -LiteralPath $testRoot).Path
Assert-ChildPath -Root $testParent -Path $testRoot

try {
  $executable = Join-Path $testRoot 'player.exe'
  Write-Utf8File -Path $executable -Content 'MZ native test image'
  if (-not (Test-PortablePurity -PackageRoot $testRoot -Executable $executable).passed) {
    throw 'Clean native payload was rejected'
  }
  [IO.File]::WriteAllBytes($executable, [Text.Encoding]::Unicode.GetBytes('MZ WebView2Loader.dll'))
  # PE signature is checked separately; retain valid MZ bytes before the UTF-16 marker.
  $bytes = [IO.File]::ReadAllBytes($executable)
  $bytes[0] = 0x4d
  $bytes[1] = 0x5a
  [IO.File]::WriteAllBytes($executable, $bytes)
  $purity = Test-PortablePurity -PackageRoot $testRoot -Executable $executable
  if ($purity.passed -or 'WebView2Loader.dll' -notin $purity.matchedBinaryMarkers) {
    throw 'UTF-16 browser dependency marker escaped detection'
  }

  # A manifest cannot override a fresh purity result, even if its own gates claim success.
  $manifest = [ordered]@{
    schema = 'deep-engine.native-portable'; schemaVersion = 2; channel = 'beta'
    runtime = @{ browserShell = $false }; binary = 'player.exe'
    purity = @{ passed = $true }; embeddedShaders = @{ passed = $true }
    smoke = @{ passed = $true; checks = @(@{ name = 'gpu-first-frame'; passed = $true }) }
    files = @(Get-PayloadInventory -PackageRoot $testRoot)
  }
  Write-Utf8File -Path (Join-Path $testRoot 'manifest.json') -Content ($manifest | ConvertTo-Json -Depth 8)
  Assert-Rejected {
    & (Join-Path $PSScriptRoot 'verify-windows-portable.ps1') -PackageRoot $testRoot
  } 'Portable purity check failed'

  $shaderRoot = Join-Path $testRoot 'assets/shaders'
  [void](New-Item -ItemType Directory -Force -Path $shaderRoot)
  $required = [ordered]@{
    'native_mesh_v1.wgsl' = 'Deep Engine native mesh shader contract v1'
    'native_cascaded_shadow_v1.wgsl' = 'Deep Engine native cascaded shadow sampling contract v1'
    'native_gpu_culling_v1.wgsl' = 'Deep Engine native GPU instance culling contract v1'
    'native_gpu_lod_v1.wgsl' = 'Deep Engine native GPU LOD contract v1'
    'native_deep2d_v1.wgsl' = 'Deep Engine native Deep2d painter shader contract v1'
    'native_deep2d_atlas_v1.wgsl' = 'Deep Engine native Deep2d atlas shader contract v1'
    'native_output_v1.wgsl' = 'Deep Engine native HDR output shader contract v1'
    'native_bloom_v1.wgsl' = 'Deep Engine native HDR bloom shader contract v1'
    'native_output_bloom_v1.wgsl' = 'Deep Engine native HDR bloom output shader contract v1'
  }
  $binarySource = 'MZ'
  foreach ($entry in $required.GetEnumerator()) {
    $source = "// $($entry.Value)`nconst validated: u32 = 1u;`n"
    Write-Utf8File -Path (Join-Path $shaderRoot $entry.Key) -Content $source
    $binarySource += $source
  }
  Write-Utf8File -Path $executable -Content $binarySource
  $shaders = Test-EmbeddedShaders -PackageRoot $testRoot -Executable $executable
  if (-not $shaders.passed -or $shaders.files.Count -ne 9) {
    throw 'All nine embedded shader sources must be checked'
  }
  $cullingPath = Join-Path $shaderRoot 'native_gpu_culling_v1.wgsl'
  Write-Utf8File -Path $cullingPath -Content "// $($required['native_gpu_culling_v1.wgsl'])`nconst validated: u32 = 2u;`n"
  Assert-Rejected {
    Test-EmbeddedShaders -PackageRoot $testRoot -Executable $executable
  } 'Packaged shader source differs from the executable'

  $nestedManifest = Join-Path $shaderRoot 'manifest.json'
  Write-Utf8File -Path $nestedManifest -Content '{}'
  if ('assets/shaders/manifest.json' -notin @((Get-PayloadInventory -PackageRoot $testRoot).path)) {
    throw 'Nested manifest was excluded from the payload inventory'
  }
  $zipSource = Join-Path $testRoot 'duplicate-fixture'
  [void](New-Item -ItemType Directory -Path $zipSource)
  Write-Utf8File -Path (Join-Path $zipSource 'a.txt') -Content 'same bytes'
  Write-Utf8File -Path (Join-Path $zipSource 'b.txt') -Content 'same bytes'
  $zipPath = Join-Path $testRoot 'duplicate.zip'
  $stream = [IO.File]::Create($zipPath)
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($unused in 1..2) {
      $entry = $archive.CreateEntry('duplicate-fixture/a.txt')
      $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
      try { $writer.Write('same bytes') } finally { $writer.Dispose() }
    }
  } finally { $archive.Dispose(); $stream.Dispose() }
  Assert-Rejected {
    Test-ZipMatchesDirectory -SourceRoot $zipSource -ArchivePath $zipPath
  } 'Duplicate ZIP entry'
  'Portable verifier regressions passed: purity, stale manifest, nine shader sources, nested inventory, duplicate ZIP.'
} finally {
  Assert-ChildPath -Root $testParent -Path $testRoot
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}
