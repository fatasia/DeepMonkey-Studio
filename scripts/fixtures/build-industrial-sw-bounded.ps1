param([string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path)
$ErrorActionPreference = 'Stop'
$target = 'C:/Users/rain/AppData/Local/Temp/bim-cadmpeg-20260918-target'
$cargoTarget = Join-Path $target 'archive-isolated'
$source = Join-Path $RepositoryRoot 'data/external-assets/industrial-format-plan/dependencies/extracted/cadmpeg-v0.6.0'
[void](New-Item -ItemType Directory -Force -Path $target)
$arguments = @('build', '-p', 'cadmpeg', '--no-default-features', '--features', 'sldprt', '--release', '--offline', '--locked', '-j', '2', '--target-dir', $cargoTarget)
$info = [Diagnostics.ProcessStartInfo]::new((Get-Command cargo).Source)
$info.WorkingDirectory = $source
$info.Environment['GIT_CEILING_DIRECTORIES'] = $source
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
foreach ($argument in $arguments) { $info.ArgumentList.Add($argument) }
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
$watch = [Diagnostics.Stopwatch]::StartNew()
[void]$process.Start()
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
$samples = @()
$stopReason = $null
$nextSample = 0
while (-not $process.HasExited) {
  if ($watch.Elapsed.TotalSeconds -ge $nextSample) {
    $size = [long](Get-ChildItem -LiteralPath $target -Recurse -File | Measure-Object Length -Sum).Sum
    $free = [IO.DriveInfo]::new('C').AvailableFreeSpace
    $samples += @{ elapsedSeconds = $watch.Elapsed.TotalSeconds; targetBytes = $size; driveFreeBytes = $free }
    Write-Output "build monitor: target=$size C-free=$free elapsed=$([int]$watch.Elapsed.TotalSeconds)s"
    if ($size -ge 1900MB -or $free -lt 8GB) { $stopReason = 'disk-budget'; $process.Kill($true); break }
    $nextSample = $watch.Elapsed.TotalSeconds + 10
  }
  Start-Sleep -Milliseconds 250
}
$process.WaitForExit()
$watch.Stop()
[IO.File]::WriteAllText((Join-Path $target 'build.stdout.txt'), $stdout.GetAwaiter().GetResult())
[IO.File]::WriteAllText((Join-Path $target 'build.stderr.txt'), $stderr.GetAwaiter().GetResult())
$result = @{ schemaVersion = 1; budgetRoot = $target; target = $cargoTarget; command = @('cargo') + $arguments; elapsedSeconds = $watch.Elapsed.TotalSeconds;
  gitCeilingDirectories = $source; exitCode = $process.ExitCode; stopReason = $stopReason; monitoring = $samples }
$json = $result | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $target 'build-evidence.json'), $json)
[IO.File]::WriteAllText((Join-Path $target ('build-evidence-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '.json')), $json)
$json
if ($process.ExitCode -ne 0) { throw "cadmpeg build failed; see $target/build.stderr.txt" }
