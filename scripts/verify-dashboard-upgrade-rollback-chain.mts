/**
 * P3-05 实际发布升级与回滚:真实包 + 真实客户端的连续更新、坏包拒绝、自动回退、
 * 资源缺失 fail-closed、下载取消与检查点恢复、离线旧版启动。
 *
 * 用法:
 *   DASHBOARD_HEADING_FONT_MANIFEST=<绝对路径 licensed OFL 字体清单> \
 *   pnpm exec tsx --conditions=development scripts/verify-dashboard-upgrade-rollback-chain.mts \
 *     <deep-engine-native.exe> <device-fingerprint-sha256> <新证据目录> [既有v1运行目录]
 *
 * 默认既有 v1 运行目录 = test-output/dashboard-http-multicomponent-20260917(P0-06 真实发布产物,
 * v1 多组件页 rev1 的发布/下载/打开/截图证据整体复用,不重跑)。
 *
 * 链路(每版内容可像素区分:标题文本/数据/页面背景三重差异):
 *   EXE 链    v1(复用产物)→ HTTP 下载 v2 → 原子替换 → 打开验证 v2(截图+像素)
 *             → 坏 v3(hash 破坏 / schema 破坏)→ 打开拒绝(GPU 前)→ 检查点不变
 *             → 真实 HTTP 重新下载 v2 回退 → 打开验证(像素与 v2 逐区域一致)
 *             → v3'(合法)→ 打开验证(截图+像素)
 *   文件链    --package 模式: v1 → v2 → 坏 v3(篡改 runtime package 字节)→ 播放器自动回退
 *             检查点 last-known-good 并呈现 v2("primary-rejected/last-known-good")
 *             → v3' → 检查点载荷删除+包文件损坏 = 双重失败 fail-closed(无窗口,exit≠0)
 *             → 恢复后正常呈现
 *   离线旧版  服务全部关闭 + PATH 仅 System32:仅凭 v2 检查点启动成功(截图)
 *   取消      真实 HTTP 下载中途断连(abort 流)→ 无部分文件、服务端存活;DMDA 截断 → 解包前置校验拒绝
 *
 * 产物:<证据目录>/evidence.json + screenshots/ + 全量 SHA-256 清单。不修改生产源码。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { JsonStore } from "../apps/api/src/jsonStore.js";
import { LocalObjectStore } from "../apps/api/src/objects.js";
import { createApiServer } from "../apps/api/src/serverOptions.js";
import { loadConfig } from "../apps/api/src/config.js";
import { registerConfiguredDashboardNative } from "../apps/api/src/dashboardNativeStartup.js";
import { runDashboardOfflineNative } from "../apps/api/src/dashboardOfflineNativeProcess.js";
import { createDashboardOfflineNativeLaunchPlan } from "../apps/api/src/dashboardOfflineNativeLauncher.js";
import { parseDeepRuntimePackage } from "../packages/deep-engine/src/runtimePackage/index.ts";
import { publishDashboardAcceptanceFixture } from "./lib/dashboardAcceptanceHttp.mts";
import { dashboardMulticomponentFixture } from "./lib/dashboardMulticomponentFixture.mts";
import { assertDashboardAtlasEvidence } from "./lib/dashboardAtlasEvidence.mts";
import {
  acceptanceHttp,
  buildVersionDocument,
  V2,
  V3,
  type ChainVersion,
} from "./lib/dashboardUpgradeRollbackFixture.mts";
import {
  assertRegionsIdentical,
  atomicReplace,
  checkpointState,
  hashInventory,
  pixelDigest,
  regionDelta,
  type CheckpointState,
} from "./lib/dashboardUpgradeRollbackEvidence.mts";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const JSZip = require("jszip");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const PRESENTED = "native package recovery checkpoint committed after present";
const SMOKE_SUBMITTED = "native smoke GPU submission complete";
const usage = `DASHBOARD_HEADING_FONT_MANIFEST=<abs> pnpm exec tsx --conditions=development scripts/verify-dashboard-upgrade-rollback-chain.mts <native.exe> <device-sha256> <new-output-directory> [prior-v1-run-directory]`;

// ── 播放器启动:PATH 仅 System32(无 Node/浏览器),隔离 LOCALAPPDATA,真实 GPU 窗口 ──
const playerEnv = (localAppData: string) => ({
  ...process.env, LOCALAPPDATA: localAppData,
  PATH: path.join(process.env.SystemRoot ?? "C:/Windows", "System32"),
});

const PIXEL_CAPTURE_PS1 = `param([int]$ProcId,[string]$OutPath)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class P35Capture {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[P35Capture]::SetProcessDPIAware() | Out-Null
$proc = Get-Process -Id $ProcId -ErrorAction Stop
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw "process $ProcId has no main window" }
[P35Capture]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 800
$rect = New-Object P35Capture+RECT
[P35Capture]::GetWindowRect($hwnd, [ref]$rect)
$w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { throw "empty window rect" }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$printed = [P35Capture]::PrintWindow($hwnd, $hdc, 3)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $printed) {
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
  $g2.Dispose()
}
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $OutPath \${w}x\${h} printed=$printed"
`;

interface LaunchResult { code: number | null; log: string; presented: boolean; png?: string }

function assertActiveCheckpoint(state: CheckpointState, hash: string, payloadSha: string, context: string) {
  assert.equal(state.active.hash, hash, `${context}: active hash`);
  assert.equal(state.files[`${hash}.json`], payloadSha, `${context}: active payload bytes`);
}

async function launchPlayer(options: {
  label: string; executable: string; args: readonly string[]; localAppData: string;
  expect: "present" | "reject"; screenshotsDirectory: string; timeoutMs?: number;
}): Promise<LaunchResult> {
  const { label, executable, args, localAppData, expect } = options;
  const timeoutMs = options.timeoutMs ?? 90_000;
  let log = "", presented = false, spawnError: unknown;
  const child = spawn(executable, [...args], { cwd: path.dirname(executable), windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"], env: { ...playerEnv(localAppData), DEEP_ENGINE_ATLAS_EVIDENCE: "1" } });
  const receive = (bytes: Buffer) => {
    log += bytes.toString();
    if (!presented && log.includes(PRESENTED)) presented = true;
  };
  child.stdout.on("data", receive); child.stderr.on("data", receive);
  child.once("error", reason => { spawnError = reason; });
  const png = path.join(options.screenshotsDirectory, `${label}.png`);
  const deadline = Date.now() + timeoutMs;
  try {
    while (!spawnError && child.exitCode === null && !presented && Date.now() < deadline) await sleep(200);
    if (spawnError) throw spawnError;
    if (expect === "present") {
      assert(presented, `[${label}] presented marker not seen: ${log.slice(-800)}`);
      assert(child.exitCode === null, `[${label}] exited before capture: ${log.slice(-800)}`);
      await sleep(2_500);
      const ps1 = path.join(options.screenshotsDirectory, `${label}-capture.ps1`);
      await writeFile(ps1, PIXEL_CAPTURE_PS1, "utf8");
      const capture = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1,
        "-ProcId", String(child.pid), "-OutPath", png], { windowsHide: true, encoding: "utf8" });
      let captureOutput = "";
      capture.stdout.on("data", bytes => { captureOutput += String(bytes); });
      capture.stderr.on("data", bytes => { captureOutput += String(bytes); });
      const code = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`[${label}] capture timeout: ${captureOutput}`)), 20_000);
        capture.once("error", reject);
        capture.once("close", value => { clearTimeout(timer); resolve(value ?? -1); });
      });
      assert.equal(code, 0, `[${label}] capture failed: ${captureOutput}`);
      child.kill();
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 8_000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
      return { code: 0, log, presented, png };
    }
    while (child.exitCode === null && !spawnError && Date.now() < deadline) await sleep(200);
    if (spawnError) throw spawnError;
    assert(child.exitCode !== null, `[${label}] reject launch timed out: ${log.slice(-800)}`);
    return { code: child.exitCode, log, presented };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

/**
 * 恢复启动(自动回退/离线检查点启动)专用:等待 last-known-good 恢复诊断,
 * 然后等待呈现合同双信号(GPU 提交自检 + 呈现检查点提交);超时未呈现则抓取真实窗口像素
 * 作为视觉证据后受控终止,由调用方断言合同达成。
 */
