import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CAPTURE_PS1 = `param([int]$ProcId,[string]$OutPath,[int]$ClientWidth=0,[int]$ClientHeight=0,[int]$ClickX=-1,[int]$ClickY=-1,[int]$HoverOnly=0,[int]$ArrowDown=0,[string]$ReportPath='', [int]$CancelReport=0,[string]$PreClicks='',[int]$MinContentColors=8)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeWinCapture {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")] public static extern IntPtr SendMessageText(IntPtr hwnd, uint message, IntPtr wparam, string text);
  public static IntPtr SaveDialog(uint processId) {
    IntPtr selected = IntPtr.Zero;
    EnumWindows((hwnd, data) => { uint owner; GetWindowThreadProcessId(hwnd, out owner);
      var name = new System.Text.StringBuilder(128); GetClassName(hwnd, name, 128);
      if(owner == processId && IsWindowVisible(hwnd) && name.ToString() == "#32770") selected = hwnd;
      return true; }, IntPtr.Zero);
    return selected;
  }
  public static IntPtr ReportEdit(IntPtr dialog) {
    var direct = GetDlgItem(dialog, 0x480);
    if (direct != IntPtr.Zero) { return direct; }
    return FindEditDescendant(dialog, 0);
  }
  public static IntPtr FindEditDescendant(IntPtr parent, int depth) {
    if (depth > 6) { return IntPtr.Zero; }
    var child = FindWindowEx(parent, IntPtr.Zero, null, null);
    while (child != IntPtr.Zero) {
      var edit = GetDlgItem(child, 0x480);
      if (edit != IntPtr.Zero) { return edit; }
      var deeper = FindEditDescendant(child, depth + 1);
      if (deeper != IntPtr.Zero) { return deeper; }
      child = FindWindowEx(parent, child, null, null);
    }
    return IntPtr.Zero;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string windowTitle);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int cbSize; public uint flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret; }
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
  public static IntPtr DialogFocus(IntPtr dialog) {
    uint ownerProcess;
    uint threadId = GetWindowThreadProcessId(dialog, out ownerProcess);
    var info = new GUITHREADINFO();
    info.cbSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(threadId, ref info)) { return IntPtr.Zero; }
    return info.hwndFocus;
  }
  public static void TypeText(string text) {
    foreach (char ch in text) {
      keybd_event(0, (byte)ch, 4, UIntPtr.Zero);
      keybd_event(0, (byte)ch, 6, UIntPtr.Zero);
    }
  }
  public static void PressEnter() {
    keybd_event(13, 0, 0, UIntPtr.Zero);
    keybd_event(13, 0, 2, UIntPtr.Zero);
  }
  public static string DialogDiagnostics(uint processId) {
    var dump = new System.Text.StringBuilder();
    EnumWindows((hwnd, data) => { uint owner; GetWindowThreadProcessId(hwnd, out owner);
      if (owner != processId || !IsWindowVisible(hwnd)) { return true; }
      var cls = new System.Text.StringBuilder(128); GetClassName(hwnd, cls, 128);
      var title = new System.Text.StringBuilder(128); GetWindowText(hwnd, title, 128);
      dump.Append("WIN cls=").Append(cls).Append(" title=").Append(title).Append(" id480=").Append(GetDlgItem(hwnd, 0x480) != IntPtr.Zero).Append("; ");
      var child = FindWindowEx(hwnd, IntPtr.Zero, null, null);
      int shown = 0;
      while (child != IntPtr.Zero && shown < 12) {
        var ccls = new System.Text.StringBuilder(128); GetClassName(child, ccls, 128);
        dump.Append("[child cls=").Append(ccls).Append(" id480=").Append(GetDlgItem(child, 0x480) != IntPtr.Zero).Append("] ");
        child = FindWindowEx(hwnd, child, null, null); shown++;
      }
      return true; }, IntPtr.Zero);
    return dump.ToString();
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindow callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  public struct POINT { public int X; public int Y; }
  public static void ClickClient(IntPtr hwnd, int x, int y) {
    IntPtr point = new IntPtr((y << 16) | x);
    if (!PostMessage(hwnd, 0x200, IntPtr.Zero, new IntPtr((y << 16) | (x + 1))) ||
        !PostMessage(hwnd, 0x200, IntPtr.Zero, point) ||
        !PostMessage(hwnd, 0x201, new IntPtr(1), point) ||
        !PostMessage(hwnd, 0x202, IntPtr.Zero, point)) throw new Exception("Player input queue failed");
  }
  public delegate bool EnumWindow(IntPtr hwnd, IntPtr data);
  public static IntPtr PlayerWindow(uint processId) {
    IntPtr selected = IntPtr.Zero; long area = 0;
    EnumWindows((hwnd, data) => {
      uint owner; GetWindowThreadProcessId(hwnd, out owner); RECT client;
      if (owner == processId && IsWindowVisible(hwnd) && GetClientRect(hwnd, out client)) {
        int width = client.Right - client.Left, height = client.Bottom - client.Top;
        // winit/IME can expose a visible 18x18 helper before the compositor
        // publishes the real player. Never let that transient stop the poll.
        if (width < 320 || height < 240) { return true; }
        long candidate = (long)width * height;
        if (candidate > area) { selected = hwnd; area = candidate; }
      }
      return true;
    }, IntPtr.Zero);
    return selected;
  }
  public static string Geometry(IntPtr hwnd) {
    RECT window, client; GetWindowRect(hwnd, out window); GetClientRect(hwnd, out client);
    POINT origin = new POINT(); ClientToScreen(hwnd, ref origin);
    return String.Format("window={0}x{1} client={2}x{3} dpi={4} clientOffset={5},{6}", window.Right-window.Left,
      window.Bottom-window.Top, client.Right-client.Left, client.Bottom-client.Top, GetDpiForWindow(hwnd), origin.X-window.Left, origin.Y-window.Top);
  }
  public static void ResizeClient(IntPtr hwnd, int width, int height) {
    RECT window, client; GetWindowRect(hwnd, out window); GetClientRect(hwnd, out client);
    if (!SetWindowPos(hwnd, IntPtr.Zero, 0, 0, width + window.Right-window.Left-client.Right+client.Left,
      height + window.Bottom-window.Top-client.Bottom+client.Top, 0x0004)) throw new Exception("Resize failed");
  }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[NativeWinCapture]::SetProcessDPIAware() | Out-Null
$proc = Get-Process -Id $ProcId -ErrorAction Stop
$hwnd = [NativeWinCapture]::PlayerWindow([uint32]$ProcId)
# Release players compile the full PBR pipeline before publishing their first
# window frame. Allow that real startup path to finish instead of treating a
# correctly hidden candidate as a missing window during a cold driver launch.
for ($attempt = 0; $hwnd -eq [IntPtr]::Zero -and $attempt -lt 150; $attempt++) {
  Start-Sleep -Milliseconds 200
  $hwnd = [NativeWinCapture]::PlayerWindow([uint32]$ProcId)
}
if ($hwnd -eq [IntPtr]::Zero) { throw "process $ProcId has no main window" }
if ([NativeWinCapture]::IsIconic($hwnd)) { [NativeWinCapture]::ShowWindow($hwnd, 9) | Out-Null; Start-Sleep -Milliseconds 800 }
if ($ClientWidth -gt 0 -and $ClientHeight -gt 0) { [NativeWinCapture]::ResizeClient($hwnd, $ClientWidth, $ClientHeight); Start-Sleep -Milliseconds 800 }
Write-Output ([NativeWinCapture]::Geometry($hwnd))
[NativeWinCapture]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 800
if($PreClicks -ne '') {
  foreach($point in $PreClicks.Split(';')) {
    $coordinates=$point.Split(',')
    [NativeWinCapture]::ClickClient($hwnd,[int]$coordinates[0],[int]$coordinates[1])
    Start-Sleep -Milliseconds 400
  }
}
if ($ClickX -ge 0 -and $ClickY -ge 0) {
  if (-not [NativeWinCapture]::SetWindowPos($hwnd,[IntPtr](-1),0,0,0,0,0x0003)) { throw 'Interactive player raise failed' }
  [NativeWinCapture]::SetForegroundWindow($hwnd)|Out-Null
  Start-Sleep -Milliseconds 100
  $screenPoint=New-Object NativeWinCapture+POINT
  $screenPoint.X=$ClickX;$screenPoint.Y=$ClickY
  [NativeWinCapture]::ClientToScreen($hwnd,[ref]$screenPoint)|Out-Null
  if (-not [NativeWinCapture]::SetCursorPos($screenPoint.X,$screenPoint.Y)) { throw 'Cursor move failed' }
  Start-Sleep -Milliseconds 200
  $actualPoint=New-Object NativeWinCapture+POINT
  [NativeWinCapture]::GetCursorPos([ref]$actualPoint)|Out-Null
  Write-Output "pointer requested=$($screenPoint.X),$($screenPoint.Y) actual=$($actualPoint.X),$($actualPoint.Y)"
  if ($HoverOnly -eq 0) { [NativeWinCapture]::ClickClient($hwnd,$ClickX,$ClickY) }
  Start-Sleep -Milliseconds 800
}
if ($ReportPath -ne '' -or $CancelReport -eq 1) {
  $dialog=[IntPtr]::Zero
  for($attempt=0;$attempt -lt 30 -and $dialog -eq [IntPtr]::Zero;$attempt++) {
    $dialog=[NativeWinCapture]::SaveDialog([uint32]$ProcId)
    if($dialog -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 100}
  }
  if($dialog -eq [IntPtr]::Zero){throw 'Real report save dialog did not open'}
  if($CancelReport -eq 1){[NativeWinCapture]::PostMessage($dialog,0x111,[IntPtr]2,[IntPtr]::Zero)|Out-Null}
  else {
    # 文件名框是线程焦点 EDIT 截图证实存在):取焦点 HWND 后 WM_SETTEXT 写路径,再 IDOK 确认;结果由调用方逐字节断言。
    $focus=$null
    for($attempt=0;$attempt -lt 30 -and -not $focus;$attempt++){
      [NativeWinCapture]::SetForegroundWindow($dialog)|Out-Null
      Start-Sleep -Milliseconds 150
      $focus=[NativeWinCapture]::DialogFocus($dialog)
      if(-not $focus -or $focus -eq [IntPtr]::Zero){$focus=$null;Start-Sleep -Milliseconds 100}
    }
    if(-not $focus){throw ('Report filename focus control missing; ' + [NativeWinCapture]::DialogDiagnostics([uint32]$ProcId))}
    [NativeWinCapture]::SendMessageText([IntPtr]$focus,[uint32]0x0C,[IntPtr]::Zero,[string]$ReportPath)|Out-Null
    Start-Sleep -Milliseconds 200
    [NativeWinCapture]::PostMessage($dialog,0x111,[IntPtr]1,[IntPtr]::Zero)|Out-Null
  }
  $finished=$false
  for($attempt=0;$attempt -lt 50 -and -not $finished;$attempt++){
    if([NativeWinCapture]::SaveDialog([uint32]$ProcId) -eq [IntPtr]::Zero){$finished=$true}
    else{Start-Sleep -Milliseconds 100}
  }
  if(-not $finished){
    [NativeWinCapture]::SetForegroundWindow($dialog)|Out-Null
    Start-Sleep -Milliseconds 200
    $shot=New-Object System.Drawing.Bitmap(760,520)
    $g=[System.Drawing.Graphics]::FromImage($shot)
    $dc=$g.GetHdc()
    [NativeWinCapture]::PrintWindow($dialog,$dc,2)|Out-Null
    $g.ReleaseHdc()
    $shot.Save((Join-Path (Split-Path -Parent $OutPath) 'save-dialog.png'),[System.Drawing.Imaging.ImageFormat]::Png)
    throw 'Report save dialog did not finish'
  }
}
if ($ArrowDown -eq 1) {
  [NativeWinCapture]::PostMessage($hwnd,0x100,[IntPtr]0x28,[IntPtr]0x1500001)|Out-Null
  [NativeWinCapture]::PostMessage($hwnd,0x101,[IntPtr]0x28,[IntPtr]0xC1500001)|Out-Null
  Start-Sleep -Milliseconds 800
}
$rect = New-Object NativeWinCapture+RECT
[NativeWinCapture]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$client = New-Object NativeWinCapture+RECT
[NativeWinCapture]::GetClientRect($hwnd, [ref]$client) | Out-Null
$dpi = [NativeWinCapture]::GetDpiForWindow($hwnd)
$w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { throw "empty window rect" }
if ($client.Right -le 0 -or $client.Bottom -le 0) { throw "empty player client rect" }
if ($ClientWidth -gt 0 -and ($client.Right -ne $ClientWidth -or $client.Bottom -ne $ClientHeight)) { throw "requested client size was not applied" }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$printed = [NativeWinCapture]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
function Measure-ContentColors($image) {
  $colors=New-Object 'System.Collections.Generic.HashSet[int]'
  for($y=80;$y -lt $image.Height-20;$y+=23){for($x=20;$x -lt $image.Width-20;$x+=23){[void]$colors.Add($image.GetPixel($x,$y).ToArgb())}}
  return $colors.Count
}
$contentColors=Measure-ContentColors $bmp
if (-not $printed -or $contentColors -lt $MinContentColors) {
  Start-Sleep -Milliseconds 800
  if([NativeWinCapture]::GetForegroundWindow() -ne $hwnd){$bmp.Dispose();throw 'Native window is not foreground; refusing unrelated screen capture'}
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
  $g2.Dispose()
  $contentColors=Measure-ContentColors $bmp
}
if($contentColors -lt $MinContentColors){$bmp.Dispose();throw 'Native client content was not visible in captured compositor pixels'}
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$title=New-Object System.Text.StringBuilder(512)
[NativeWinCapture]::GetWindowText($hwnd,$title,512)|Out-Null
$iconEvidence=@{title=$title.ToString();icons=@()}
foreach($entry in @(@{id=0;name='window'},@{id=1;name='taskbar'})) {
  $handle=[NativeWinCapture]::SendMessage($hwnd,0x7f,[IntPtr]$entry.id,[IntPtr]::Zero)
  if($handle -ne [IntPtr]::Zero) {
    $icon=[Drawing.Icon]::FromHandle($handle);$pixels=$icon.ToBitmap()
    $iconPath=$OutPath+'.'+$entry.name+'-icon.png'
    $pixels.Save($iconPath,[Drawing.Imaging.ImageFormat]::Png)
    $iconEvidence.icons+=@{kind=$entry.name;width=$pixels.Width;height=$pixels.Height;path=$iconPath}
    $pixels.Dispose()
  }
}
$iconEvidence|ConvertTo-Json -Depth 4|Set-Content -LiteralPath ($OutPath+'.brand.json') -Encoding UTF8
Write-Output "saved $OutPath $($w)x$($h) printed=$printed contentColors=$contentColors client=$($client.Right)x$($client.Bottom) dpi=$dpi"
`;

