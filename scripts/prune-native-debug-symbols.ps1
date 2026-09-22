[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateRange(1, 10)][int]$KeepPerTarget = 1,
    [ValidateRange(0, 1440)][int]$MinimumAgeMinutes = 10,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskSymbolRoot = [IO.Path]::GetFullPath((Join-Path $taskWorkspace 'packages/deep-engine-native/target/debug/deps'))
$taskExpectedSuffix = [IO.Path]::Combine('packages', 'deep-engine-native', 'target', 'debug', 'deps')
if (-not $taskSymbolRoot.StartsWith($taskWorkspace + [IO.Path]::DirectorySeparatorChar) -or
    -not $taskSymbolRoot.EndsWith($taskExpectedSuffix)) { throw 'Unexpected symbol directory' }
if (-not (Test-Path -LiteralPath $taskSymbolRoot -PathType Container)) {
    Write-Output 'No Native debug symbol cache exists.'
    return
}
$taskDirectory = Get-Item -LiteralPath $taskSymbolRoot
if ($taskDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Symbol directory is a reparse point' }
# No recursive deletion: executables, dependencies, incremental state and evidence are outside this operation.
$taskSymbols = @(Get-ChildItem -LiteralPath $taskSymbolRoot -File -Filter '*.pdb')
$taskCutoff = (Get-Date).AddMinutes(-$MinimumAgeMinutes)
$taskStale = @($taskSymbols |
    Group-Object { $_.BaseName -replace '-[0-9a-f]{16}$', '' } |
    ForEach-Object { $_.Group | Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepPerTarget } |
    Where-Object { $_.LastWriteTime -lt $taskCutoff })
$taskProposedBytes = ($taskStale | Measure-Object Length -Sum).Sum
$taskRemovedBytes = 0L
$taskRemovedFiles = 0
if ($Apply) {
    if (-not $IsWindows) { throw 'This cleanup entry is Windows-only' }
    $taskCompilers = @(Get-CimInstance Win32_Process -Filter "Name = 'rustc.exe'" |
        Where-Object { $_.CommandLine -match 'target[/\\]debug' })
    if ($taskCompilers.Count) { throw 'A debug compiler is active; rerun after compilation finishes' }
    foreach ($taskFile in $taskStale) {
        $taskCurrent = Get-Item -LiteralPath $taskFile.FullName
        if ($taskCurrent.DirectoryName -ne $taskSymbolRoot -or $taskCurrent.Extension -ne '.pdb' -or
            ($taskCurrent.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $taskCurrent.LastWriteTimeUtc -ne $taskFile.LastWriteTimeUtc -or $taskCurrent.Length -ne $taskFile.Length) {
            throw "Symbol changed during inspection: $($taskFile.Name)"
        }
        if ($PSCmdlet.ShouldProcess($taskCurrent.FullName, 'Remove stale rebuildable debug symbols')) {
            Remove-Item -LiteralPath $taskCurrent.FullName -ErrorAction Stop
            $taskRemovedFiles += 1
            $taskRemovedBytes += $taskCurrent.Length
        }
    }
}
[pscustomobject]@{
    Directory = $taskSymbolRoot
    Mode = $(if ($Apply) { 'apply' } else { 'preview' })
    KeepPerTarget = $KeepPerTarget
    ExistingFiles = $taskSymbols.Count
    ProposedFiles = $taskStale.Count
    ProposedGiB = [math]::Round($taskProposedBytes / 1GB, 3)
    RemovedFiles = $taskRemovedFiles
    RemovedGiB = [math]::Round($taskRemovedBytes / 1GB, 3)
} | ConvertTo-Json
