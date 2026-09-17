param([Parameter(Mandatory)][string]$Executable, [Parameter(Mandatory)][string]$Package, [Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ChromeProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$previousDpi = [ChromeProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
if (Test-Path -LiteralPath $Output) { throw 'Use a new evidence directory.' }
[void](New-Item -ItemType Directory -Path $Output)
$exe = (Resolve-Path -LiteralPath $Executable).Path
$pkg = (Resolve-Path -LiteralPath $Package).Path
$process = Start-Process -FilePath $exe -ArgumentList @('--package', ('"' + $pkg + '"')) -WindowStyle Hidden -PassThru
function Bounds {
  $rect = [ChromeProbe+Rect]::new()
  if (-not [ChromeProbe]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) { throw 'Window not found.' }
  return $rect
}
function Key([int]$code, [int]$scan) {
  $handle = $process.MainWindowHandle
  if (-not [ChromeProbe]::PostMessage($handle, 0x100, [IntPtr]$code, [IntPtr](1 -bor ($scan -shl 16)))) { throw 'Key dispatch failed.' }
  [void][ChromeProbe]::PostMessage($handle, 0x101, [IntPtr]$code, [IntPtr]([long]0xC0000001L -bor ($scan -shl 16)))
  Start-Sleep -Milliseconds 600
  $process.Refresh()
  if ($process.HasExited) { throw 'Fullscreen key closed the client.' }
}
function Capture([string]$name) {
  $rect = Bounds
  $bitmap = [Drawing.Bitmap]::new($rect.Right-$rect.Left, $rect.Bottom-$rect.Top)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $dc = $graphics.GetHdc()
    try {
      if (-not [ChromeProbe]::PrintWindow($process.MainWindowHandle, $dc, 2)) { throw 'Target window capture unavailable.' }
    } finally { $graphics.ReleaseHdc($dc) }
    $bitmap.Save((Join-Path $Output "$name.png"))
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
try {
  for ($attempt=0; $attempt -lt 80; $attempt++) {
    $process.Refresh()
    if ($process.HasExited) { throw 'Client exited during startup.' }
    if ($process.MainWindowHandle -ne 0) { break }
    Start-Sleep -Milliseconds 100
  }
  Start-Sleep -Seconds 2
  [void][ChromeProbe]::SetForegroundWindow($process.MainWindowHandle)
  foreach ($width in @(960, 520)) {
    [void][ChromeProbe]::SetWindowPos($process.MainWindowHandle, [IntPtr]::Zero, 80, 80, $width, 560, 0x0040)
    Start-Sleep -Milliseconds 500
    $before = Bounds
    Capture "window-$width"
    Key 0x7A 0x57
    $full = Bounds
    if (($full.Right-$full.Left) -le ($before.Right-$before.Left)) { throw 'F11 did not enter fullscreen.' }
    Capture "fullscreen-$width"
    Key 0x1B 0x01
    $after = Bounds
    if ($before.Left -ne $after.Left -or $before.Top -ne $after.Top -or $before.Right -ne $after.Right -or $before.Bottom -ne $after.Bottom) { throw 'Escape did not restore the original window bounds.' }
    Capture "restored-$width"
  }
  Write-Output 'PASS: two window sizes, F11 fullscreen, Escape restore, client remains running.'
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
  [void][ChromeProbe]::SetThreadDpiAwarenessContext($previousDpi)
}
