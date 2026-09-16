function ConvertTo-NativeArgument {
  param([AllowEmptyString()][string]$Value)
  # Windows CRT doubles backslashes before quotes and the closing delimiter.
  $quoted = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $quoted = [regex]::Replace($quoted, '(\\+)$', '$1$1')
  return '"' + $quoted + '"'
}

function Invoke-PortableProcess {
  param(
    [Parameter(Mandatory)][string]$Executable,
    [string[]]$Arguments = @(),
    [ValidateRange(1, 600000)][int]$TimeoutMilliseconds = 60000
  )
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Executable
  $start.Arguments = (@($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
  $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try {
    if (-not $process.Start()) { throw "Unable to start portable check: $Executable" }
    # Drain both pipes concurrently: verbose GPU diagnostics must not deadlock the child.
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      $process.Kill()
      [void]$process.WaitForExit(5000)
      throw "Portable check timed out after $TimeoutMilliseconds ms: $Executable $($start.Arguments)"
    }
    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), 5000)) {
      throw "Portable check output did not close: $Executable"
    }
    return [ordered]@{
      exitCode = $process.ExitCode
      output = $stdout.Result + "`n" + $stderr.Result
      elapsedMilliseconds = $timer.ElapsedMilliseconds
    }
  } finally {
    $timer.Stop()
    $process.Dispose()
  }
}
