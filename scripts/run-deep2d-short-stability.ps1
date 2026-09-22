param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$BuildLabel = 'current-worktree-release',
    [ValidateRange(1, 20)][int]$Rounds = 20,
    [ValidateRange(30, 900)][int]$TimeoutSeconds = 600
)
$ErrorActionPreference = 'Stop'
$taskExe = (Resolve-Path -LiteralPath $Executable).Path
if (Test-Path -LiteralPath $OutputDirectory) {
    throw 'Choose a new output directory so previous evidence is preserved.'
}
$taskOutput = (New-Item -ItemType Directory -Path $OutputDirectory).FullName
$taskSources = @(
    'packages/deep-engine-native/tests/chart_e2e_perf.rs',
    'packages/deep-engine-native/tests/support/chart_e2e_environment.rs',
    'packages/deep-engine-native/tests/support/chart_e2e_measurements.rs',
    'packages/deep-engine-native/tests/support/chart_e2e_scenarios.rs'
)
$taskMetadata = [ordered]@{
    schema = 1
    startedAt = [DateTime]::UtcNow.ToString('o')
    revision = (git rev-parse HEAD)
    worktreeStatus = @(git status --short)
    executable = $taskExe
    executableSha256 = (Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash
    buildLabel = $BuildLabel
    workspaceSourceSha256 = @($taskSources | ForEach-Object { Get-FileHash -LiteralPath $_ -Algorithm SHA256 } | Select-Object Path, Hash)
    os = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber)
    cpu = (Get-CimInstance Win32_Processor | Select-Object Name, NumberOfLogicalProcessors)
    gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion)
    powerPlan = @(powercfg /getactivescheme)
    rounds = $Rounds
    timeoutSeconds = $TimeoutSeconds
    samplesPerScenario = 30
    warmupPerScenario = 5
    memorySamplingMilliseconds = 100
    memoryScope = 'OS process working/private memory; not dedicated GPU VRAM; renderer estimate excludes atlases/pipelines'
}
$taskMetadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskOutput 'conditions.json') -Encoding utf8
$taskPreviousRounds = $env:DEEP_CHART_PERF_ROUNDS
$env:DEEP_CHART_PERF_ROUNDS = [string]$Rounds
$taskSamples = [System.Collections.Generic.List[object]]::new()
$taskTimer = [System.Diagnostics.Stopwatch]::StartNew()
$taskTimedOut = $false
try {
    $taskProcess = Start-Process -FilePath $taskExe -ArgumentList @('--exact', 'chart_e2e_perf_baseline', '--ignored', '--nocapture', '--test-threads=1') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskOutput 'stdout.log') -RedirectStandardError (Join-Path $taskOutput 'stderr.log')
    do {
        if ($taskTimer.Elapsed.TotalSeconds -gt $TimeoutSeconds) {
            $taskTimedOut = $true
            $taskProcess.Kill()
            break
        }
        $taskProcess.Refresh()
        if (!$taskProcess.HasExited) {
            $taskSamples.Add([pscustomobject]@{
                elapsedSeconds = $taskTimer.Elapsed.TotalSeconds
                workingSetBytes = $taskProcess.WorkingSet64
                privateBytes = $taskProcess.PrivateMemorySize64
                peakWorkingSetBytes = $taskProcess.PeakWorkingSet64
                handles = $taskProcess.HandleCount
                threads = $taskProcess.Threads.Count
            })
        }
    } while (!$taskProcess.WaitForExit(100))
    $taskProcess.WaitForExit()
    $taskTimer.Stop()
    $taskSamples | Export-Csv -LiteralPath (Join-Path $taskOutput 'process-memory.csv') -NoTypeInformation -Encoding utf8
    [ordered]@{
        exitCode = $taskProcess.ExitCode
        timedOut = $taskTimedOut
        durationSeconds = $taskTimer.Elapsed.TotalSeconds
        processId = $taskProcess.Id
        sampledPeakWorkingSetBytes = ($taskSamples | Measure-Object workingSetBytes -Maximum).Maximum
        osPeakWorkingSetBytes = ($taskSamples | Measure-Object peakWorkingSetBytes -Maximum).Maximum
        sampledPeakPrivateBytes = ($taskSamples | Measure-Object privateBytes -Maximum).Maximum
        sampledPeakHandles = ($taskSamples | Measure-Object handles -Maximum).Maximum
        sampleCount = $taskSamples.Count
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskOutput 'summary.json') -Encoding utf8
    if ($taskProcess.ExitCode -ne 0) { throw "Benchmark exited with $($taskProcess.ExitCode); inspect raw logs." }
    Get-Content -LiteralPath (Join-Path $taskOutput 'summary.json')
} finally {
    $env:DEEP_CHART_PERF_ROUNDS = $taskPreviousRounds
}
