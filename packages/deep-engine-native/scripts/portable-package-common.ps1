Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'portable-smoke.ps1')

function Assert-ChildPath {
  param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Path)
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $candidate = [IO.Path]::GetFullPath($Path)
  $prefix = $rootPath + [IO.Path]::DirectorySeparatorChar
  if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path escapes the package output root: $candidate"
  }
}

function Write-Utf8File {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Get-RelativeUnixPath {
  param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Path)
  return [IO.Path]::GetRelativePath($Root, $Path).Replace('\', '/')
}

function Get-FileSha256 {
  param([Parameter(Mandatory)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PayloadInventory {
  param([Parameter(Mandatory)][string]$PackageRoot)
  $rootManifest = [IO.Path]::GetFullPath((Join-Path $PackageRoot 'manifest.json'))
  return @(
    Get-ChildItem -LiteralPath $PackageRoot -Recurse -File |
      Where-Object { $_.FullName -ne $rootManifest } |
      ForEach-Object {
        [ordered]@{
          path = Get-RelativeUnixPath -Root $PackageRoot -Path $_.FullName
          size = $_.Length
          sha256 = Get-FileSha256 -Path $_.FullName
        }
      } |
      Sort-Object path
  )
}

function Test-PortablePurity {
  param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [Parameter(Mandatory)][string]$Executable
  )
  $forbiddenExtensions = @('.js', '.mjs', '.cjs', '.jsx', '.wasm', '.html', '.htm')
  $forbiddenSegments = @('target', 'debug', 'node_modules', 'browser', 'webview')
  $forbiddenEntries = [Collections.Generic.List[string]]::new()
  foreach ($file in Get-ChildItem -LiteralPath $PackageRoot -Recurse -File) {
    $relative = Get-RelativeUnixPath -Root $PackageRoot -Path $file.FullName
    if ($forbiddenExtensions -contains $file.Extension.ToLowerInvariant()) {
      $forbiddenEntries.Add($relative)
    }
    $segments = $relative.Split('/', [StringSplitOptions]::RemoveEmptyEntries)
    if ($segments.Where({ $forbiddenSegments -contains $_.ToLowerInvariant() }).Count -gt 0) {
      $forbiddenEntries.Add($relative)
    }
  }

  $bytes = [IO.File]::ReadAllBytes($Executable)
  if ($bytes.Length -lt 2 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw "Packaged executable is not a Windows PE image: $Executable"
  }
  $ascii = [Text.Encoding]::ASCII.GetString($bytes)
  $unicode = [Text.Encoding]::Unicode.GetString($bytes)
  $forbiddenMarkers = @(
    'WebView2Loader.dll', 'Microsoft.Web.WebView2', 'msedgewebview2.exe',
    'libcef.dll', 'chrome_elf.dll', 'electron.exe', 'node.dll',
    'wasmtime.dll', 'wasmer.dll', 'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll', 'MSVCP140.dll'
  )
  $matchedMarkers = @(
    $forbiddenMarkers | Where-Object {
      $ascii.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $unicode.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
  )
  $entryFailures = @($forbiddenEntries | Sort-Object -Unique)
  return [ordered]@{
    passed = $entryFailures.Count -eq 0 -and $matchedMarkers.Count -eq 0
    windowsPeVerified = $true
    staticCrtVerified = -not ($matchedMarkers -match '^VCRUNTIME|^MSVCP')
    forbiddenExtensions = $forbiddenExtensions
    forbiddenPathSegments = $forbiddenSegments
    binaryMarkersScanned = $forbiddenMarkers
    forbiddenEntries = $entryFailures
    matchedBinaryMarkers = $matchedMarkers
  }
}

function Test-EmbeddedShaders {
  param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [Parameter(Mandatory)][string]$Executable
  )
  $required = [ordered]@{
    'assets/shaders/native_mesh_v1.wgsl' = 'Deep Engine native mesh shader contract v1'
    'assets/shaders/native_cascaded_shadow_v1.wgsl' = 'Deep Engine native cascaded shadow sampling contract v1'
    'assets/shaders/native_gpu_culling_v1.wgsl' = 'Deep Engine native GPU instance culling contract v1'
    'assets/shaders/native_gpu_lod_v1.wgsl' = 'Deep Engine native GPU LOD contract v1'
    'assets/shaders/native_deep2d_v1.wgsl' = 'Deep Engine native Deep2d painter shader contract v1'
    'assets/shaders/native_deep2d_atlas_v1.wgsl' = 'Deep Engine native Deep2d atlas shader contract v1'
    'assets/shaders/native_output_v1.wgsl' = 'Deep Engine native HDR output shader contract v1'
    'assets/shaders/native_bloom_v1.wgsl' = 'Deep Engine native HDR bloom shader contract v1'
    'assets/shaders/native_output_bloom_v1.wgsl' = 'Deep Engine native HDR bloom output shader contract v1'
  }
  $binaryText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($Executable))
  $files = @()
  foreach ($entry in $required.GetEnumerator()) {
    $path = Join-Path $PackageRoot $entry.Key
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Required packaged shader is missing: $($entry.Key)"
    }
    $markerFound = $binaryText.Contains($entry.Value)
    $source = [IO.File]::ReadAllText($path)
    $sourceFound = $source.Contains($entry.Value) -and $binaryText.Contains($source)
    $files += [ordered]@{
      path = $entry.Key
      sourceSha256 = Get-FileSha256 -Path $path
      contractMarker = $entry.Value
      markerFoundInExecutable = $markerFound
      fullSourceFoundInExecutable = $sourceFound
    }
    if (-not $markerFound) {
      throw "Packaged executable does not contain the embedded shader marker: $($entry.Key)"
    }
    if (-not $sourceFound) {
      throw "Packaged shader source differs from the executable: $($entry.Key)"
    }
  }
  return [ordered]@{ passed = $true; files = $files }
}

function Test-ManifestPayload {
  param([Parameter(Mandatory)][string]$PackageRoot)
  $manifestPath = Join-Path $PackageRoot 'manifest.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.schema -ne 'deep-engine.native-portable' -or $manifest.schemaVersion -ne 2 -or
      $manifest.channel -ne 'beta' -or $manifest.runtime.browserShell -ne $false) {
    throw 'Portable manifest does not describe a native Beta schema v2 package.'
  }
  $records = @($manifest.files)
  $paths = @($records | ForEach-Object path)
  if (@($paths | Sort-Object -Unique).Count -ne $paths.Count) {
    throw 'Portable manifest contains duplicate payload paths.'
  }
  foreach ($record in $records) {
    if ($record.path -match '(^|/)(target|debug|node_modules|browser|webview)(/|$)') {
      throw "Manifest contains a forbidden path: $($record.path)"
    }
    $path = Join-Path $PackageRoot ($record.path.Replace('/', [IO.Path]::DirectorySeparatorChar))
    Assert-ChildPath -Root $PackageRoot -Path $path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Manifest file is missing: $($record.path)"
    }
    $file = Get-Item -LiteralPath $path
    if ($file.Length -ne $record.size -or (Get-FileSha256 -Path $path) -ne $record.sha256) {
      throw "Manifest hash or size mismatch: $($record.path)"
    }
  }
  if (-not $manifest.purity.passed -or -not $manifest.smoke.passed) {
    throw 'Portable manifest reports a failed gate.'
  }
  if (-not $manifest.embeddedShaders.passed -or
      -not (@($manifest.smoke.checks | Where-Object name -eq 'gpu-first-frame').passed)) {
    throw 'Portable manifest lacks embedded shader or GPU first-frame evidence.'
  }
  $actualPaths = @((Get-PayloadInventory -PackageRoot $PackageRoot) | ForEach-Object path)
  if ($actualPaths.Count -ne $paths.Count -or @($actualPaths | Where-Object { $_ -notin $paths }).Count) {
    throw 'Portable payload contains unlisted or missing files.'
  }
  return $manifest
}

