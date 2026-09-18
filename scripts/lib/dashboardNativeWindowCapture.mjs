import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CAPTURE_PS1 = `param([int]$ProcId,[string]$OutPath)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeWinCapture {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[NativeWinCapture]::SetProcessDPIAware() | Out-Null
$proc = Get-Process -Id $ProcId -ErrorAction Stop
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw "process $ProcId has no main window" }
[NativeWinCapture]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 800
$rect = New-Object NativeWinCapture+RECT
[NativeWinCapture]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { throw "empty window rect" }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$printed = [NativeWinCapture]::PrintWindow($hwnd, $hdc, 3)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $printed) {
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
  $g2.Dispose()
}
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $OutPath $($w)x$($h) printed=$printed"
`;

/**
 * 真实窗口截图：可见地启动本地播放器（PATH 仅 System32，证明无 Node/浏览器依赖），
 * 等待呈现检查点后用 PrintWindow 抓取实际窗口像素。失败抛错，不做静默回退。
 */
export async function captureNativePlayerWindow({ label, executable, args, env, outputDirectory, presentedMarker, timeoutMs = 30_000 }) {
  await mkdir(outputDirectory, { recursive: true });
  const ps1 = path.join(outputDirectory, `${label}-capture.ps1`);
  await writeFile(ps1, CAPTURE_PS1, "utf8");
  const png = path.join(outputDirectory, `${label}.png`);
  const child = spawn(executable, args, {
    cwd: path.dirname(executable), shell: false, windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"], env,
  });
  let log = "", presented = false, spawnError;
  const deadline = setTimeout(() => child.kill(), timeoutMs);
  child.stdout.on("data", bytes => { log += bytes.toString(); if (log.includes(presentedMarker)) presented = true; });
  child.stderr.on("data", bytes => { log += bytes.toString(); if (log.includes(presentedMarker)) presented = true; });
  child.once("error", reason => { spawnError = reason; });
  try {
    const started = Date.now();
    while (!presented && !spawnError && child.exitCode === null && Date.now() - started < timeoutMs) await sleep(200);
    if (spawnError) throw spawnError;
    if (!presented) throw new Error(`[${label}] presented marker not seen in player log: ${log.slice(-600)}`);
    await sleep(2_500); // 等待 DWM 合成与首帧后处理稳定,避免抓到空白帧。
    if (child.exitCode !== null) throw new Error(`[${label}] player exited before capture: ${log.slice(-600)}`);
    const capture = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1,
      "-ProcId", String(child.pid), "-OutPath", png], { windowsHide: true, encoding: "utf8" });
    let captureOutput = "";
    capture.stdout.on("data", bytes => { captureOutput += bytes.toString(); });
    capture.stderr.on("data", bytes => { captureOutput += bytes.toString(); });
    const captureCode = await new Promise((resolve, reject) => {
      const captureTimeout = setTimeout(() => reject(new Error(`[${label}] capture timed out: ${captureOutput}`)), 20_000);
      capture.once("error", reject);
      capture.once("close", code => { clearTimeout(captureTimeout); resolve(code); });
    });
    if (captureCode !== 0) throw new Error(`[${label}] window capture failed: ${captureOutput}`);
    return { label, png, windowShaNote: "PrintWindow of the real player window", pid: child.pid,
      captureLog: captureOutput.trim(), playerLogHead: log.slice(0, 2_000) };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
