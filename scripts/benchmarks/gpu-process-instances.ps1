# Select every adapter instance belonging to a live process in this tree.
function Get-GpuTreeCounterInstances {
    param(
        [string[]]$InstanceNames,
        [System.Collections.Generic.HashSet[int]]$LiveProcessIds
    )
    foreach ($name in $InstanceNames) {
        if ($name -match '^pid_([0-9]+)_' -and $LiveProcessIds.Contains([int]$Matches[1])) {
            $name
        }
    }
}
