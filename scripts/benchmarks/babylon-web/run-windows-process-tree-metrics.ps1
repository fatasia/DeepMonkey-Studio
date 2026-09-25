param(
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [Parameter(Mandatory = $true)][string]$MetricsPath,
    [ValidateRange(1, 3600)][int]$TimeoutSeconds = 240,
    [ValidateRange(20, 5000)][int]$SampleIntervalMilliseconds = 200
)

# Chrome 进程树内存采样（Babylon Web 轨道专用）：以根进程（浏览器主进程）为起点，
# 逐样本枚举 Win32_Process 计算后代闭包，聚合 WorkingSet/私有内存峰值；
# GPU 专用内存按 'GPU Process Memory' 性能计数器的 pid_<id>_ 实例尽力采样（失败不致命）。
# 语义对照 run-windows-process-metrics.ps1：单进程树版；peakHostBytes 为整棵树的 WorkingSet 之和峰值。

$ErrorActionPreference = 'Continue'
$watch = [Diagnostics.Stopwatch]::StartNew()
$peakHost = 0L
$peakPrivate = 0L
$sampleCount = 0
$started = $false
$peakGpu = 0L
$gpuSampleCount = 0
$gpuCounterError = $null
$gpuCategory = $null
try {
    $gpuCategory = [Diagnostics.PerformanceCounterCategory]::new('GPU Process Memory')
    [void]$gpuCategory.GetInstanceNames()
} catch { $gpuCounterError = $_.Exception.Message }
$gpuCounters = @()
$timedOut = $false

function Write-Metrics {
    $summary = [ordered]@{
        schema = 'deep-engine.windows-process-tree-metrics'
        schemaVersion = 1
        rootProcessId = $RootProcessId
        timedOut = $timedOut
        started = $started
        finished = $script:finished
        durationMilliseconds = $watch.Elapsed.TotalMilliseconds
        sampleIntervalMilliseconds = $SampleIntervalMilliseconds
        sampleCount = $sampleCount
        peakHostBytes = if ($sampleCount -gt 0) { $peakHost } else { $null }
        peakPrivateBytes = if ($sampleCount -gt 0) { $peakPrivate } else { $null }
        peakGpuBytes = if ($gpuSampleCount -gt 0) { $peakGpu } else { $null }
        gpuSampleCount = $gpuSampleCount
        gpuMetric = 'Windows GPU Process Memory/Dedicated Usage; summed across tree PID instances'
        gpuCounterError = $gpuCounterError
    }
    $json = $summary | ConvertTo-Json -Depth 5 -Compress
    [IO.File]::WriteAllText($MetricsPath, $json)
}

$finished = $false

while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    $procs = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, WorkingSetSize, PrivatePageCount)
    $byId = @{}
    foreach ($process in $procs) { $byId[[int]$process.ProcessId] = $process }

    $known = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$known.Add($RootProcessId)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($process in $procs) {
            $processId = [int]$process.ProcessId
            $parentId = [int]$process.ParentProcessId
            if (-not $known.Contains($processId) -and $known.Contains($parentId)) {
                [void]$known.Add($processId)
                $changed = $true
            }
        }
    }

    if ($known.Count -gt 0 -and $byId.ContainsKey($RootProcessId)) {
        $started = $true
        $hostBytes = 0L
        $privateBytes = 0L
        foreach ($id in $known) {
            if ($byId.ContainsKey($id)) {
                $hostBytes += [int64]$byId[$id].WorkingSetSize
                $privateBytes += [int64]$byId[$id].PrivatePageCount
            }
        }
        if ($hostBytes -gt $peakHost) { $peakHost = $hostBytes }
        if ($privateBytes -gt $peakPrivate) { $peakPrivate = $privateBytes }

        if ($null -ne $gpuCategory) {
            foreach ($id in $known) {
                $instanceName = "pid_${id}_"
                if ($gpuCounters.Count -eq 0) {
                    try {
                        $match = $gpuCategory.GetInstanceNames() | Where-Object { $_ -eq $instanceName }
                        if ($match) {
                            $gpuCounters = @([Diagnostics.PerformanceCounter]::new('GPU Process Memory', 'Dedicated Usage', $match, $true))
                        }
                    } catch { $gpuCounterError = $_.Exception.Message }
                }
            }
        }
        if ($gpuCounters.Count -gt 0) {
            try {
                $dedicated = 0L
                foreach ($counter in $gpuCounters) { $dedicated += [int64]$counter.RawValue }
                if ($dedicated -gt $peakGpu) { $peakGpu = $dedicated }
                $gpuSampleCount += 1
            } catch { $gpuCounterError = $_.Exception.Message }
        }
        $sampleCount += 1
    }
    elseif ($started) {
        $finished = $true
        break  # 进程树已退出
    }

    Write-Metrics
    Start-Sleep -Milliseconds $SampleIntervalMilliseconds
}
if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) { $timedOut = $true; $finished = $true }

foreach ($counter in $gpuCounters) { $counter.Dispose() }
Write-Metrics
exit 0
