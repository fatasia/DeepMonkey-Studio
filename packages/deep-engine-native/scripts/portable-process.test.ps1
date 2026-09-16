$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'portable-package-common.ps1')

$testParent = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../target/process-tests'))
$testRoot = Join-Path $testParent ([Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Force -Path $testRoot)
$shell = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $shell)) { $shell = Join-Path $PSHOME 'pwsh.exe' }
try {
  $script = Join-Path $testRoot 'argument fixture.ps1'
  Write-Utf8File -Path $script -Content '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ConvertTo-Json -Compress -InputObject @($args); [Console]::Error.Write("diagnostic"); exit 7'
  # Windows PowerShell's own -File parser drops empty arguments before the fixture.
  if ((ConvertTo-NativeArgument '') -cne '""') { throw 'Empty argument was not quoted' }
  $values = @('space path', 'quote"value', 'C:\trailing\', 'a\\"b', '中文')
  $result = Invoke-PortableProcess -Executable $shell -Arguments (@('-NoProfile', '-File', $script) + $values)
  if ($result.exitCode -ne 7 -or -not $result.output.Contains('diagnostic')) {
    throw 'Exit code or stderr was lost'
  }
  $actual = ($result.output -split "`r?`n")[0] | ConvertFrom-Json
  if ($actual.Count -ne $values.Count) { throw 'Argument count changed' }
  for ($index = 0; $index -lt $values.Count; $index++) {
    if ($actual[$index] -cne $values[$index]) { throw "Argument $index changed" }
  }
  Write-Utf8File -Path $script -Content 'Start-Sleep -Seconds 30'
  $timedOut = $false
  try {
    Invoke-PortableProcess -Executable $shell -Arguments @('-NoProfile', '-File', $script) -TimeoutMilliseconds 200 | Out-Null
  } catch {
    if (-not $_.Exception.Message.Contains('timed out')) { throw }
    $timedOut = $true
  }
  if (-not $timedOut) { throw 'A stalled child was accepted' }
  'Portable process regressions passed: arguments, Unicode, stderr, exit code, timeout.'
} finally {
  Assert-ChildPath -Root $testParent -Path $testRoot
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}
