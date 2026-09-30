$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'gpu-process-instances.ps1')
$liveIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$liveIds.Add(12)
[void]$liveIds.Add(34)
$names = @('pid_12_luid_0_1_phys_0', 'pid_12_luid_0_2_phys_1', 'pid_34_luid_0_1_phys_0',
    'pid_123_luid_0_1_phys_0', 'pid_56_luid_0_1_phys_0', '_Total', 'pid_bad_')
$actual = @(Get-GpuTreeCounterInstances -InstanceNames $names -LiveProcessIds $liveIds)
if (($actual -join ',') -ne ($names[0..2] -join ',')) { throw "Missing adapter/PID or wrong prefix scope: $actual" }
[void]$liveIds.Remove(12)
$actual = @(Get-GpuTreeCounterInstances -InstanceNames $names -LiveProcessIds $liveIds)
if ($actual.Count -ne 1 -or $actual[0] -ne $names[2]) { throw 'Exited process counters must be retired' }
$syntaxErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run-windows-process-tree-metrics.ps1'), [ref]$null, [ref]$syntaxErrors)
if ($syntaxErrors.Count) { throw ($syntaxErrors | Out-String) }
'GPU instance selection and sampler syntax passed'
