function Invoke-PortableSmoke {
  param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$PackageRoot,
    [switch]$IncludeRuntimeDetails
  )
  $checks = @(
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
  $results = @()
  foreach ($check in $checks) {
    $lines = @(& $Executable @($check.arguments) 2>&1)
    $exitCode = $LASTEXITCODE
    $output = ($lines | ForEach-Object ToString) -join "`n"
    $markers = @($check.expected)
    $missing = @($markers | Where-Object { -not $output.Contains($_) })
    $passed = $exitCode -eq 0 -and $missing.Count -eq 0
    $evidence = @(foreach ($marker in $markers) {
      $lines | ForEach-Object ToString | Where-Object { $_.Contains($marker) } | Select-Object -First 1
    })
    $result = [ordered]@{
      name = $check.name
      passed = $passed
      exitCode = $exitCode
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
