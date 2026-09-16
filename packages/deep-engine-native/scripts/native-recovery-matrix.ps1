# Deep Engine native Windows recovery smoke matrix.
# Composes the existing surface smokes that cover dynamic packets, caching,
# Deep2D, shadows and telemetry; asserts signature lines and exit codes.
# Interactive-only recoveries (manual window resize, R-key rebuild) are not
# part of this matrix; device loss is exercised through the smoke GPU paths.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot/..
# Native cargo stderr carries warnings; never promote them to terminating errors.
$ErrorActionPreference = "Continue"

$matrix = @(
    @{ Name = "fresh-frame";        Args = @("--smoke-frame");           Expect = "native smoke frame presented" },
    @{ Name = "textured-pbr";       Args = @("--smoke-textured");        Expect = "native smoke frame presented" },
    @{ Name = "deep2d-interleaved"; Args = @("--smoke-deep2d-interleaved"); Expect = "Deep2d interleaved readback OK" },
    @{ Name = "dynamic-packet";     Args = @("--smoke-shadow-update");   Expect = "native shadow update GPU OK" },
    @{ Name = "live-packet-cache";  Args = @("--smoke-packet-live");     Expect = "live reload smoke published" },
    @{ Name = "package-recovery";   Args = @("--smoke-package-live", "tests/fixtures/runtime-package-v1.json"); Expect = "live reload rejected candidate retained last frame" },
    @{ Name = "telemetry-report";   Args = @("--smoke-telemetry");       Expect = "native telemetry report" }
)

$results = @()
$failed = $false
foreach ($entry in $matrix) {
    $output = & cargo run --quiet -- @($entry.Args) 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $signature = ($output | Select-String -SimpleMatch $entry.Expect | Measure-Object).Count
    $dirty = @($output | Where-Object { $_ -match "scopes=dirty|uncaptured GPU error|GPU device lost" })
    $clean = $dirty.Count -eq 0
    $pass = ($code -eq 0) -and ($signature -ge 1) -and $clean
    $results += [pscustomobject]@{
        Surface = $entry.Name
        Exit    = $code
        Signature = $signature
        Clean   = $clean
        Result  = $(if ($pass) { "PASS" } else { "FAIL" })
    }
    if (-not $pass) { $failed = $true }
}

$results | Format-Table -AutoSize
if ($failed) {
    Write-Error "native recovery matrix failed"
    exit 1
}
Write-Host "native recovery matrix: all surfaces passed"
exit 0
