. (Join-Path $PSScriptRoot 'portable-process.ps1')
. (Join-Path $PSScriptRoot 'portable-recovery-smoke.ps1')

# The packaging entry point loads portable-package-common.ps1 first, but this
# script is also a supported standalone smoke entry. Keep the path guard
# available in both invocation modes without introducing a circular import.
if (-not (Get-Command Assert-ChildPath -ErrorAction SilentlyContinue)) {
  function Assert-ChildPath {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Path)
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $candidate = [IO.Path]::GetFullPath($Path)
    $prefix = $rootPath + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Path escapes the package output root: $candidate"
    }
  }
}

function Invoke-PortableSmoke {
  param([Parameter(Mandatory)][string]$Executable, [Parameter(Mandatory)][string]$PackageRoot, [switch]$IncludeRuntimeDetails)
  $sandbox = Join-Path ([IO.Path]::GetTempPath()) ('deep-portable-' + [Guid]::NewGuid().ToString('N'))
  [void](New-Item -ItemType Directory -Path $sandbox)
  $oldLocal = [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('LOCALAPPDATA', (Join-Path $sandbox 'local'), 'Process')
    Invoke-PortableSmokeCore -Executable $Executable -PackageRoot $PackageRoot -IncludeRuntimeDetails:$IncludeRuntimeDetails
    if (Test-Path -LiteralPath (Join-Path $PackageRoot 'fixtures/asset-directory-v1/manifest.json')) {
      Invoke-PortableRecoverySmoke -Executable $Executable -PackageRoot $PackageRoot -Sandbox $sandbox
    }
  } finally {
    [Environment]::SetEnvironmentVariable('LOCALAPPDATA', $oldLocal, 'Process')
    Assert-ChildPath -Root ([IO.Path]::GetTempPath()) -Path $sandbox
    Remove-Item -LiteralPath $sandbox -Recurse -Force
  }
}

