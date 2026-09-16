import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { createDashboardOfflineNativeLaunchPlan } from "./dashboardOfflineNativeLauncher.js";
import { readDashboardWindowsExecutable } from "./dashboardWindowsExecutable.js";

const executableName = "deep-native-player.exe";
const packageName = "runtime-package.json";
const launcherName = "Start-Dashboard.ps1";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** 打包显式选择的本机 EXE；验证窗口和正式发布仍由调用方负责。 */
export async function createDashboardPortableZip(
  archiveBytes: Uint8Array,
  nativeExecutable: string,
  options: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const plan = createDashboardOfflineNativeLaunchPlan(archiveBytes);
  const executable = await readDashboardWindowsExecutable(nativeExecutable, options.signal);
  const files = new Map<string, Uint8Array | string>([
    [packageName, plan.artifact], [executableName, executable],
    ["LICENSE", await readFile(new URL("../../../LICENSE", import.meta.url))],
    ["THIRD_PARTY_NOTICES.md", await readFile(new URL("../../../THIRD_PARTY_NOTICES.md", import.meta.url))],
    ["README.txt", "Deep Monkey Dashboard Windows portable package\r\n\r\nExtract all files into one local directory.\r\nRun: powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\Start-Dashboard.ps1\r\nNo Node.js installation is required. Extra arguments are rejected.\r\nThe launcher checks SHA-256 before starting the bundled player.\r\nHashes detect changed files; they are not a publisher signature.\r\nThis archive does not prove formal publication or full window acceptance.\r\nProject source-available license and third-party notices are included.\r\n"],
  ]);
  const payloadHashes = Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)]));
  files.set(launcherName, portableLauncher(payloadHashes));
  const manifest = {
    schema: "deep-engine.dashboard-portable-windows", schemaVersion: 1,
    authority: plan.authority, archiveManifestSha256: plan.archiveManifestSha256,
    runtimePackageSha256: plan.runtimePackageSha256, artifactSha256: plan.targetArtifactHash,
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)])),
  };
  files.set("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  const zip = new JSZip();
  // 固定 ZIP 时间与顺序，避免相同输入产生不同传输字节。
  for (const [name, bytes] of files) zip.file(name, bytes, { date: new Date("2000-01-01T00:00:00Z"), createFolders: false });
  options.signal?.throwIfAborted();
  const result = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" }, () => options.signal?.throwIfAborted());
  options.signal?.throwIfAborted();
  return result;
}

function portableLauncher(hashes: Record<string, string>): string {
  return `# Deep Monkey Dashboard portable launcher\r
$ErrorActionPreference = 'Stop'
try {
  if ($args.Count -ne 0) { throw 'Dashboard launcher accepts no arguments' }
  $expected = '${JSON.stringify(hashes)}' | ConvertFrom-Json
  $manifestPath = Join-Path $PSScriptRoot 'manifest.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.schema -cne 'deep-engine.dashboard-portable-windows' -or $manifest.schemaVersion -ne 1) { throw 'Invalid portable manifest' }
  $names = @($expected.PSObject.Properties.Name) + '${launcherName}'
  if (@($manifest.files.PSObject.Properties).Count -ne $names.Count) { throw 'Invalid manifest file set' }
  foreach ($name in $names) {
    $record = $manifest.files.PSObject.Properties[$name]
    if ($null -eq $record -or $record.Value -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid manifest hash' }
    $expectedRecord = $expected.PSObject.Properties[$name]
    if ($null -ne $expectedRecord -and $record.Value -cne $expectedRecord.Value) { throw 'Manifest payload hash changed' }
    $file = Join-Path $PSScriptRoot $name
    if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked payload rejected' }
    $stream = [IO.File]::OpenRead($file)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
    if ($actual -cne $record.Value) { throw ('File hash mismatch: ' + $name) }
  }
  if ($manifest.artifactSha256 -cne $expected.'${packageName}') { throw 'Artifact hash mismatch' }
  $player = Join-Path $PSScriptRoot '${executableName}'
  $package = Join-Path $PSScriptRoot '${packageName}'
  & $player '--package' $package
  if ($LASTEXITCODE -ne 0) { throw ('Native player exited: ' + $LASTEXITCODE) }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`.replace(/\r?\n/g, "\r\n");
}