function New-DeterministicZip {
  param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$ArchivePath
  )
  Add-Type -AssemblyName System.IO.Compression
  $stream = [IO.File]::Open($ArchivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      $parent = Split-Path -Parent $SourceRoot
      foreach ($file in Get-ChildItem -LiteralPath $SourceRoot -Recurse -File | Sort-Object FullName) {
        $entryPath = Get-RelativeUnixPath -Root $parent -Path $file.FullName
        $entry = $archive.CreateEntry($entryPath, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $input = [IO.File]::OpenRead($file.FullName)
        $output = $entry.Open()
        try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
}

function Test-ZipMatchesDirectory {
  param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$ArchivePath
  )
  Add-Type -AssemblyName System.IO.Compression
  $expected = @{}
  $parent = Split-Path -Parent $SourceRoot
  foreach ($file in Get-ChildItem -LiteralPath $SourceRoot -Recurse -File) {
    $expected[(Get-RelativeUnixPath -Root $parent -Path $file.FullName)] = [ordered]@{
      size = $file.Length
      sha256 = Get-FileSha256 -Path $file.FullName
    }
  }
  $stream = [IO.File]::OpenRead($ArchivePath)
  try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false)
    try {
      $entries = @($archive.Entries | Where-Object { $_.Name })
      if ($entries.Count -ne $expected.Count) { throw 'ZIP file count differs from staged payload.' }
      $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      foreach ($entry in $entries) {
        if (-not $seen.Add($entry.FullName)) { throw "Duplicate ZIP entry: $($entry.FullName)" }
        $record = $expected[$entry.FullName]
        if ($null -eq $record -or $entry.Length -ne $record.size) {
          throw "Unexpected ZIP entry or size: $($entry.FullName)"
        }
        $entryStream = $entry.Open()
        try {
          $sha = [Security.Cryptography.SHA256]::Create()
          try { $hash = [Convert]::ToHexString($sha.ComputeHash($entryStream)).ToLowerInvariant() }
          finally { $sha.Dispose() }
        } finally { $entryStream.Dispose() }
        if ($hash -ne $record.sha256) { throw "ZIP hash mismatch: $($entry.FullName)" }
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
  return [ordered]@{ passed = $true; entries = $expected.Count }
}
