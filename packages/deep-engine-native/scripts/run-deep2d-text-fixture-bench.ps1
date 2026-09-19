param(
  [string]$OutputDir = ""
)

# R6-2 A1 verdict bench runner: generate the real-text Deep2D fixture, then run
# the CPU prepare benchmark (pure CPU, no GPU). Writes the fixture JSON into
# packages/deep-engine-native/fixtures/ and raw outputs into $OutputDir.
# Usage: powershell -File packages/deep-engine-native/scripts/run-deep2d-text-fixture-bench.ps1
# cargo writes progress to stderr; under "Stop" preference PowerShell 5 turns
# every redirected stderr line into a terminating record. "Continue" + explicit
# $LASTEXITCODE gates below is the robust pattern for PS 5.1.
$ErrorActionPreference = "Continue"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
if ($OutputDir -eq "") {
  $OutputDir = Join-Path $repoRoot "test-output\r6-2-deep2d-text-fixture-20260919-r1"
}
$manifestPath = Join-Path $repoRoot "packages\deep-engine-native\Cargo.toml"
$fixturePath = Join-Path $repoRoot "packages\deep-engine-native\fixtures\deep2d_runtime_chart_text_v1.json"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# cargo writes progress to stderr; PowerShell 5 would turn those lines into
# ErrorRecords under Stop preference. Flatten to plain strings instead.
function Invoke-Logged {
  param([string]$Step, [string]$LogFile, [string[]]$CargoArgs)
  Write-Host "== $Step =="
  $output = & cargo @CargoArgs 2>&1 | ForEach-Object { "$_" }
  $output | Set-Content -Encoding UTF8 (Join-Path $OutputDir $LogFile)
  if ($LASTEXITCODE -ne 0) {
    $output | ForEach-Object { Write-Host $_ }
    throw "step failed: $Step (exit $LASTEXITCODE)"
  }
  $output | ForEach-Object { Write-Host $_ }
}

Invoke-Logged "Step 1/3: generate real-text fixture (production present_chart path)" `
  "fixture-generation.json" `
  @("run", "--release", "--locked", "--manifest-path", $manifestPath, "--example", "gen_deep2d_text_fixture")
if (-not (Test-Path $fixturePath)) { throw "fixture was not written: $fixturePath" }

Invoke-Logged "Step 2/3: fixture smoke test (cargo test regular case)" `
  "smoke-output.txt" `
  @("test", "--release", "--locked", "--manifest-path", $manifestPath, "--test", "deep2d_text_prepare_bench", "--", "--test-threads=1")

Invoke-Logged "Step 3/3: CPU prepare benchmark (--ignored, single thread)" `
  "bench-output.txt" `
  @("test", "--release", "--locked", "--manifest-path", $manifestPath, "--test", "deep2d_text_prepare_bench", "--", "--ignored", "--nocapture", "--test-threads=1")

$hash = (Get-FileHash -Algorithm SHA256 $fixturePath).Hash.ToLowerInvariant()
"sha256:$hash" | Set-Content -Encoding ascii (Join-Path $OutputDir "fixture-sha256.txt")
Write-Host "== done: outputs in $OutputDir; fixture sha256=$hash =="
