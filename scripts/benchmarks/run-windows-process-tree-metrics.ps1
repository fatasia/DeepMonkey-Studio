param(
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [Parameter(Mandatory = $true)][string]$MetricsPath,
    [string]$StopFilePath = "",
    [ValidateRange(1, 7200)][int]$TimeoutSeconds = 600,
    [ValidateRange(20, 5000)][int]$SampleIntervalMilliseconds = 200
)

# 进程树内存采样（attach 型，a01x 配对链路专用）：与 spawn 型 run-windows-process-metrics.ps1
# 互补——本脚本挂接到已在运行的进程（如 playwright 启动的 Chrome 主进程），以根进程为起点
# 逐样本枚举 Win32_Process 计算后代闭包，聚合整棵树 WorkingSet / 私有内存的峰值与均值
# （mean = 样本累加和 / 样本数）；GPU 专用内存按 'GPU Process Memory' 性能计数器的
# pid_<id>_ 实例对树内进程尽力求和（失败不致命，gpuCounterError 如实记录）。
#
# 退出语义：调用方写入 StopFilePath 请求停止，本脚本在下一个采样 tick 检测到后把
# finished=true 的最终快照落盘并自行退出（stopReason=stop-file），避免强杀造成最后一次
# Write-Metrics 的半截文件竞态；进程树自行退出（tree-exited）或超时（timeout）同样
# 以 finished=true 收口。StopFilePath 的残留清理由调用方负责（启动新采样前必须删除
# 上次的 stop 文件，否则本脚本启动即退出、零样本）。peak-host-bytes 口径与 bevy 轨道
# 对齐（整树 WorkingSet 峰值）。

$ErrorActionPreference = 'Continue'
$watch = [Diagnostics.Stopwatch]::StartNew()
$script:PeakHost = 0L
$script:SumHost = 0L
$script:PeakPrivate = 0L
$script:SumPrivate = 0L
$script:SampleCount = 0
$script:Started = $false
$script:Finished = $false
$script:TimedOut = $false
$script:StopReason = $null
$script:PeakGpu = 0L
$script:GpuSampleCount = 0
$script:GpuCounterError = $null
$gpuCategory = $null
try {
    $gpuCategory = [Diagnostics.PerformanceCounterCategory]::new('GPU Process Memory')
    [void]$gpuCategory.GetInstanceNames()
} catch { $script:GpuCounterError = $_.Exception.Message }
$gpuCounters = @()

function Write-Metrics {
    # 每个采样 tick 全量重写快照：调用方可随时轮询解析增量结果（读到半截文件由调用方重试）。
    $summary = [ordered]@{
        schema = 'deep-engine.windows-process-tree-metrics'
        schemaVersion = 2
        rootProcessId = $RootProcessId
        timedOut = $script:TimedOut
        started = $script:Started
        finished = $script:Finished
        stopReason = $script:StopReason
        durationMilliseconds = $watch.Elapsed.TotalMilliseconds
        sampleIntervalMilliseconds = $SampleIntervalMilliseconds
        sampleCount = $script:SampleCount
        peakHostBytes = if ($script:SampleCount -gt 0) { $script:PeakHost } else { $null }
        meanHostBytes = if ($script:SampleCount -gt 0) { [double]($script:SumHost / $script:SampleCount) } else { $null }
        peakPrivateBytes = if ($script:SampleCount -gt 0) { $script:PeakPrivate } else { $null }
        meanPrivateBytes = if ($script:SampleCount -gt 0) { [double]($script:SumPrivate / $script:SampleCount) } else { $null }
        peakGpuBytes = if ($script:GpuSampleCount -gt 0) { $script:PeakGpu } else { $null }
        gpuSampleCount = $script:GpuSampleCount
        gpuMetric = 'Windows GPU Process Memory/Dedicated Usage; summed across tree PID instances'
        gpuCounterError = $script:GpuCounterError
    }
    $json = $summary | ConvertTo-Json -Depth 5 -Compress
    [IO.File]::WriteAllText($MetricsPath, $json)
}

while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    if ($StopFilePath -and (Test-Path -LiteralPath $StopFilePath)) {
        $script:Finished = $true
        $script:StopReason = 'stop-file'
        break
    }

    $procs = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, WorkingSetSize, PrivatePageCount)
    $byId = @{}
    foreach ($process in $procs) { $byId[[int]$process.ProcessId] = $process }

    # 后代闭包：从根进程出发沿 ParentProcessId 反复扩展，直到不再新增（容许中间层先死）。
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
        $script:Started = $true
        $hostBytes = 0L
        $privateBytes = 0L
        foreach ($id in $known) {
            if ($byId.ContainsKey($id)) {
                $hostBytes += [int64]$byId[$id].WorkingSetSize
                $privateBytes += [int64]$byId[$id].PrivatePageCount
            }
        }
        if ($hostBytes -gt $script:PeakHost) { $script:PeakHost = $hostBytes }
        $script:SumHost += $hostBytes
        if ($privateBytes -gt $script:PeakPrivate) { $script:PeakPrivate = $privateBytes }
        $script:SumPrivate += $privateBytes

        # GPU 专用内存：树内进程逐个匹配 pid_<id>_ 计数器实例；只做尽力采样，
        # 计数器类别不存在 / 实例未就绪 / 读取失败都不致命，错误原样透出由上游标注。
        if ($null -ne $gpuCategory) {
            foreach ($id in $known) {
                if ($gpuCounters.Count -gt 0) { break }
                $instanceName = "pid_${id}_"
                try {
                    $match = $gpuCategory.GetInstanceNames() | Where-Object { $_ -eq $instanceName }
                    if ($match) {
                        $gpuCounters = @([Diagnostics.PerformanceCounter]::new('GPU Process Memory', 'Dedicated Usage', $match, $true))
                    }
                } catch { $script:GpuCounterError = $_.Exception.Message }
            }
        }
        if ($gpuCounters.Count -gt 0) {
            try {
                $dedicated = 0L
                foreach ($counter in $gpuCounters) { $dedicated += [int64]$counter.RawValue }
                if ($dedicated -gt $script:PeakGpu) { $script:PeakGpu = $dedicated }
                $script:GpuSampleCount += 1
            } catch { $script:GpuCounterError = $_.Exception.Message }
        }
        $script:SampleCount += 1
    }
    elseif ($script:Started) {
        $script:Finished = $true
        $script:StopReason = 'tree-exited'
        break  # 进程树已退出
    }

    Write-Metrics
    Start-Sleep -Milliseconds $SampleIntervalMilliseconds
}
if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
    $script:TimedOut = $true
    $script:Finished = $true
    $script:StopReason = 'timeout'
}

foreach ($counter in $gpuCounters) { $counter.Dispose() }
Write-Metrics
exit 0