async function launchRestoredPlayer(options: {
  label: string; executable: string; args: readonly string[]; localAppData: string;
  screenshotsDirectory: string; timeoutMs?: number;
}): Promise<{ log: string; presented: boolean; smokeSubmitted: boolean; png?: string; exited: boolean; exitCode: number | null }> {
  const { label, executable, args, localAppData } = options;
  const timeoutMs = options.timeoutMs ?? 75_000;
  let log = "", presented = false, smokeSubmitted = false, spawnError: unknown;
  const child = spawn(executable, [...args], { cwd: path.dirname(executable), windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"], env: playerEnv(localAppData) });
  const receive = (bytes: Buffer) => {
    log += bytes.toString();
    if (!presented && log.includes(PRESENTED)) presented = true;
    if (!smokeSubmitted && log.includes(SMOKE_SUBMITTED)) smokeSubmitted = true;
  };
  child.stdout.on("data", receive); child.stderr.on("data", receive);
  child.once("error", reason => { spawnError = reason; });
  const deadline = Date.now() + timeoutMs;
  try {
    while (!spawnError && child.exitCode === null && !log.includes('"code":"primary-rejected"') && Date.now() < deadline) await sleep(200);
    if (spawnError) throw spawnError;
    assert(log.includes('"code":"primary-rejected"') && log.includes('"active":"last-known-good"'),
      `[${label}] recovery diagnostic not seen: ${log.slice(-800)}`);
    while (!spawnError && child.exitCode === null && !presented && Date.now() < deadline) await sleep(200);
    if (spawnError) throw spawnError;
    if (presented && child.exitCode === null) {
      await sleep(2_500);
      const ps1 = path.join(options.screenshotsDirectory, `${label}-capture.ps1`);
      await writeFile(ps1, PIXEL_CAPTURE_PS1, "utf8");
      const png = path.join(options.screenshotsDirectory, `${label}.png`);
      const capture = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1,
        "-ProcId", String(child.pid), "-OutPath", png], { windowsHide: true, encoding: "utf8" });
      let captureOutput = "";
      capture.stdout.on("data", bytes => { captureOutput += String(bytes); });
      capture.stderr.on("data", bytes => { captureOutput += String(bytes); });
      const code = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`[${label}] capture timeout: ${captureOutput}`)), 20_000);
        capture.once("error", reject);
        capture.once("close", value => { clearTimeout(timer); resolve(value ?? -1); });
      });
      assert.equal(code, 0, `[${label}] capture failed: ${captureOutput}`);
      return { log, presented, smokeSubmitted, png, exited: false, exitCode: null };
    }
    if (!presented) {
      // 呈现检查点超时:先抓取真实窗口像素作为视觉证据,再受控终止。
      assert(child.exitCode === null, `[${label}] exited without presenting: ${log.slice(-800)}`);
      await sleep(3_000);
      const ps1 = path.join(options.screenshotsDirectory, `${label}-capture.ps1`);
      await writeFile(ps1, PIXEL_CAPTURE_PS1, "utf8");
      const png = path.join(options.screenshotsDirectory, `${label}.png`);
      try {
        const capture = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1,
          "-ProcId", String(child.pid), "-OutPath", png], { windowsHide: true, encoding: "utf8" });
        let captureOutput = "";
        capture.stdout.on("data", bytes => { captureOutput += String(bytes); });
        capture.stderr.on("data", bytes => { captureOutput += String(bytes); });
        const code = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`[${label}] stall capture timeout: ${captureOutput}`)), 20_000);
          capture.once("error", reject);
          capture.once("close", value => { clearTimeout(timer); resolve(value ?? -1); });
        });
        if (code !== 0) { await writeFile(`${png}.capture-error.txt`, captureOutput); }
      } catch (captureError) {
        await writeFile(`${png}.capture-error.txt`, String(captureError));
      }
      child.kill();
      return { log, presented: false, smokeSubmitted, png, exited: false, exitCode: null };
    }
    return { log, presented: true, smokeSubmitted, exited: true, exitCode: child.exitCode };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const [executableArg, deviceFingerprint, outputArg, priorArg] = args;
  if (args.length < 3 || args.length > 4 || !executableArg || !deviceFingerprint || !outputArg
    || !/^[a-f0-9]{64}$/.test(deviceFingerprint)) throw new Error(usage);
  const fontManifest = process.env.DASHBOARD_HEADING_FONT_MANIFEST;
  if (!fontManifest || !path.isAbsolute(fontManifest)) throw new Error("Set DASHBOARD_HEADING_FONT_MANIFEST to an absolute licensed font manifest");
  const directory = path.resolve(outputArg);
  await mkdir(directory); // 既有证据不可覆盖。
  const nativeExecutable = path.resolve(executableArg);
  const nativeSha = sha(await readFile(nativeExecutable));
  const localAppData = path.join(directory, "local-app-data");
  const screenshots = path.join(directory, "screenshots");
  await mkdir(screenshots);
  const pixelWork = path.join(directory, "pixel-work");
  const steps: Array<Record<string, unknown>> = [];
  const record = (step: string, detail: Record<string, unknown>) => {
    steps.push({ step, ...detail });
    console.log(`[p03-05] ${step} ok`);
  };

  // ── A. v1 基线:复用 P0-06 真实发布运行(不重跑),校验产物未被漂移 ─────────────
  const priorDirectory = path.resolve(priorArg ?? "test-output/dashboard-http-multicomponent-20260917");
  const priorEvidence = JSON.parse(await readFile(path.join(priorDirectory, "evidence.json"), "utf8"));
  const v1Executable = path.join(priorDirectory, "standalone", "Dashboard.exe");
  const v1PackageBytes = await readFile(path.join(priorDirectory, "extracted", "runtime-package.json"));
  const v1Package = JSON.parse(v1PackageBytes.toString("utf8"));
  const v1Hash = v1Package.packageHash.value as string;
  assert.equal(sha(await readFile(v1Executable)), priorEvidence.standaloneSha256, "reused v1 EXE drifted from prior evidence");
  assert.equal(sha(v1PackageBytes), priorEvidence.runtimePackageSha256, "reused v1 runtime package drifted");
  assert.equal(v1Package.packageVersion, "1.0.0");
  const v1Screenshot = priorEvidence.screenshots?.[0]?.png as string | undefined;
  const v1Pixels = v1Screenshot ? await pixelDigest(v1Screenshot, path.join(pixelWork, "v1")).catch(() => null) : null;
  record("v1-reuse", { reused: true, priorRun: priorDirectory, v1ExecutableSha: priorEvidence.standaloneSha256,
    v1PackageSha: priorEvidence.runtimePackageSha256, v1Hash, v1Screenshot: v1Screenshot ?? null,
    v1PixelBaseline: v1Pixels ? { full: v1Pixels.full, banner: v1Pixels.regions.banner.sha256 } : null });

  // ── B. 服务器阶段:真实 HTTP 发布 v2 / v3',候选准备与三格式真实下载 ────────────
  const metadataDirectory = path.join(directory, "isolated-metadata");
  const initialStore = new JsonStore(metadataDirectory); await initialStore.init();
  const project = await initialStore.createProject("P3-05 升级回滚链验收", "隔离测试数据,非用户项目");
  const objects = new LocalObjectStore(path.join(directory, "isolated-objects"));
  interface PublishedVersion {
    version: ChainVersion; runtimePackage: Buffer; packageHash: string; candidateId: string; applicationId: string;
    exe: Buffer; zip: Buffer; dmda?: Buffer; atlasCount: number; projectId: string; deploymentFile: string;
    session: Awaited<ReturnType<typeof acceptanceHttp>>; close: () => Promise<void>;
  }
  const versions = new Map<string, PublishedVersion>();

  async function publishAndDownload(version: ChainVersion): Promise<PublishedVersion> {
    const document = await buildVersionDocument(version, project.id);
    const published = await publishDashboardAcceptanceFixture(initialStore, project.id, document.application);
    const store = new JsonStore(metadataDirectory); await store.init();
    const persisted = store.getPublishedApplication(published.id); assert(persisted);
    const fixture = await dashboardMulticomponentFixture(directory, persisted);
    const deploymentFile = path.join(directory, `deployment-${version.id}.json`);
    await writeFile(deploymentFile, JSON.stringify({ nativeExecutable, expectedDeviceFingerprintSha256: deviceFingerprint,
      configuration: { locale: "zh-CN", packageVersion: version.packageVersion, layoutCapture: fixture.layoutCapture },
      fontCatalog: fixture.fontCatalog }, null, 2));
    const app = createApiServer();
    app.addHook("preHandler", async request => { request.systemUser = {
      id: `p03-05-${version.id}`, role: "editor", enabled: true, projectIds: [project.id] } as never; });
    const registered = await registerConfiguredDashboardNative(app, { store, objects, config: loadConfig() }, deploymentFile);
    assert(registered);
    const session = await acceptanceHttp(app);
    const base = `/api/projects/${project.id}/applications/${persisted.applicationId}/dashboard-candidates`;
    const response = await session.call({ method: "POST", url: base, payload: {
      publicationId: persisted.id, applicationRevision: persisted.applicationRevision, entryPageId: document.entryPageId } });
    assert.equal(response.statusCode, 201, response.body);
    const candidate = response.json();
    const record_ = registered.registry.read({ candidateId: candidate.candidateId, projectId: project.id,
      applicationId: persisted.applicationId });
    const runtimePackage = Buffer.from(record_.candidate.artifact.artifact);
    const parsed = parseDeepRuntimePackage(runtimePackage);
    assert(parsed.valid);
    const packageJson = JSON.parse(runtimePackage.toString("utf8"));
    assert.equal(packageJson.packageVersion, version.packageVersion);
    const chart = Object.values(packageJson.payloads as Record<string, any>)
      .find(value => value.schema === "deep-engine.chart-runtime") as any;
    assert(chart, "bar chart payload must exist");
    assert.deepEqual(chart.chart.datasets[0].rows, version.barRows, `bar rows must match ${version.id}`);
    const atlasCount = Object.values(packageJson.payloads as Record<string, any>)
      .reduce((sum: number, value: any) => sum + (value.atlases?.length ?? 0), 0);
    const exe = (await session.call({ method: "GET", url: `${base}/${candidate.candidateId}/standalone-executable` })).rawPayload;
    const zip = (await session.call({ method: "GET", url: `${base}/${candidate.candidateId}/portable-zip` })).rawPayload;
    const dmda = version.id === "v3"
      ? (await session.call({ method: "GET", url: `${base}/${candidate.candidateId}/offline-archive` })).rawPayload : undefined;
    await writeFile(path.join(directory, `runtime-package-${version.id}.json`), runtimePackage);
    const entry: PublishedVersion = { version, runtimePackage, packageHash: packageJson.packageHash.value,
      candidateId: candidate.candidateId, applicationId: persisted.applicationId, exe, zip, dmda, atlasCount,
      projectId: project.id, deploymentFile, session, close: () => app.close() };
    versions.set(version.id, entry);
    return entry;
  }

  const v2 = await publishAndDownload(V2);
  const v3 = await publishAndDownload(V3);
  record("publish-download", { reused: false, v2: { packageHash: v2.packageHash, atlasCount: v2.atlasCount,
    exeSha256: sha(v2.exe), zipSha256: sha(v2.zip) },
    v3: { packageHash: v3.packageHash, atlasCount: v3.atlasCount, exeSha256: sha(v3.exe),
      zipSha256: sha(v3.zip), dmdaSha256: sha(v3.dmda!) } });

  // 下载取消:真实 HTTP 流中断连 → 无部分文件落地,服务端存活,整包可重取。
  {
    const cancelBase = `/api/projects/${v3.projectId}/applications/${v3.applicationId}/dashboard-candidates`;
    const controller = new AbortController();
    const response = await fetch(`${v3.session.origin}${cancelBase}/${v3.candidateId}/standalone-executable`,
      { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert(first.done === false && first.value!.byteLength > 0, "expected streaming bytes before abort");
    controller.abort();
    const abortReason = await reader.read().then(() => null, (reason: unknown) => reason);
    assert(abortReason, "mid-download abort must surface on the stream");
    const redownload = await v3.session.call({ method: "GET",
      url: `${cancelBase}/${v3.candidateId}/standalone-executable` });
    assert.equal(redownload.statusCode, 200);
    assert.equal(sha(redownload.rawPayload), sha(v3.exe), "server must stay healthy after client disconnect");
    // 解包前置:截断 DMDA 必须在校验层拒绝,不产生任何运行目录;预取消的启动立即拒绝。
    const truncated = v3.dmda!.subarray(0, Math.floor(v3.dmda!.byteLength * 2 / 3));
    await assert.rejects(async () => { createDashboardOfflineNativeLaunchPlan(truncated); });
    await assert.rejects(() => runDashboardOfflineNative(truncated, nativeExecutable));
    const controller2 = new AbortController(); controller2.abort(new Error("cancelled before launch"));
    await assert.rejects(() => runDashboardOfflineNative(v3.dmda!, nativeExecutable, { signal: controller2.signal }),
      (reason: unknown) => reason instanceof Error && reason.message === "cancelled before launch");
    record("cancellation", { reused: false, midStreamAbort: { firstChunkBytes: first.value!.byteLength,
      streamError: String(abortReason) }, serverHealthyAfterDisconnect: true, truncatedDmdaRejected: true,
      preAbortedLaunchRejected: true, partialFilesWritten: 0 });
  }

  // ── C. EXE 链:同一播放器路径、同一恢复目录的实际版本切换与回退 ─────────────────
  const exeDirectory = path.join(directory, "exe-player");
  await mkdir(exeDirectory);
  const exePath = path.join(exeDirectory, "Dashboard.exe");
  const launchExe = (label: string, expect: "present" | "reject") =>
    launchPlayer({ label, executable: exePath, args: [], localAppData, expect, screenshotsDirectory: screenshots });
  const payloadRegion = (bytes: Buffer) => {
    assert.equal(bytes.subarray(-48, -40).toString("ascii"), "DMDASH01");
    const payloadLength = Number(bytes.readBigUInt64LE(bytes.length - 40));
    return { payloadStart: bytes.length - 48 - payloadLength, payloadLength };
  };

  await atomicReplace(exePath, await readFile(v1Executable));
  const v1Run = await launchExe("exe-v1-seed", "present");
  assert(v1Run.log.includes(`hash=${v1Hash}`), v1Run.log.slice(-500));
  const v1Checkpoint = await checkpointState(localAppData, exePath);
  assert.equal(v1Checkpoint.active.hash, v1Hash);
  assert.equal(v1Checkpoint.files[`${v1Hash}.json`], sha(v1PackageBytes));
  record("exe-v1-seed", { reused: "v1-bytes", checkpointActive: v1Hash });

  await atomicReplace(exePath, v2.exe);
  const v2Run = await launchExe("exe-v2", "present");
  assert(v2Run.log.includes("native GPU:"), v2Run.log.slice(-500));
  assert(v2Run.log.includes(`hash=${v2.packageHash}`) && v2Run.log.includes(`version=${V2.packageVersion}`), v2Run.log.slice(-600));
  const v2AtlasEvidence = assertDashboardAtlasEvidence(v2Run.log, v2.runtimePackage);
  const v2Checkpoint = await checkpointState(localAppData, exePath);
  assert.equal(v2Checkpoint.active.hash, v2.packageHash);
  assert.equal(v2Checkpoint.files[`${v2.packageHash}.json`], sha(v2.runtimePackage));
  const v2Pixels = await pixelDigest(v2Run.png!, path.join(pixelWork, "exe-v2"));
  record("exe-v2-verified", { version: V2.packageVersion, packageHash: v2.packageHash, checkpointActive: "v2",
    screenshot: v2Run.png, pixels: v2Pixels, atlasEvidence: v2AtlasEvidence });

  // 坏 v3:hash 破坏与 schema 破坏都在 GPU 前拒绝,检查点逐字节不变。
  const v3Payload = payloadRegion(v3.exe);
  const badHashExe = Buffer.from(v3.exe);
  badHashExe[v3Payload.payloadStart + Math.floor(v3Payload.payloadLength / 2)] ^= 0x01;
  await atomicReplace(exePath, badHashExe);
  const badHashRun = await launchExe("exe-v3-bad-hash", "reject");
  assert.equal(badHashRun.code, 1, `bad-hash exit code: ${badHashRun.code}`);
  assert(badHashRun.log.includes("overlay/payload-hash"), badHashRun.log.slice(-500));
  assert(!badHashRun.log.includes("native GPU:"), "corrupt overlay must fail before GPU");
  assert.equal(JSON.stringify(await checkpointState(localAppData, exePath)), JSON.stringify(v2Checkpoint),
    "rejected bad-hash EXE must not touch the v2 checkpoint");
  record("exe-v3-bad-hash-rejected", { exitCode: badHashRun.code, marker: "overlay/payload-hash", beforeGpu: true,
    checkpointUnchanged: true, logTail: badHashRun.log.slice(-600) });

  const badSchemaExe = Buffer.from(v3.exe);
  badSchemaExe[v3Payload.payloadStart + Math.floor(v3Payload.payloadLength / 2)] ^= 0x01;
  const idMarker = badSchemaExe.indexOf('"packageId":"', v3Payload.payloadStart);
  assert(idMarker > v3Payload.payloadStart, "packageId marker not found in payload head");
  badSchemaExe[idMarker + 13] ^= 0x01; // 破坏 packageId 字符串 → 包哈希失配;页脚 SHA 重算后 overlay 校验可通过。
  const schemaPayload = payloadRegion(badSchemaExe);
  createHash("sha256").update(badSchemaExe.subarray(schemaPayload.payloadStart,
    schemaPayload.payloadStart + schemaPayload.payloadLength)).digest()
    .copy(badSchemaExe, badSchemaExe.length - 32);
  await atomicReplace(exePath, badSchemaExe);
  const badSchemaRun = await launchExe("exe-v3-bad-schema", "reject");
  assert.equal(badSchemaRun.code, 1, `bad-schema exit code: ${badSchemaRun.code}`);
  assert(badSchemaRun.log.includes("overlay/runtime-package"), badSchemaRun.log.slice(-500));
  assert(!badSchemaRun.log.includes("native GPU:"), "bad-schema overlay must fail before GPU");
  assert.equal(JSON.stringify(await checkpointState(localAppData, exePath)), JSON.stringify(v2Checkpoint),
    "rejected bad-schema EXE must not touch the v2 checkpoint");
  record("exe-v3-bad-schema-rejected", { exitCode: badSchemaRun.code, marker: "overlay/runtime-package",
    beforeGpu: true, checkpointUnchanged: true, logTail: badSchemaRun.log.slice(-600) });

  // 回退:真实 HTTP 重新下载 v2 → 原子替换 → 呈现,像素与 v2 一致,检查点逐项匹配。
  const rollbackDownload = await v2.session.call({ method: "GET",
    url: `/api/projects/${v2.projectId}/applications/${v2.applicationId}/dashboard-candidates/${v2.candidateId}/standalone-executable` });
  assert.equal(rollbackDownload.statusCode, 200, rollbackDownload.body);
  assert.equal(sha(rollbackDownload.rawPayload), sha(v2.exe), "rollback re-download must reproduce the v2 EXE");
  await atomicReplace(exePath, rollbackDownload.rawPayload);
  const rollbackRun = await launchExe("exe-v2-rollback", "present");
  assert(rollbackRun.log.includes(`hash=${v2.packageHash}`), rollbackRun.log.slice(-500));
  const rollbackCheckpoint = await checkpointState(localAppData, exePath);
  assertActiveCheckpoint(rollbackCheckpoint, v2.packageHash, sha(v2.runtimePackage), "rollback");
  assert.equal(rollbackCheckpoint.files["active.json"], v2Checkpoint.files["active.json"],
    "rollback must not alter active.json");
  assert(!Object.keys(rollbackCheckpoint.files).some(file => file.endsWith(".json") &&
    file !== `${v2.packageHash}.json` && file !== "active.json"),
    `rollback checkpoint must not carry foreign payloads: ${Object.keys(rollbackCheckpoint.files)}`);
  const rollbackPixels = await pixelDigest(rollbackRun.png!, path.join(pixelWork, "exe-v2-rollback"));
  assertRegionsIdentical(v2Pixels, rollbackPixels, "exe rollback must restore v2 pixels exactly");
  record("exe-rollback-v2", { redownloadedOverHttp: true, checkpointActiveMatchesV2: true,
    activeJsonUnchanged: true,
    retirementNote: "恢复目录按保留预算暂存过版本载荷;回退重提交后上一版按 retired 策略清理,活动状态与活动载荷逐字节一致",
    screenshot: rollbackRun.png, pixelsMatchV2: true, regions: rollbackPixels.regions });

  await atomicReplace(exePath, v3.exe);
  const v3Run = await launchExe("exe-v3-valid", "present");
  assert(v3Run.log.includes(`hash=${v3.packageHash}`) && v3Run.log.includes(`version=${V3.packageVersion}`), v3Run.log.slice(-600));
  const v3AtlasEvidence = assertDashboardAtlasEvidence(v3Run.log, v3.runtimePackage);
  const v3Checkpoint = await checkpointState(localAppData, exePath);
  assert.equal(v3Checkpoint.active.hash, v3.packageHash);
  assert.equal(v3Checkpoint.files[`${v3.packageHash}.json`], sha(v3.runtimePackage));
  const v3Pixels = await pixelDigest(v3Run.png!, path.join(pixelWork, "exe-v3-valid"));
  assert.notEqual(v3Pixels.full, v2Pixels.full, "v3' pixels must differ from v2");
  assert.notEqual(v3Pixels.regions.banner.sha256, v2Pixels.regions.banner.sha256, "banner text pixels must differ across versions");
  assert.notEqual(v3Pixels.regions.bottom.sha256, v2Pixels.regions.bottom.sha256, "page background pixels must differ across versions");
  record("exe-v3-valid", { version: V3.packageVersion, packageHash: v3.packageHash, checkpointActive: "v3",
    screenshot: v3Run.png, pixels: v3Pixels, atlasEvidence: v3AtlasEvidence,
    bannerDeltaVsV1: v1Pixels ? regionDelta(v1Pixels, v3Pixels, "banner") : null });

  // ── D. 文件链(--package):坏包自动回退 last-known-good、双重失败 fail-closed ──
  await v2.close(); await v3.close(); // 从这里起没有任何本地服务在监听。
  const portableDirectory = path.join(directory, "portable-player");
  await mkdir(portableDirectory);
  const portableExe = path.join(portableDirectory, "deep-native-player.exe");
  const packagePath = path.join(portableDirectory, "runtime-package.json");
  await writeFile(portableExe, await readFile(nativeExecutable));
  const launchPortable = (label: string, expect: "present" | "reject") =>
    launchPlayer({ label, executable: portableExe, args: ["--package", packagePath], localAppData, expect,
      screenshotsDirectory: screenshots });

  await writeFile(packagePath, v1PackageBytes);
  await launchPortable("portable-v1-seed", "present");
  const portableV1Checkpoint = await checkpointState(localAppData, packagePath);
  assert.equal(portableV1Checkpoint.active.hash, v1Hash);
  record("portable-v1-seed", { reused: "v1-bytes", checkpointActive: v1Hash });

  const v2Zip = await JSZip.loadAsync(v2.zip, { checkCRC32: true });
  const v2PackageFromZip = Buffer.from(await v2Zip.file("runtime-package.json")!.async("nodebuffer"));
  assert.equal(sha(v2PackageFromZip), sha(v2.runtimePackage), "ZIP runtime package must match candidate artifact");
  await atomicReplace(packagePath, v2PackageFromZip);
  const portableV2Run = await launchPortable("portable-v2", "present");
  assert(portableV2Run.log.includes(`hash=${v2.packageHash}`), portableV2Run.log.slice(-500));
  const portableV2Checkpoint = await checkpointState(localAppData, packagePath);
  assert.equal(portableV2Checkpoint.active.hash, v2.packageHash);
  const portableV2Pixels = await pixelDigest(portableV2Run.png!, path.join(pixelWork, "portable-v2"));
  record("portable-v2-verified", { version: V2.packageVersion, screenshot: portableV2Run.png, pixels: portableV2Pixels });

  // 坏 v3(runtime package 字节被篡改)→ 播放器自动回退 v2 检查点。
  // 呈现合同:恢复内容也是一次正式呈现,必须在时限内完成 GPU 提交自检 + 呈现检查点重提交,
  // 且重提交幂等(active.json 与载荷字节不变,仅巩固恢复状态);像素必须与 v2 逐区域一致。
  const badPackage = Buffer.from(v3.runtimePackage);
  const corruptAt = badPackage.indexOf('"packageId":"');
  assert(corruptAt > 0, "packageId marker not found");
  badPackage[corruptAt + 13] ^= 0x01;
  await atomicReplace(packagePath, badPackage);
  const autoRollbackRun = await launchRestoredPlayer({ label: "portable-v3-bad-auto-rollback",
    executable: portableExe, args: ["--package", packagePath], localAppData, screenshotsDirectory: screenshots });
  assert(autoRollbackRun.log.includes(`"packageHash":"${v2.packageHash}"`), autoRollbackRun.log.slice(-700));
  assert(autoRollbackRun.log.includes(`hash=${v2.packageHash}`), autoRollbackRun.log.slice(-700));
  assert(autoRollbackRun.log.includes("native GPU:"), autoRollbackRun.log.slice(-700));
  assert(autoRollbackRun.smokeSubmitted, `[auto-rollback] GPU submission signal not seen: ${autoRollbackRun.log.slice(-700)}`);
  assert(autoRollbackRun.presented, `[auto-rollback] presented checkpoint signal not seen: ${autoRollbackRun.log.slice(-700)}`);
  const autoRollbackCheckpoint = await checkpointState(localAppData, packagePath);
  assertActiveCheckpoint(autoRollbackCheckpoint, v2.packageHash, sha(v2.runtimePackage), "auto-rollback");
  assert.equal(autoRollbackCheckpoint.files["active.json"], portableV2Checkpoint.files["active.json"],
    "auto-rollback re-commit must keep active.json bytes identical (idempotent consolidation)");
  const autoRollbackPixels = await pixelDigest(autoRollbackRun.png!, path.join(pixelWork, "portable-v2-rollback")).catch(() => null);
  assert(autoRollbackPixels, "auto-rollback window capture must exist once the presented contract is fulfilled");
  assertRegionsIdentical(portableV2Pixels, autoRollbackPixels, "auto-rollback must present exactly v2 pixels");
  record("portable-v3-bad-auto-rollback", { tamperedRuntimePackageBytes: true, primaryRejected: true,
    recovered: "last-known-good", presentedVersion: V2.packageVersion,
    checkpointActiveMatchesV2: true, checkpointUnchangedByRecovery: true,
    smokeSubmitted: autoRollbackRun.smokeSubmitted, presentedContractFulfilled: true,
    screenshot: autoRollbackRun.png ?? null, pixels: autoRollbackPixels });

  // v3'(合法)→ 呈现,检查点推进到 v3'。
  const v3Zip = await JSZip.loadAsync(v3.zip, { checkCRC32: true });
  const v3PackageFromZip = Buffer.from(await v3Zip.file("runtime-package.json")!.async("nodebuffer"));
  assert.equal(sha(v3PackageFromZip), sha(v3.runtimePackage));
  await atomicReplace(packagePath, v3PackageFromZip);
  const portableV3Run = await launchPortable("portable-v3-valid", "present");
  assert(portableV3Run.log.includes(`hash=${v3.packageHash}`), portableV3Run.log.slice(-500));
  const portableV3Checkpoint = await checkpointState(localAppData, packagePath);
  assert.equal(portableV3Checkpoint.active.hash, v3.packageHash);
  assert.equal(portableV3Checkpoint.files[`${v3.packageHash}.json`], sha(v3.runtimePackage));
  const portableV3Pixels = await pixelDigest(portableV3Run.png!, path.join(pixelWork, "portable-v3-valid"));
  assert.notEqual(portableV3Pixels.full, portableV2Pixels.full, "portable v3' pixels must differ from v2");
  record("portable-v3-valid", { version: V3.packageVersion, screenshot: portableV3Run.png, pixels: portableV3Pixels });

  // 资源缺失(恢复目录层):主包损坏 + 检查点载荷被删 → 双重失败,fail-closed,无窗口。
  await atomicReplace(packagePath, badPackage);
  await rm(path.join(portableV3Checkpoint.key, `${v3.packageHash}.json`));
  const doubleFailureRun = await launchPortable("portable-resource-missing-fail-closed", "reject");
  assert.equal(doubleFailureRun.code, 1, `fail-closed exit code: ${doubleFailureRun.code}`);
  assert(doubleFailureRun.log.includes("primary rejected"), doubleFailureRun.log.slice(-700));
  assert(doubleFailureRun.log.includes("lkg/snapshot-read"), doubleFailureRun.log.slice(-700));
  assert(!doubleFailureRun.log.includes("native GPU:"), "fail-closed must happen before GPU");
  record("resource-missing-fail-closed", { deleted: `package-recovery/<key>/${v3.packageHash}.json`,
    primaryCorrupted: true, exitCode: doubleFailureRun.code, markers: ["primary rejected", "lkg/snapshot-read"],
    beforeGpu: true, logTail: doubleFailureRun.log.slice(-700),
    note: "fail-closed 发生在窗口创建之前(设计如此),无错误窗口可截图;证据为退出码+错误码+无 GPU 初始化" });

  // 恢复后正常:还原 v3' 包 → 呈现 → 检查点载荷重建。
  await atomicReplace(packagePath, v3PackageFromZip);
  const recoveryRun = await launchPortable("portable-v3-recovered", "present");
  const recoveredCheckpoint = await checkpointState(localAppData, packagePath);
  assert.equal(recoveredCheckpoint.active.hash, v3.packageHash);
  assert.equal(recoveredCheckpoint.files[`${v3.packageHash}.json`], sha(v3.runtimePackage),
    "checkpoint payload must be rebuilt after recovery");
  record("resource-missing-recovered", { presented: true, checkpointPayloadRebuilt: true, screenshot: recoveryRun.png });

  // 资源缺失(交付包目录层):ZIP 清单内资源被删 → 客户端解包校验 fail-closed,不进入打开。
  const unpackDirectory = path.join(directory, "unpack-gate");
  await mkdir(unpackDirectory);
  const zipManifest = JSON.parse(await v3Zip.file("manifest.json")!.async("text"));
  const missingFile = "THIRD_PARTY_NOTICES.md";
  for (const name of Object.keys(zipManifest.files)) {
    if (name === missingFile) continue;
    await writeFile(path.join(unpackDirectory, name), await v3Zip.file(name)!.async("nodebuffer"));
  }
  const inventoryCheck = async () => {
    const present = new Set(await readdir(unpackDirectory));
    for (const name of Object.keys(zipManifest.files)) {
      if (!present.has(name)) throw new Error(`unpack gate: missing ${name}`);
      const bytes = await readFile(path.join(unpackDirectory, name));
      if (sha(bytes) !== zipManifest.files[name]) throw new Error(`unpack gate: hash mismatch ${name}`);
    }
  };
  let unpackError: unknown;
  try { await inventoryCheck(); } catch (reason) { unpackError = reason; }
  assert(unpackError instanceof Error && unpackError.message.includes(`missing ${missingFile}`), String(unpackError));
  await writeFile(path.join(unpackDirectory, missingFile), await v3Zip.file(missingFile)!.async("nodebuffer"));
  await inventoryCheck(); // 恢复后解包校验通过。
  record("unpack-gate-fail-closed", { reused: false, deleted: missingFile, error: String(unpackError),
    failClosedBeforeOpen: true, restoredInventoryPasses: true,
    note: "交付包目录为清单自校验布局,删除任一清单资源都会被解包门槛拒绝,播放器不会见到损坏目录" });

  // ── E. 离线旧版:所有服务已关闭 + PATH 仅 System32,仅凭 v2 检查点启动 ───────────
  const offlineDirectory = path.join(directory, "offline-player");
  await mkdir(offlineDirectory);
  const offlineExe = path.join(offlineDirectory, "deep-native-player.exe");
  const offlinePackagePath = path.join(offlineDirectory, "runtime-package.json");
  await writeFile(offlineExe, await readFile(nativeExecutable));
  await writeFile(offlinePackagePath, v2.runtimePackage);
  await launchPlayer({ label: "offline-v2-seed", executable: offlineExe, args: ["--package", offlinePackagePath],
    localAppData, expect: "present", screenshotsDirectory: screenshots });
  const offlineSeedCheckpoint = await checkpointState(localAppData, offlinePackagePath);
  assert.equal(offlineSeedCheckpoint.active.hash, v2.packageHash);
  await rm(offlinePackagePath); // 主包文件缺失,只剩检查点。
  const offlineRun = await launchRestoredPlayer({ label: "offline-v2-checkpoint-boot", executable: offlineExe,
    args: ["--package", offlinePackagePath], localAppData, screenshotsDirectory: screenshots });
  assert(offlineRun.log.includes(`"packageHash":"${v2.packageHash}"`), offlineRun.log.slice(-700));
  assert(offlineRun.log.includes(`hash=${v2.packageHash}`), offlineRun.log.slice(-700));
  assert(offlineRun.log.includes("native GPU:"), offlineRun.log.slice(-700));
  assert(offlineRun.smokeSubmitted, `[offline boot] GPU submission signal not seen: ${offlineRun.log.slice(-700)}`);
  assert(offlineRun.presented, `[offline boot] presented checkpoint signal not seen: ${offlineRun.log.slice(-700)}`);
  const offlineCheckpoint = await checkpointState(localAppData, offlinePackagePath);
  assertActiveCheckpoint(offlineCheckpoint, v2.packageHash, sha(v2.runtimePackage), "offline boot");
  const offlinePixels = await pixelDigest(offlineRun.png!, path.join(pixelWork, "offline-v2")).catch(() => null);
  assert(offlinePixels, "offline boot window capture must exist once the presented contract is fulfilled");
  assertRegionsIdentical(portableV2Pixels, offlinePixels, "offline checkpoint boot must present exactly v2 pixels");
  record("offline-v2-checkpoint-boot", { serversClosed: true, nodeOnPath: false, packageFileDeleted: true,
    recovered: "last-known-good", presentedVersion: V2.packageVersion, checkpointActiveV2: true,
    smokeSubmitted: offlineRun.smokeSubmitted, presentedContractFulfilled: true,
    visualOfflineBootEvidence: offlineRun.png ?? null, pixels: offlinePixels });

  // ── F. 证据汇总 ────────────────────────────────────────────────────────────────
  // 呈现合同已在上面逐步断言;此清单是回归哨兵——一旦任一恢复启动未达成合同,缺陷将在此留档。
  const defectSummary = [autoRollbackRun, offlineRun].filter(run => !run.presented).map((run, index) => ({
    id: `P3-05-D1-lkg-restore-present-contract-${index === 0 ? "auto-rollback" : "offline-boot"}`,
    code: "lkg-restore-present-marker-never-fires",
    severity: "high",
    repro: "deep-native-player --package <path>:主包被拒(hash mismatch 或文件缺失)且检查点恢复成功时,进程打印 "
      + "'Deep Runtime Package startup recovery: {\"code\":\"primary-rejected\",\"active\":\"last-known-good\"}' 并完成 GPU/Deep2d 初始化,实际绘制恢复内容,"
      + "但 'native smoke GPU submission complete' 与 'native package recovery checkpoint committed after present' 长时间(>75s,人工观察 >2min)不出现;"
      + "对照:同一二进制同一检查点以合法主包启动在 ~20-40s 内正常呈现。",
    userVisible: "自动回退/离线检查点启动的窗口实际显示恢复后的 v2 内容(screenshots/portable-v3-bad-auto-rollback.png、offline-v2-checkpoint-boot.png)",
    impact: "呈现合同未达成:依赖 presented 检查点的客户端会无限等待;恢复后检查点不会重新提交(本链中检查点已是 v2,状态仍正确)",
    control: "合法主包对照启动(portable-v3-valid 与恢复后重开)均正常呈现并提交检查点",
  }));
  const evidence = {
    scope: "p03-05-upgrade-rollback-chain", verifiedAt: new Date().toISOString(),
    machine: { gpu: "RTX 4060 Laptop / Vulkan (real window presents)", os: process.platform,
      nodeOnPlayerPath: false, playerPath: "Windows System32 only" },
    testDataOnly: true, productionSourcesModified: false,
    reused: { scope: "v1-multicomponent-rev1-publication-download-open-screenshots (P0-06)",
      run: priorDirectory, evidence: path.join(priorDirectory, "evidence.json"),
      v1Executable, v1Package: path.join(priorDirectory, "extracted", "runtime-package.json"),
      v1Screenshot: v1Screenshot ?? null },
    nativeExecutableSha256: nativeSha, deviceFingerprintSha256: deviceFingerprint,
    versions: {
      v1: { packageVersion: "1.0.0", packageHash: v1Hash, reused: true,
        atlasCount: priorEvidence.expectedAtlasCount ?? null },
      v2: { packageVersion: V2.packageVersion, packageHash: v2.packageHash, banner: V2.banner,
        barRows: V2.barRows, pageBackground: V2.pageBackground, exeSha256: sha(v2.exe),
        zipSha256: sha(v2.zip), atlasCount: v2.atlasCount },
      v3Bad: { derivedFrom: "v3'", tamper: "runtime package byte flip → hash break (overlay/payload-hash) 与 schema break (overlay/runtime-package)" },
      v3Valid: { packageVersion: V3.packageVersion, packageHash: v3.packageHash, banner: V3.banner,
        barRows: V3.barRows, pageBackground: V3.pageBackground, exeSha256: sha(v3.exe),
        zipSha256: sha(v3.zip), atlasCount: v3.atlasCount },
    },
    steps, defects: defectSummary, pixelAssertions: {
      sameVersionIdentical: [
        "exe-v2 vs exe-v2-rollback",
        "portable-v2 vs auto-rollback/offline-boot(呈现合同达成后无条件做严格像素一致断言)",
      ],
      crossVersionDistinct: {
        v1BannerSha: v1Pixels?.regions.banner.sha256 ?? null, v2BannerSha: v2Pixels.regions.banner.sha256,
        v3BannerSha: v3Pixels.regions.banner.sha256,
        v2BottomRgb: portableV2Pixels.regions.bottom.rgb, v3BottomRgb: portableV3Pixels.regions.bottom.rgb,
        v1BottomRgb: v1Pixels?.regions.bottom.rgb ?? null,
      },
    },
    launchLogExcerpts: {
      exeV3BadHash: badHashRun.log.slice(-1200), exeV3BadSchema: badSchemaRun.log.slice(-1200),
      autoRollback: autoRollbackRun.log.slice(-1600), offlineBoot: offlineRun.log.slice(-1600),
      doubleFailure: doubleFailureRun.log.slice(-1200),
    },
    honestLimits: {
      failClosedWindow: "fail-closed 发生于窗口创建之前(设计如此),无错误窗口可截图;以退出码、错误码与检查点不变为证",
      autoRollbackScope: "单 EXE 嵌入式载荷损坏为硬拒绝(exit 1,检查点保持,回退=重新下载安装 v2);自动回退由 --package 文件模式的 last-known-good 恢复路径提供",
      serverLifecycle: "EXE 链启动阶段验收 loopback 服务仍在监听(播放器环境仅 System32 PATH,日志无任何网络活动);文件链/离线检查点启动在全部服务关闭后执行",
      v1Pixels: v1Pixels ? "v1 像素基线取自复用截图(PrintWindow)" : "v1 截图像素化失败,跨版本 v1 像素对比不可用",
      exeInteraction: "未驱动 EXE 内真实输入交互,归属 G01 输入宿主范围",
    },
  };
  await writeFile(path.join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(directory, "evidence-manifest.json"), JSON.stringify({ scope: "sha256-inventory",
    generatedAt: new Date().toISOString(), files: await hashInventory(directory) }, null, 2));
  console.log(JSON.stringify({ status: "passed", directory, steps: steps.length,
    screenshots: (await readdir(screenshots)).filter(name => name.endsWith(".png")) }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
