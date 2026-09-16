Set-StrictMode -Version Latest

function Get-ProvenanceRelativeUnixPath {
  param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Path)
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $candidate = [IO.Path]::GetFullPath($Path)
  if ($candidate.Equals($rootPath, [StringComparison]::OrdinalIgnoreCase)) {
    return '.'
  }
  $prefix = $rootPath + [IO.Path]::DirectorySeparatorChar
  if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path escapes the provenance root: $candidate"
  }
  return $candidate.Substring($prefix.Length).Replace('\', '/')
}

function Get-ProvenanceSha256 {
  param([Parameter(Mandatory)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-CargoLockRecords {
  param([Parameter(Mandatory)][string]$Path)
  $records = @{}
  $text = [IO.File]::ReadAllText($Path)
  $blocks = [regex]::Matches($text, '(?ms)^\[\[package\]\]\s*(?<body>.*?)(?=^\[\[package\]\]|\z)')
  foreach ($block in $blocks) {
    $body = $block.Groups['body'].Value
    $name = [regex]::Match($body, '(?m)^name = "(?<v>[^"]+)"\s*$').Groups['v'].Value
    $version = [regex]::Match($body, '(?m)^version = "(?<v>[^"]+)"\s*$').Groups['v'].Value
    $source = [regex]::Match($body, '(?m)^source = "(?<v>[^"]+)"\s*$').Groups['v'].Value
    $checksum = [regex]::Match($body, '(?m)^checksum = "(?<v>[0-9a-f]+)"\s*$').Groups['v'].Value
    if ($name -and $version) { $records["$name|$version|$source"] = $checksum }
  }
  return $records
}

function Get-NativeBuildInputs {
  param([Parameter(Mandatory)][string]$PackageRoot)
  $repositoryRoot = (Resolve-Path (Join-Path $PackageRoot '../..')).Path
  $files = @(
    Get-ChildItem -LiteralPath (Join-Path $PackageRoot 'src') -Recurse -File -Filter '*.rs'
    Get-ChildItem -LiteralPath (Join-Path $PackageRoot 'assets/shaders') -File -Filter '*.wgsl'
    Get-ChildItem -LiteralPath (Join-Path $PackageRoot 'fixtures') -File -Filter '*.json'
    Get-ChildItem -LiteralPath (Join-Path $PackageRoot 'scripts') -File -Filter '*.ps1'
    Get-Item -LiteralPath (Join-Path $PackageRoot 'Cargo.toml')
    Get-Item -LiteralPath (Join-Path $PackageRoot 'Cargo.lock')
    Get-Item -LiteralPath (Join-Path $PackageRoot 'rust-toolchain.toml')
  )
  foreach ($name in @(
    'runtime-package-v1.json', 'runtime-package-lod-v1.json',
    'runtime-package-shader-v2.json', 'runtime-package-author-lod-v1.json',
    'runtime-package-prefiltered-ibl-v1.json'
  )) {
    $files += Get-Item -LiteralPath (Join-Path $PackageRoot "tests/fixtures/$name")
  }
  $files += Get-ChildItem -LiteralPath (Join-Path $PackageRoot 'tests/fixtures/asset-directory-v1') -Recurse -File
  foreach ($name in @('LICENSE', 'LICENSE.zh-CN.md', 'LICENSING.md', 'THIRD_PARTY_NOTICES.md')) {
    $path = Join-Path $repositoryRoot $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing license input: $name" }
    $files += Get-Item -LiteralPath $path
  }
  return @($files | ForEach-Object {
    $insidePackage = $_.FullName.StartsWith($PackageRoot, [StringComparison]::OrdinalIgnoreCase)
    $relative = if ($insidePackage) {
      Get-ProvenanceRelativeUnixPath -Root $PackageRoot -Path $_.FullName
    } else { 'repository/' + $_.Name }
    [ordered]@{ path = $relative; size = $_.Length; sha256 = Get-ProvenanceSha256 $_.FullName }
  } | Sort-Object path)
}

function Get-NativeBuildInputFingerprint {
  param([Parameter(Mandatory)][string]$PackageRoot)
  $records = @(Get-NativeBuildInputs -PackageRoot $PackageRoot)
  return Get-BuildInputRecordsFingerprint -Records $records
}

function ConvertTo-LowerHex {
  param([Parameter(Mandatory)][byte[]]$Bytes)
  return -join ($Bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-BuildInputRecordsFingerprint {
  param([Parameter(Mandatory)][object[]]$Records)
  $canonical = ($Records | ForEach-Object { "$($_.path)`0$($_.size)`0$($_.sha256)" }) -join "`n"
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ConvertTo-LowerHex -Bytes $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))
  } finally { $sha.Dispose() }
}

function Get-WindowsCargoComponents {
  param([Parameter(Mandatory)][string]$PackageRoot, [Parameter(Mandatory)][string]$Target)
  $manifest = Join-Path $PackageRoot 'Cargo.toml'
  $metadataJson = & cargo metadata --locked --filter-platform $Target --format-version 1 --manifest-path $manifest
  if ($LASTEXITCODE -ne 0) { throw 'cargo metadata for SBOM input failed.' }
  $metadata = $metadataJson | ConvertFrom-Json
  $root = @($metadata.packages | Where-Object name -eq 'deep-engine-native')
  if ($root.Count -ne 1) { throw 'Cannot resolve root package for SBOM input.' }
  $packages = @{}; $nodes = @{}
  foreach ($package in $metadata.packages) { $packages[$package.id] = $package }
  foreach ($node in $metadata.resolve.nodes) { $nodes[$node.id] = $node }
  $pending = [Collections.Generic.Queue[string]]::new()
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $pending.Enqueue($root[0].id)
  while ($pending.Count) {
    $id = $pending.Dequeue()
    if (-not $seen.Add($id)) { continue }
    foreach ($dependency in $nodes[$id].deps) {
      $included = @($dependency.dep_kinds | Where-Object { $_.kind -ne 'dev' }).Count -gt 0
      if ($included) { $pending.Enqueue($dependency.pkg) }
    }
  }
  $lock = Get-CargoLockRecords -Path (Join-Path $PackageRoot 'Cargo.lock')
  $purls = @{}
  foreach ($id in $seen) {
    $package = $packages[$id]
    $purls[$id] = "pkg:cargo/$($package.name)@$($package.version)"
  }
  $components = @($seen | Where-Object { $_ -ne $root[0].id } | ForEach-Object {
    $package = $packages[$_]
    if (-not $package.license) { throw "Dependency has no license expression: $($package.name)@$($package.version)" }
    $key = "$($package.name)|$($package.version)|$($package.source)"
    $checksum = $lock[$key]
    if ($package.source -like 'registry+*' -and $checksum -notmatch '^[0-9a-f]{64}$') {
      throw "Registry dependency has no locked SHA-256: $($package.name)@$($package.version)"
    }
    if ($package.source -like 'git+*' -and $package.source -notmatch '#[0-9a-f]{40}$') {
      throw "Git dependency is not pinned to a commit: $($package.name)@$($package.version)"
    }
    [ordered]@{
      name = $package.name
      version = $package.version
      purl = "pkg:cargo/$($package.name)@$($package.version)"
      source = $package.source
      checksumSha256 = $checksum
      license = $package.license
      enabledFeatures = @($nodes[$package.id].features | Sort-Object)
    }
  } | Sort-Object name, version, source)
  $dependencies = @($seen | ForEach-Object {
    $id = $_
    $dependsOn = @($nodes[$id].deps | Where-Object {
      @($_.dep_kinds | Where-Object { $_.kind -ne 'dev' }).Count -gt 0 -and $seen.Contains($_.pkg)
    } | ForEach-Object { $purls[$_.pkg] } | Sort-Object -Unique)
    [ordered]@{ ref = $purls[$id]; dependsOn = $dependsOn }
  } | Sort-Object ref)
  return [ordered]@{ root = $root[0]; components = $components; dependencies = $dependencies }
}

function Test-NativeSupplyChainEvidence {
  param([Parameter(Mandatory)]$Evidence)
  if ($Evidence.schema -ne 'deep-engine.native-sbom-input' -or $Evidence.schemaVersion -ne 1) {
    throw 'Invalid native SBOM input schema.'
  }
  if (-not $Evidence.target -or @($Evidence.components).Count -eq 0) {
    throw 'Native SBOM input has no target or dependency components.'
  }
  $purls = @($Evidence.components | ForEach-Object purl)
  if (@($purls | Sort-Object -Unique).Count -ne $purls.Count) { throw 'Native SBOM input has duplicate components.' }
  foreach ($component in $Evidence.components) {
    if (-not $component.name -or -not $component.version -or -not $component.license) {
      throw 'Native SBOM component lacks name, version, or license.'
    }
    if ($component.source -like 'registry+*' -and $component.checksumSha256 -notmatch '^[0-9a-f]{64}$') {
      throw "Native SBOM registry checksum is missing: $($component.purl)"
    }
  }
  $knownRefs = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  [void]$knownRefs.Add("pkg:cargo/$($Evidence.package.name)@$($Evidence.package.version)")
  foreach ($purl in $purls) { [void]$knownRefs.Add($purl) }
  $relations = @($Evidence.dependencies)
  if ($relations.Count -ne $knownRefs.Count -or
      @($relations.ref | Sort-Object -Unique).Count -ne $relations.Count) {
    throw 'Native SBOM dependency graph is incomplete or duplicated.'
  }
  foreach ($relation in $relations) {
    if (-not $knownRefs.Contains($relation.ref) -or
        @($relation.dependsOn | Where-Object { -not $knownRefs.Contains($_) -or $_ -eq $relation.ref }).Count) {
      throw 'Native SBOM dependency graph contains an unknown or self reference.'
    }
  }
  $inputs = @($Evidence.buildInputs)
  $expectedFingerprint = Get-BuildInputRecordsFingerprint -Records $inputs
  if ($Evidence.buildInputFingerprint -cne $expectedFingerprint) {
    throw 'Native build input fingerprint is missing.'
  }
  foreach ($required in @('Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml')) {
    if ($required -notin @($inputs | ForEach-Object path)) { throw "Native build input is missing: $required" }
  }
  return [ordered]@{ passed = $true; components = $purls.Count; buildInputs = $inputs.Count }
}

function Write-NativeSupplyChainEvidence {
  param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [Parameter(Mandatory)][string]$Target,
    [Parameter(Mandatory)][string]$Destination,
    [string]$LogicalPath = 'licenses/rust-sbom-input.json',
    [string]$Profile = 'release',
    [string]$RustFlags = '-C target-feature=+crt-static'
  )
  $cargo = Get-WindowsCargoComponents -PackageRoot $PackageRoot -Target $Target
  $rustc = @(& rustc -Vv)
  if ($LASTEXITCODE -ne 0) { throw 'rustc toolchain query failed.' }
  $cargoVersion = & cargo --version
  if ($LASTEXITCODE -ne 0) { throw 'cargo toolchain query failed.' }
  $buildInputs = @(Get-NativeBuildInputs -PackageRoot $PackageRoot)
  $evidence = [ordered]@{
    schema = 'deep-engine.native-sbom-input'
    schemaVersion = 1
    target = $Target
    package = [ordered]@{
      name = $cargo.root.name
      version = $cargo.root.version
      license = 'LicenseRef-Deep-Monkey-Community-1.0'
      licenseFile = 'licenses/LICENSE'
    }
    toolchain = [ordered]@{ rustcVerbose = $rustc; cargo = $cargoVersion }
    build = [ordered]@{ profile = $Profile; locked = $true; rustFlags = $RustFlags }
    buildInputs = $buildInputs
    buildInputFingerprint = Get-BuildInputRecordsFingerprint -Records $buildInputs
    components = @($cargo.components)
    dependencies = @($cargo.dependencies)
  }
  [void](Test-NativeSupplyChainEvidence -Evidence $evidence)
  $json = ($evidence | ConvertTo-Json -Depth 8) + "`n"
  [IO.File]::WriteAllText($Destination, $json, [Text.UTF8Encoding]::new($false))
  return [ordered]@{
    passed = $true
    path = $LogicalPath
    sha256 = Get-ProvenanceSha256 -Path $Destination
    components = @($evidence.components).Count
    buildInputs = @($evidence.buildInputs).Count
    buildInputFingerprint = $evidence.buildInputFingerprint
    dependencyRelations = @($evidence.dependencies).Count
  }
}
