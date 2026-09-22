param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$ArgumentJson,
    [Parameter(Mandatory = $true)][string]$EnvironmentJson,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath,
    [Parameter(Mandatory = $true)][string]$MetricsPath,
    [ValidateRange(1, 3600)][int]$TimeoutSeconds = 300,
    [ValidateRange(1, 1000)][int]$SampleIntervalMilliseconds = 20
)

$ErrorActionPreference = 'Stop'
$arguments = @(ConvertFrom-Json -InputObject $ArgumentJson)
$environment = ConvertFrom-Json -InputObject $EnvironmentJson
$info = [Diagnostics.ProcessStartInfo]::new((Resolve-Path -LiteralPath $Executable).Path)
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
foreach ($argument in $arguments) { [void]$info.ArgumentList.Add([string]$argument) }
foreach ($entry in $environment.PSObject.Properties) { $info.Environment[[string]$entry.Name] = [string]$entry.Value }

$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
$gpuCategory = $null
$gpuCounterError = $null
try {
    $gpuCategory = [Diagnostics.PerformanceCounterCategory]::new('GPU Process Memory')
    [void]$gpuCategory.GetInstanceNames()
} catch { $gpuCounterError = $_.Exception.Message }
$watch = [Diagnostics.Stopwatch]::StartNew()
[void]$process.Start()
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
$peakWorkingSet = 0L
$peakPrivate = 0L
$peakDedicatedGpu = 0L
$gpuSampleCount = 0
$sampleCount = 0
$timedOut = $false
$gpuCounters = @()
try {
    while (-not $process.HasExited) {
        $process.Refresh()
        try {
            $peakWorkingSet = [Math]::Max($peakWorkingSet, [int64]$process.PeakWorkingSet64)
            $peakPrivate = [Math]::Max($peakPrivate, [int64]$process.PrivateMemorySize64)
        } catch {}
        if ($null -ne $gpuCategory -and ($sampleCount % 10) -eq 0 -and $gpuCounters.Count -eq 0) {
            try {
                $prefix = "pid_$($process.Id)_"
                $instances = @($gpuCategory.GetInstanceNames() |
                    Where-Object { $_.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
                $gpuCounters = @($instances | ForEach-Object {
                    [Diagnostics.PerformanceCounter]::new('GPU Process Memory', 'Dedicated Usage', $_, $true)
                })
            } catch { $gpuCounterError = $_.Exception.Message }
        }
        if ($gpuCounters.Count -gt 0) {
            try {
                $dedicated = [int64]0
                foreach ($counter in $gpuCounters) { $dedicated += [int64]$counter.RawValue }
                $peakDedicatedGpu = [Math]::Max($peakDedicatedGpu, $dedicated)
                $gpuSampleCount += 1
            } catch { $gpuCounterError = $_.Exception.Message }
        }
        $sampleCount += 1
        if ($watch.Elapsed.TotalSeconds -gt $TimeoutSeconds) {
            $timedOut = $true
            $process.Kill($true)
            break
        }
        Start-Sleep -Milliseconds $SampleIntervalMilliseconds
    }
    $process.WaitForExit()
    $watch.Stop()
    [IO.File]::WriteAllText($StdoutPath, $stdoutTask.GetAwaiter().GetResult())
    [IO.File]::WriteAllText($StderrPath, $stderrTask.GetAwaiter().GetResult())
    $summary = [ordered]@{
        schema = 'deep-engine.windows-process-metrics'
        schemaVersion = 1
        executableSha256 = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
        processId = $process.Id
        exitCode = $process.ExitCode
        timedOut = $timedOut
        durationMilliseconds = $watch.Elapsed.TotalMilliseconds
        sampleIntervalMilliseconds = $SampleIntervalMilliseconds
        sampleCount = $sampleCount
        peakHostBytes = if ($sampleCount -gt 0) { $peakWorkingSet } else { $null }
        peakPrivateBytes = if ($sampleCount -gt 0) { $peakPrivate } else { $null }
        peakGpuBytes = if ($gpuSampleCount -gt 0) { $peakDedicatedGpu } else { $null }
        gpuSampleCount = $gpuSampleCount
        gpuMetric = 'Windows GPU Process Memory/Dedicated Usage; summed across PID instances'
        gpuCounterError = $gpuCounterError
    }
    $json = $summary | ConvertTo-Json -Depth 5 -Compress
    [IO.File]::WriteAllText($MetricsPath, $json)
    $json
    if ($timedOut) { exit 124 }
    exit $process.ExitCode
} finally {
    foreach ($counter in $gpuCounters) { $counter.Dispose() }
    $process.Dispose()
}
