param(
    [Parameter(Mandatory)][string]$SourceFile,
    [Parameter(Mandatory)][string]$DependencyDirectory,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$deps = (Resolve-Path -LiteralPath $DependencyDirectory).Path
$source = (Resolve-Path -LiteralPath $SourceFile).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Choose a new evidence directory.' }
New-Item -ItemType Directory -Path $output | Out-Null
$externs = @()
$libraries = @()
foreach ($name in @('rvt','serde_json','sha2')) {
    $matches = @(Get-ChildItem -LiteralPath $deps -Filter "lib$name*.rlib")
    if ($matches.Count -ne 1) { throw "Missing/ambiguous cached dependency: $name" }
    $libraries += $matches[0].FullName
    $externs += @('--extern', "$name=$($matches[0].FullName)")
}
$auditSource = Join-Path $PSScriptRoot 'fixtures/rvt-sketch-line-audit.rs'
$decoderSource = Join-Path $PSScriptRoot 'fixtures/rvt-sketch-line.rs'
$exe = Join-Path $output 'rvt-sketch-line-audit.exe'
$tests = Join-Path $output 'rvt-sketch-line-tests.exe'
rustc --edition=2024 -O $auditSource @externs -L "dependency=$deps" -o $exe
if ($LASTEXITCODE -ne 0) { throw 'Audit compilation failed' }
rustc --edition=2024 --test $decoderSource -o $tests
if ($LASTEXITCODE -ne 0) { throw 'Decoder test compilation failed' }
& $tests
if ($LASTEXITCODE -ne 0) { throw 'Decoder tests failed' }
$before = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$lineEvidence = Join-Path $output 'source-lines.json'
& $exe $source $lineEvidence
if ($LASTEXITCODE -ne 0) { throw 'Source line audit failed' }
$repeat = Join-Path $output 'source-lines-repeat.json'
& $exe $source $repeat
if ($LASTEXITCODE -ne 0) { throw 'Repeat source line audit failed' }
if ((Get-FileHash $lineEvidence).Hash -ne (Get-FileHash $repeat).Hash -or $before -ne (Get-FileHash $source).Hash) { throw 'Nondeterministic result or changed source' }
$profiles = Join-Path $output 'profiles.json'
$glb = Join-Path $output 'source-wires.glb'
node (Join-Path $PSScriptRoot 'audit-rvt-source-profiles.mjs') $lineEvidence $profiles $glb
if ($LASTEXITCODE -ne 0) { throw 'Source profile audit failed' }
$previousEvidence = $env:RVT_LINE_EVIDENCE
$previousWire = $env:RVT_WIRE_GLB
try {
    $env:RVT_LINE_EVIDENCE = $lineEvidence
    $env:RVT_WIRE_GLB = $glb
    node --test (Join-Path $PSScriptRoot 'rvt-source-profiles.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Real source/GLB checks failed' }
} finally {
    $env:RVT_LINE_EVIDENCE = $previousEvidence
    $env:RVT_WIRE_GLB = $previousWire
}
$paths = @($PSCommandPath,$auditSource,$decoderSource,$exe,$tests,$lineEvidence,$profiles,$glb,
    (Join-Path $PSScriptRoot 'audit-rvt-source-profiles.mjs'),
    (Join-Path $PSScriptRoot 'lib/rvtSourceProfiles.mjs'),
    (Join-Path $PSScriptRoot 'rvt-source-profiles.test.mjs')) + $libraries
$hashes = foreach ($path in $paths) { [ordered]@{ path=$path; sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() } }
[ordered]@{ schemaVersion=1; scope='persisted-source-lines-and-closed-wire-profiles'; buildingSolidGeometry='missing'; sourceSha256=$before.ToLowerInvariant(); rustc=(rustc --version); files=@($hashes) } |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'evidence.json') -Encoding utf8
