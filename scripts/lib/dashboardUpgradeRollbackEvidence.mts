import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const PIXEL_REGIONS_PS1 = `param([string]$PngPath,[string]$OutDir)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap($PngPath)
$w = $bmp.Width; $h = $bmp.Height
$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($data); $bmp.Dispose()
[IO.File]::WriteAllBytes((Join-Path $OutDir "full.bgra"), $bytes)
$regions = Get-Content (Join-Path $OutDir "regions.json") -Raw | ConvertFrom-Json
$out = @()
foreach ($r in $regions) {
  $x0 = [int][math]::Floor($r.x0 * $w); $x1 = [int][math]::Ceiling($r.x1 * $w)
  $y0 = [int][math]::Floor($r.y0 * $h); $y1 = [int][math]::Ceiling($r.y1 * $h)
  $rw = $x1 - $x0; $rh = $y1 - $y0
  $buf = New-Object byte[] ($rw * $rh * 4)
  for ($y = 0; $y -lt $rh; $y++) {
    $src = ($y0 + $y) * $data.Stride + $x0 * 4
    [Array]::Copy($bytes, $src, $buf, $y * $rw * 4, $rw * 4)
  }
  [IO.File]::WriteAllBytes((Join-Path $OutDir ($r.name + ".bgra")), $buf)
  $out += @{ name = $r.name; width = $rw; height = $rh }
}
$out | ConvertTo-Json -Compress | Set-Content (Join-Path $OutDir "regions-out.json")
Write-Output "regions ok \${w}x\${h}"
`;

export interface CheckpointState {
  key: string;
  active: { version: number; source: string; hash: string };
  files: Record<string, string>;
}

export async function checkpointState(localAppData: string, sourcePath: string): Promise<CheckpointState> {
  const root = path.join(localAppData, "DeepEngineNative", "package-recovery");
  const wanted = path.resolve(sourcePath).toLowerCase();
  for (const entry of await readdir(root)) {
    const directory = path.join(root, entry);
    const active = JSON.parse(await readFile(path.join(directory, "active.json"), "utf8"));
    if (active.source !== wanted) continue;
    const files: Record<string, string> = {};
    for (const file of (await readdir(directory)).sort()) {
      files[file] = sha(await readFile(path.join(directory, file)));
    }
    return { key: directory, active, files };
  }
  throw new Error(`checkpoint not found for ${wanted}`);
}

const PIXEL_REGIONS = [
  { name: "banner", x0: 0.04, y0: 0.10, x1: 0.96, y1: 0.22 },
  { name: "kpi", x0: 0.03, y0: 0.26, x1: 0.24, y1: 0.46 },
  { name: "center", x0: 0.35, y0: 0.40, x1: 0.75, y1: 0.75 },
  { name: "bottom", x0: 0.04, y0: 0.84, x1: 0.96, y1: 0.98 },
];

export interface PixelDigest {
  width: number;
  height: number;
  full: string;
  regions: Record<string, { sha256: string; rgb: readonly [number, number, number] }>;
}

export async function pixelDigest(png: string, workDirectory: string): Promise<PixelDigest> {
  await rm(workDirectory, { recursive: true, force: true });
  await mkdir(workDirectory, { recursive: true });
  await writeFile(path.join(workDirectory, "regions.json"), JSON.stringify(PIXEL_REGIONS));
  const ps1 = path.join(workDirectory, "regions.ps1");
  await writeFile(ps1, PIXEL_REGIONS_PS1, "utf8");
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1,
    "-PngPath", png, "-OutDir", workDirectory], { windowsHide: true });
  let output = "";
  child.stdout.on("data", bytes => { output += String(bytes); });
  child.stderr.on("data", bytes => { output += String(bytes); });
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pixel digest timeout: ${output}`)), 30_000);
    child.once("error", reject);
    child.once("close", value => { clearTimeout(timer); resolve(value ?? -1); });
  });
  assert.equal(code, 0, `pixel digest failed for ${png}: ${output}`);
  const regionMeta = JSON.parse(await readFile(path.join(workDirectory, "regions-out.json"), "utf8")) as
    Readonly<{ name: string; width: number; height: number }>[];
  const full = await readFile(path.join(workDirectory, "full.bgra"));
  const regions: PixelDigest["regions"] = {};
  for (const meta of regionMeta) {
    const bytes = await readFile(path.join(workDirectory, `${meta.name}.bgra`));
    let blue = 0, green = 0, red = 0;
    const pixels = bytes.byteLength / 4;
    for (let index = 0; index < bytes.byteLength; index += 4) {
      blue += bytes[index]!; green += bytes[index + 1]!; red += bytes[index + 2]!;
    }
    regions[meta.name] = { sha256: sha(bytes),
      rgb: [Math.round(red / pixels), Math.round(green / pixels), Math.round(blue / pixels)] };
  }
  await rm(workDirectory, { recursive: true, force: true });
  return { width: Number(/regions ok (\d+)x/.exec(output)?.[1] ?? 0),
    height: Number(/regions ok \d+x(\d+)/.exec(output)?.[1] ?? 0), full: sha(full), regions };
}

export function assertRegionsIdentical(left: PixelDigest, right: PixelDigest, context: string) {
  assert.equal(left.full, right.full, `${context}: full-window digest must match`);
  for (const name of Object.keys(left.regions)) {
    assert.equal(left.regions[name]!.sha256, right.regions[name]!.sha256, `${context}: region ${name} digest must match`);
  }
}

export function regionDelta(left: PixelDigest, right: PixelDigest, name: string) {
  return (Math.abs(left.regions[name]!.rgb[0] - right.regions[name]!.rgb[0])
    + Math.abs(left.regions[name]!.rgb[1] - right.regions[name]!.rgb[1])
    + Math.abs(left.regions[name]!.rgb[2] - right.regions[name]!.rgb[2])) / 3;
}

export async function hashInventory(directory: string) {
  const entries: Array<{ file: string; sha256: string; bytes: number }> = [];
  async function walk(current: string) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) { await walk(full); continue; }
      const bytes = await readFile(full);
      entries.push({ file: path.relative(directory, full).replaceAll("\\", "/"), sha256: sha(bytes), bytes: bytes.byteLength });
    }
  }
  await walk(directory);
  return entries.sort((left, right) => left.file.localeCompare(right.file));
}

/** Atomically replace a downloaded artifact after any previous player handle is released. */
export async function atomicReplace(target: string, bytes: Uint8Array) {
  const temporary = `${target}.download-${process.pid}`;
  await writeFile(temporary, bytes);
  for (let attempt = 0;; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      if (attempt >= 20 || !(error as NodeJS.ErrnoException).code?.startsWith("EPERM")) throw error;
      await sleep(250);
    }
  }
}
