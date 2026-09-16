function Invoke-PortableRecoverySmoke {
  param([string]$Executable, [string]$PackageRoot, [string]$Sandbox)
  function Check-Candidate {
    param([string]$Name, [string[]]$Arguments, [string[]]$Markers, [int]$ExitCode = 0)
    $result = Invoke-PortableProcess -Executable $Executable -Arguments $Arguments
    if ($result.exitCode -ne $ExitCode -or @($Markers | Where-Object { -not $result.output.Contains($_) }).Count) {
      throw "Candidate smoke failed: $Name $($result.output)"
    }
    [ordered]@{ name = $Name; passed = $true; exitCode = $result.exitCode; elapsedMilliseconds = $result.elapsedMilliseconds; evidence = $Markers -join ' | '; runtimeOutput = $result.output.Trim() }
  }
  $author = Join-Path $PackageRoot 'fixtures/runtime-package-author-lod-v1.json'
  Check-Candidate 'author-lod-preflight' @('--headless-package', $author) @('Deep Runtime Package Player preflight OK:')
  Check-Candidate 'author-lod-gpu' @('--smoke-package', $author) @('native GPU LOD v1:', 'scopes=clean callbacks=clean')
  $source = Join-Path $Sandbox 'asset-source'
  Copy-Item -LiteralPath (Join-Path $PackageRoot 'fixtures/asset-directory-v1') -Destination $source -Recurse
  $manifest = Join-Path $source 'manifest.json'
  $original = [IO.File]::ReadAllBytes($manifest)
  $asset = [Text.Encoding]::UTF8.GetString($original) | ConvertFrom-Json
  Check-Candidate 'asset-directory-preflight' @('--headless-asset-package', $manifest) @('Deep Asset Package directory OK:')
  Check-Candidate 'asset-directory-first-gpu' @('--smoke-asset-package', $manifest) @('asset recovery checkpoint committed after present', 'scopes=clean callbacks=clean')
  [IO.File]::WriteAllText($manifest, 'broken manifest')
  Check-Candidate 'asset-directory-corrupt-manifest-restart' @('--smoke-asset-package', $manifest) @('active=last-known-good', 'scopes=clean callbacks=clean')
  [IO.File]::WriteAllBytes($manifest, $original)
  $chunk = Join-Path (Join-Path $source 'blobs') $asset.blobs[0].hash
  Assert-ChildPath -Root $source -Path $chunk
  [IO.File]::WriteAllText($chunk, 'broken chunk')
  Check-Candidate 'asset-directory-corrupt-chunk-restart' @('--smoke-asset-package', $manifest) @('active=last-known-good', 'chunk-integrity', 'scopes=clean callbacks=clean')
  $other = Join-Path $Sandbox 'other-source'
  [void](New-Item -ItemType Directory -Path $other)
  [IO.File]::WriteAllText((Join-Path $other 'manifest.json'), 'broken')
  Check-Candidate 'asset-directory-foreign-source-rejected' @('--headless-asset-package', (Join-Path $other 'manifest.json')) @('asset') 1
}