function Invoke-PortableSmokeCore {
  param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$PackageRoot,
    [switch]$IncludeRuntimeDetails
  )
  $checks = @(
    [ordered]@{
      name = 'viewer-section-pixels'
      arguments = @('--smoke-section', (Join-Path $PackageRoot 'fixtures/render_packet_v1.json'))
      expected = @('native section GPU probe OK:', 'restored=true color=0 shadow=0')
    },
    [ordered]@{
      name = 'viewer-section-alpha-pixels'
      arguments = @('--smoke-section', (Join-Path $PackageRoot 'fixtures/render_packet_alpha_v1.json'))
      expected = @('native section GPU probe OK:', 'restored=true color=0 shadow=0')
    },
    [ordered]@{
      name = 'viewer-selection-measurement'
      arguments = @('--smoke-selection', (Join-Path $PackageRoot 'fixtures/render_packet_v1.json'))
      expected = @('native selection GPU probe OK:', 'measurement=two-world-points annotations=persisted',
        'native smoke GPU submission complete: scopes=clean callbacks=clean')
    },
    [ordered]@{
      name = 'headless-contract'
      arguments = @('--headless-contract', (Join-Path $PackageRoot 'fixtures/render_packet_v1.json'))
      expected = 'RenderPacket contract OK:'
    },
    [ordered]@{
      name = 'headless-pbr'
      arguments = @('--headless-pbr', (Join-Path $PackageRoot 'fixtures/render_packet_textured_v1.json'))
      expected = 'Native PBR contract OK:'
    },
    [ordered]@{
      name = 'runtime-package-contract'
      arguments = @('--headless-package', (Join-Path $PackageRoot 'fixtures/runtime-package-v1.json'))
      expected = 'Deep Runtime Package Player preflight OK:'
    },
    [ordered]@{
      name = 'runtime-package-startup-recovery'
      arguments = @('--headless-package-recover',
        (Join-Path $PackageRoot 'fixtures/render_packet_v1.json'),
        (Join-Path $PackageRoot 'fixtures/runtime-package-v1.json'))
      expected = @('"active":"last-known-good"', 'Deep Runtime Package Player preflight OK:')
    },
    [ordered]@{
      name = 'runtime-package-invalid-fallback'
      arguments = @('--headless-package-recover',
        (Join-Path $PackageRoot 'fixtures/render_packet_v1.json'),
        (Join-Path $PackageRoot 'fixtures/render_packet_v1.json'))
      expected = '"code":"no-valid-runtime-package"'
      expectedExitCode = 1
    },
    [ordered]@{
      name = 'runtime-package-live-recovery'
      arguments = @('--smoke-package-live', (Join-Path $PackageRoot 'fixtures/runtime-package-v1.json'))
      expected = @('live reload smoke published', 'live reload rejected candidate retained last frame',
        'native smoke GPU submission complete: scopes=clean callbacks=clean')
    },
    [ordered]@{
      name = 'runtime-package-gpu-first-frame'
      arguments = @('--smoke-package', (Join-Path $PackageRoot 'fixtures/runtime-package-v1.json'))
      expected = @('Deep Runtime Package Player preflight OK:',
        'native smoke GPU submission complete: scopes=clean callbacks=clean', 'native Deep2d smoke frame presented: 64x64')
    },
    [ordered]@{
      name = 'deep2d-interleaved-readback'
      arguments = @('--smoke-deep2d-interleaved')
      expected = 'Deep2d interleaved readback OK:'
    },
    [ordered]@{
      name = 'runtime-package-lod-gpu-first-frame'
      arguments = @('--smoke-package', (Join-Path $PackageRoot 'fixtures/runtime-package-lod-v1.json'))
      expected = @('Deep Runtime Package Player preflight OK:', 'native GPU LOD v1:',
        'native smoke GPU submission complete: scopes=clean callbacks=clean', 'native smoke frame presented: 64x64')
    },
    [ordered]@{
      name = 'runtime-package-shader-gpu-first-frame'
      arguments = @('--smoke-package', (Join-Path $PackageRoot 'fixtures/runtime-package-shader-v2.json'))
      expected = @('Deep Runtime Package Player preflight OK:', 'native Player ShaderPackage materials ready: packages=3 materials=3',
        'native GPU LOD v1:', 'native smoke GPU submission complete: scopes=clean callbacks=clean', 'native smoke frame presented: 64x64')
    },
    [ordered]@{
      name = 'cascaded-shadow-readback'
      arguments = @('--smoke-shadow', (Join-Path $PackageRoot 'fixtures/render_packet_shadow_v1.json'))
      expected = 'native shadow probe:'
    },
    [ordered]@{
      name = 'ibl-readback'
      arguments = @('--smoke-ibl', (Join-Path $PackageRoot 'fixtures/render_packet_textured_v1.json'))
      expected = 'native IBL probe:'
    },
    [ordered]@{
      name = 'shader-package-readback'
      arguments = @('--smoke-shader-package')
      expected = 'Native shader package GPU executor OK:'
    },
    [ordered]@{
      name = 'gpu-first-frame'
      arguments = @('--smoke-frame', (Join-Path $PackageRoot 'fixtures/render_packet_v1.json'))
      expected = @('native smoke GPU submission complete: scopes=clean callbacks=clean', 'native smoke frame presented: 64x64')
    }
  )
  $prefiltered = Join-Path $PackageRoot 'fixtures/runtime-package-prefiltered-ibl-v1.json'
  if (Test-Path -LiteralPath $prefiltered -PathType Leaf) {
    $checks += @(
      [ordered]@{
        name = 'runtime-prefiltered-ibl-contract'
        arguments = @('--headless-package', $prefiltered)
        expected = 'Deep Runtime Package Player preflight OK:'
      },
      [ordered]@{
        name = 'runtime-prefiltered-ibl-gpu-first-frame'
        arguments = @('--smoke-package', $prefiltered)
        expected = @('native IBL prepared: id=environment.prefiltered.golden',
          'native smoke GPU submission complete: scopes=clean callbacks=clean',
          'native smoke frame presented: 64x64')
      }
    )
  }
  $results = @()
  foreach ($check in $checks) {
    $process = Invoke-PortableProcess -Executable $Executable -Arguments $check.arguments
    $exitCode = $process.exitCode
    $output = $process.output
    $lines = $output -split "`r?`n"
    $markers = @($check.expected)
    $missing = @($markers | Where-Object { -not $output.Contains($_) })
    $expectedExitCode = if ($check.Contains('expectedExitCode')) { $check.expectedExitCode } else { 0 }
    $passed = $exitCode -eq $expectedExitCode -and $missing.Count -eq 0
    $evidence = @(foreach ($marker in $markers) {
      $lines | ForEach-Object ToString | Where-Object { $_.Contains($marker) } | Select-Object -First 1
    })
    $result = [ordered]@{
      name = $check.name
      passed = $passed
      exitCode = $exitCode
      elapsedMilliseconds = $process.elapsedMilliseconds
      evidence = ($evidence | ForEach-Object { $_.Trim() }) -join ' | '
    }
    if ($IncludeRuntimeDetails) { $result.runtimeOutput = $output.Trim() }
    $results += $result
    if (-not $passed) {
      throw "Portable smoke failed: $($check.name) (exit=$exitCode) $output"
    }
  }
  return $results
}
