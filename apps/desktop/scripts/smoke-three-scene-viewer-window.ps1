param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [int]$StartupTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$debugPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SceneViewerWindowProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr deviceContext, uint flags);
  public static IntPtr Find(uint wanted) {
    IntPtr found = IntPtr.Zero;
    long largestArea = 0;
    EnumWindows((handle, ignored) => {
      uint processId;
      GetWindowThreadProcessId(handle, out processId);
      if (processId == wanted) {
        var className = new StringBuilder(128);
        GetClassName(handle, className, className.Capacity);
        RECT rect;
        if (className.ToString() == "Tauri Window" && GetWindowRect(handle, out rect)) {
          long area = Math.Max(0, rect.Right - rect.Left) * (long)Math.Max(0, rect.Bottom - rect.Top);
          if (found == IntPtr.Zero || area > largestArea) { found = handle; largestArea = area; }
        }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Title(IntPtr handle) {
    var text = new StringBuilder(512);
    GetWindowText(handle, text, text.Capacity);
    return text.ToString();
  }
  public static void Restore(IntPtr handle) {
    SendMessage(handle, 0x0112, (IntPtr)0xF120, IntPtr.Zero);
    SetForegroundWindow(handle);
  }
}
'@

function Get-ViewerRect([IntPtr]$Handle) {
  $rect = New-Object SceneViewerWindowProbe+RECT
  [void][SceneViewerWindowProbe]::GetWindowRect($Handle, [ref]$rect)
  return $rect
}

function Save-ViewerWindow([IntPtr]$Handle, [string]$Path) {
  $rect = Get-ViewerRect $Handle
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 600 -or $height -lt 400) { throw "Viewer window size invalid: ${width}x${height}" }
  $bitmap = [Drawing.Bitmap]::new($width, $height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $deviceContext = $graphics.GetHdc()
    try {
      if (-not [SceneViewerWindowProbe]::PrintWindow($Handle, $deviceContext, 2)) { throw "PrintWindow failed" }
    } finally {
      $graphics.ReleaseHdc($deviceContext)
    }
    $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return $rect
}

function Compare-ViewerImages([string]$Before, [string]$After, [string]$TitleBarImage) {
  $beforeImage = [Drawing.Bitmap]::FromFile($Before)
  $afterImage = [Drawing.Bitmap]::FromFile($After)
  $titleImage = [Drawing.Bitmap]::FromFile($TitleBarImage)
  $changed = 0
  $colors = [Collections.Generic.HashSet[int]]::new()
  $titleLuma = 0.0
  $titleSamples = 0
  try {
    for ($y = [Math]::Max(0, $beforeImage.Height - 100); $y -lt $beforeImage.Height; $y += 2) {
      for ($x = 0; $x -lt [Math]::Min(600, $beforeImage.Width); $x += 2) {
        if ($beforeImage.GetPixel($x, $y).ToArgb() -ne $afterImage.GetPixel($x, $y).ToArgb()) { $changed++ }
      }
    }
    for ($y = 32; $y -lt $beforeImage.Height; $y += 24) {
      for ($x = 0; $x -lt $beforeImage.Width; $x += 24) { [void]$colors.Add($beforeImage.GetPixel($x, $y).ToArgb()) }
    }
    for ($y = 4; $y -lt [Math]::Min(26, $titleImage.Height); $y += 3) {
      for ($x = 220; $x -lt [Math]::Max(221, $titleImage.Width - 220); $x += 12) {
        $pixel = $titleImage.GetPixel($x, $y)
        $titleLuma += 0.2126 * $pixel.R + 0.7152 * $pixel.G + 0.0722 * $pixel.B
        $titleSamples++
      }
    }
  } finally {
    $beforeImage.Dispose()
    $afterImage.Dispose()
    $titleImage.Dispose()
  }
  return @{ changed = $changed; uniqueColors = $colors.Count; titleBarLuma = [Math]::Round($titleLuma / [Math]::Max(1, $titleSamples), 1) }
}

$process = $null
try {
  $start = Get-Date
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $executablePath
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardError = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.EnvironmentVariables["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=$debugPort"
  $process = [Diagnostics.Process]::Start($startInfo)
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  $handle = [IntPtr]::Zero
  do {
    Start-Sleep -Milliseconds 100
    $handle = [SceneViewerWindowProbe]::Find([uint32]$process.Id)
  } while ($handle -eq [IntPtr]::Zero -and -not $process.HasExited -and (Get-Date) -lt $deadline)
  if ($process.HasExited) { throw "Viewer exited before window: $($process.ExitCode) $($process.StandardError.ReadToEnd())" }
  if ($handle -eq [IntPtr]::Zero) { throw "Viewer window did not appear within $StartupTimeoutSeconds seconds" }

  do {
    [SceneViewerWindowProbe]::Restore($handle)
    Start-Sleep -Milliseconds 300
    $handle = [SceneViewerWindowProbe]::Find([uint32]$process.Id)
    if ($handle -eq [IntPtr]::Zero) { continue }
    $rect = Get-ViewerRect $handle
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
  } while (($width -lt 600 -or $height -lt 400) -and -not $process.HasExited -and (Get-Date) -lt $deadline)
  if ($width -lt 600 -or $height -lt 400) { throw "Viewer window did not restore: ${width}x${height}" }

  Start-Sleep -Seconds 6
  if ($process.HasExited) { throw "Viewer exited during startup: $($process.ExitCode) $($process.StandardError.ReadToEnd())" }
  # Test runners and the desktop shell can minimize a freshly focused WebView window.
  # Restore immediately before each capture so the evidence reflects the live client,
  # not the 159x27 minimized window rectangle.
  $handle = [SceneViewerWindowProbe]::Find([uint32]$process.Id)
  [SceneViewerWindowProbe]::Restore($handle)
  Start-Sleep -Milliseconds 500
  $before = Join-Path $outputPath "window-before.png"
  $rect = Save-ViewerWindow $handle $before
  $readyMs = [int](((Get-Date) - $start).TotalMilliseconds)
  $cdpText = & node (Join-Path $PSScriptRoot "inspect-three-scene-viewer-cdp.mjs") $debugPort $outputPath
  if ($LASTEXITCODE -ne 0) { throw "Scene viewer CDP inspection failed" }
  $cdpJson = $cdpText -join [Environment]::NewLine
  $cdp = $cdpJson | ConvertFrom-Json
  $cdpJson | Set-Content -LiteralPath (Join-Path $outputPath "window-cdp.json") -Encoding utf8
  if (
    -not $cdp.clicked -or
    -not $cdp.before.dock -or
    -not $cdp.after.dock -or
    $cdp.before.dock.ariaExpanded -eq $cdp.after.dock.ariaExpanded
  ) {
    throw "Viewer tool dock did not accept input: $cdpText"
  }
  Start-Sleep -Seconds 2
  if ($process.HasExited) { throw "Viewer exited after input: $($process.ExitCode) $($process.StandardError.ReadToEnd())" }
  $handle = [SceneViewerWindowProbe]::Find([uint32]$process.Id)
  [SceneViewerWindowProbe]::Restore($handle)
  Start-Sleep -Milliseconds 500
  $after = Join-Path $outputPath "window-after-toggle.png"
  [void](Save-ViewerWindow $handle $after)
  $comparison = Compare-ViewerImages (Join-Path $outputPath "webview-before.png") (Join-Path $outputPath "webview-after-toggle.png") $before
  if ($comparison.changed -lt 20) { throw "Viewer input produced insufficient visual change: $($comparison.changed) sampled pixels" }
  if ($comparison.uniqueColors -lt 8) { throw "Viewer content remained visually empty: $($comparison.uniqueColors) sampled colors" }
  if ($comparison.titleBarLuma -gt 100) { throw "Viewer title bar is not dark: luma $($comparison.titleBarLuma)" }

  $process.Refresh()
  $record = [ordered]@{
    ok = $true
    pid = $process.Id
    handle = $handle.ToInt64()
    title = [SceneViewerWindowProbe]::Title($handle)
    responding = $process.Responding
    windowReadyMs = $readyMs
    window = @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom; width = $width; height = $height }
    input = @{ action = "click viewer tool dock toggle through WebView2 CDP"; before = $cdp.before.dock.ariaExpanded; after = $cdp.after.dock.ariaExpanded; sampledChangedPixels = $comparison.changed }
    visual = @{ sampledUniqueColors = $comparison.uniqueColors; titleBarLuma = $comparison.titleBarLuma }
    cdp = $cdp
    before = $before
    after = $after
    webviewBefore = Join-Path $outputPath "webview-before.png"
    webviewAfter = Join-Path $outputPath "webview-after-toggle.png"
    executable = $executablePath
    inspector = Get-Content (Join-Path $outputPath "inspection.json") -Raw | ConvertFrom-Json
  }
  $record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputPath "window-smoke.json") -Encoding utf8
  $record | ConvertTo-Json -Depth 6
} finally {
  if ($process -and -not $process.HasExited) {
    [void]$process.CloseMainWindow()
    if (-not $process.WaitForExit(3000)) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
  }
}
