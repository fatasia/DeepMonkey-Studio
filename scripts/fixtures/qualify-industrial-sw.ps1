param([string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path,
  [string]$ExecutablePath = 'C:/Users/rain/AppData/Local/Temp/bim-cadmpeg-20260918-target/archive-isolated/release/cadmpeg.exe')
$ErrorActionPreference = 'Stop'
$base = Join-Path $RepositoryRoot 'data/external-assets/industrial-format-plan'
$source = Join-Path $base 'dependencies/extracted/cadmpeg-v0.6.0'
$exe = $ExecutablePath
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Build the pinned offline CLI before qualification: $exe" }
$samples = Join-Path $base 'samples/solidworks-sheetmetal-20260918'
$output = Join-Path $RepositoryRoot 'test-output/industrial-solidworks/qualification-20260918'
[void](New-Item -ItemType Directory -Force -Path $output)
$manifest = Get-Content -LiteralPath (Join-Path $samples 'manifest.json') -Raw | ConvertFrom-Json
$cases = @($manifest.records | ForEach-Object { @{ id = $_.id; path = Join-Path $samples $_.relativePath; sourceSha256 = $_.sha256; kind = 'real-source' } })
$bytes = [IO.File]::ReadAllBytes($cases[0].path)
$badCfb = [byte[]]::new(512)
([byte[]](0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1)).CopyTo($badCfb, 0)
$negative = @{
  'truncated-header' = $bytes[0..6]
  'truncated-half' = $bytes[0..([int]($bytes.Length / 2))]
  'bad-cfb-header' = $badCfb
  'wrong-signature' = [Text.Encoding]::UTF8.GetBytes('not a SolidWorks document')
}
foreach ($item in $negative.GetEnumerator()) {
  $file = Join-Path $output ($item.Key + '.sldprt')
  [IO.File]::WriteAllBytes($file, $item.Value)
  $cases += @{ id = $item.Key; path = $file; kind = 'negative' }
  $cases += @{ id = ($item.Key + '-forced'); path = $file; kind = 'negative'; forcedFormat = 'sldprt' }
}
$results = @()
foreach ($case in $cases) {
  $inputHash = (Get-FileHash -LiteralPath $case.path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($case.kind -eq 'real-source' -and $inputHash -ne $case.sourceSha256) { throw "Sample hash mismatch: $($case.id)" }
  $info = [Diagnostics.ProcessStartInfo]::new($exe)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  foreach ($argument in @('inspect', $case.path, '--json', '--limits', 'service')) { $info.ArgumentList.Add($argument) }
  if ($case.forcedFormat) { $info.ArgumentList.Add('--input-format'); $info.ArgumentList.Add($case.forcedFormat) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  $watch = [Diagnostics.Stopwatch]::StartNew()
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $peak = 0L
  $timedOut = $false
  while (-not $process.HasExited) {
    $process.Refresh()
    try { $peak = [Math]::Max($peak, $process.PeakWorkingSet64) } catch {}
    if ($watch.Elapsed.TotalSeconds -gt 60) { $process.Kill($true); $timedOut = $true; break }
    Start-Sleep -Milliseconds 1
  }
  $process.WaitForExit()
  $watch.Stop()
  $text = $stdout.GetAwaiter().GetResult()
  $errorText = $stderr.GetAwaiter().GetResult()
  [IO.File]::WriteAllText((Join-Path $output ($case.id + '.stdout.json')), $text)
  [IO.File]::WriteAllText((Join-Path $output ($case.id + '.stderr.txt')), $errorText)
  $results += @{ id = $case.id; kind = $case.kind; forcedFormat = $case.forcedFormat; inputSha256 = $inputHash;
    inputBytes = (Get-Item -LiteralPath $case.path).Length; exitCode = $process.ExitCode; elapsedMs = $watch.Elapsed.TotalMilliseconds;
    peakWorkingSetBytesSampled = $peak; timedOut = $timedOut; processModel = 'fresh process; OS file cache not flushed';
    stdoutFile = ($case.id + '.stdout.json'); stderrFile = ($case.id + '.stderr.txt') }
  $process.Dispose()
}
$evidence = @{ schemaVersion = 1; tool = 'cadmpeg'; version = '0.6.0'; features = @('sldprt');
  buildCommand = 'cargo build -p cadmpeg --no-default-features --features sldprt --release --offline --locked -j 2';
  executableSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();
  executablePath = $exe;
  cargoLockSha256 = (Get-FileHash -LiteralPath (Join-Path $source 'Cargo.lock') -Algorithm SHA256).Hash.ToLowerInvariant();
  capability = 'inspect only; no geometry certification'; inspectArguments = @('inspect', 'FILE', '--json', '--limits', 'service');
  rssMethod = 'Windows PeakWorkingSet64 sampled every 1 ms; zero means process finished before observation'; results = $results }
$json = $evidence | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText((Join-Path $output 'qualification.json'), $json)
$json