/**
 * 真实窗口截图：可见地启动本地播放器（PATH 仅 System32，证明无 Node/浏览器依赖），
 * 等待呈现检查点后用 PrintWindow 抓取实际窗口像素。失败抛错，不做静默回退。
 */
export async function captureNativePlayerWindow({ label, executable, args, env, outputDirectory, presentedMarker, timeoutMs = 30_000,
  clientSize = /** @type {number[] | undefined} */ (undefined), clientClick = /** @type {number[] | undefined} */ (undefined), hoverOnly = false, arrowDown = false,
  reportPath = undefined, cancelReport = false, preClicks = [] }) {
  const minimumContentColors = Number(process.env.DEEP_NATIVE_CAPTURE_MIN_COLORS ?? 8);
  if (!Number.isSafeInteger(minimumContentColors) || minimumContentColors < 2 || minimumContentColors > 256) throw new Error("Invalid native capture color threshold");
  if (preClicks.some(point => !clientSize || point.length !== 2 || point.some((value, index) => !Number.isSafeInteger(value) || value < 0 || value >= clientSize[index]))) throw new Error("Invalid preceding click");
  if (clientClick && (!clientSize || clientClick.length !== 2 || !clientClick.every((value, index) =>
    Number.isSafeInteger(value) && value >= 0 && value < clientSize[index]))) throw new Error("Invalid client click");
  if (clientSize && (clientSize.length !== 2 || !clientSize.every(value => Number.isSafeInteger(value) && value >= 480 && value <= 4096)))
    throw new Error("Invalid requested client size");
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
      "-ProcId", String(child.pid), "-OutPath", png,
      ...(clientSize ? ["-ClientWidth", String(clientSize[0]), "-ClientHeight", String(clientSize[1])] : []),
      ...(clientClick ? ["-ClickX", String(clientClick[0]), "-ClickY", String(clientClick[1])] : []),
      "-HoverOnly", hoverOnly ? "1" : "0", "-ArrowDown", arrowDown ? "1" : "0",
      ...(reportPath ? ["-ReportPath", reportPath] : []), "-CancelReport", cancelReport ? "1" : "0",
      "-MinContentColors", String(minimumContentColors),
      ...(preClicks.length ? ["-PreClicks", preClicks.map(point => point.join(",")).join(";")] : [])], { windowsHide: true, encoding: "utf8" });
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
      captureLog: captureOutput.trim(), playerLogHead: log.slice(0, 2_000),
      ...(clientClick ? { clientClick, playerLogTail: log.slice(-4_000) } : {}) };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
