// V1 三端同内容对拍统一 runner：同一冻结 box 场景（同 packageId/packageHash/文件 SHA-256），
// 分别由 Web headless Chrome、Three WebView（Tauri EXE 内 WebView2 真实进程）、Deep Native
// （wgpu 真实窗口）加载并渲染 N 帧，逐端留截图/帧证据，最后落能力矩阵（md + 机器可读 json）。
// 复用骨架：verify-gi-crossend-matrix.mts（vite+playwright 取证口径）、verify-scene-native-window.mjs
// （Native 实窗哈希链验证）、test-output/v2-native-release-20260923/build-minimal-fixture.mts（夹具）。
// 切片 4/5（本轮新增，数值全部脚本计算，第一版建立基线、不设达标线、不判胜负）：
// - 逐像素画质对拍：三端同机位（pose0）帧分块 SSIM 两两比较（Web vs Native / Web vs WebView），
//   曝光/色调映射类系统性差异先做线性校准归一化尝试，归一化前后两套数值都如实落盘，附分块差异热图。
//   口径详见 scripts/lib/pixelParity.mjs 头注释与 pixel-input-parity/pixel-parity.json 的 caliber 段。
// - 输入轨迹对拍：确定性 orbit 轨迹（yaw 三步 0.540→0.875→1.2，pitch/radius 由夹具原始机位解析导出）。
//   Web/WebView 在同一页面经 evaluate 注入同参数（window.setCameraPose → applyCamera）；
//   Native verify 脚本相机由 fixture 决定、不支持动态轨迹，以"每机位一份冻结 fixture + 一次 verify +
//   一次实窗截帧"的固定机位三帧等效执行（矩阵与 json 均注明该口径）。
// 每端独立可失败：单端/单机位异常不阻断其余端，矩阵如实记录失败与已试命令。
//
// 用法：npx tsx scripts/verify-v1-tri-endpoint-matrix.mts [--output <dir>] [--frames N]
//   DEEP_V1_NATIVE_EXE=<exe> 可显式指定 Native 程序；V1_WEBVIEW_EXE=<exe> 可显式指定 WebView 程序。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import playwright from "../apps/cloud-render-worker/node_modules/playwright-core/index.js";
type PlaywrightPage = Awaited<ReturnType<Awaited<ReturnType<typeof playwright.chromium.launch>>["newPage"]>>;
import type { SceneSnapshot } from "@bim-studio/contracts";
import { createNativeWindowVerifier } from "./lib/nativeWindowVerifier.mjs";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";
import { computeBlockSsim, fitLinearCalibration, applyLinearCalibration, buildBlockHeatmapRgb } from "./lib/pixelParity.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const requireWeb = createRequire(path.join(repo, "apps/web/package.json"));
const sharp = requireWeb("sharp") as typeof import("sharp");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// ---------- 参数与输出目录 ----------
const args = process.argv.slice(2);
const argValue = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const output = path.resolve(argValue("--output") ?? path.join(repo, "test-output/v1-tri-endpoint-20260923"));
const frames = Math.max(1, Math.min(120, Number(argValue("--frames") ?? "8") || 8));
const sha256 = (bytes: Uint8Array | Buffer) => createHash("sha256").update(bytes).digest("hex");

// ---------- 编译链按需加载（含自拉起） ----------
// tsx 默认解析 @bim-studio/deep-engine 包导出时不带 development 条件，会解析到陈旧 dist 并缺新导出
// （并行波次演进中的真实漂移）。检测到该错误就带 --conditions=development 自拉起一次，
// 与 scripts/verify-dynamic-runtime-replay.mts 的 esbuild conditions 口径一致；不改包导出映射。
let compileSceneRuntimePackage: typeof import("../apps/web/src/delivery/compileSceneRuntimePackage.ts")["compileSceneRuntimePackage"];
let parseDeepRuntimePackage: typeof import("../packages/deep-engine/src/runtimePackage/index.ts")["parseDeepRuntimePackage"];
if (!process.env.V1_CONDITIONS_RESPAWN) {
  try {
    const compiler = await import(pathToFileURL(path.join(repo, "apps/web/src/delivery/compileSceneRuntimePackage.ts")).href);
    const engineRuntime = await import(pathToFileURL(path.join(repo, "packages/deep-engine/src/runtimePackage/index.ts")).href);
    compileSceneRuntimePackage = compiler.compileSceneRuntimePackage;
    parseDeepRuntimePackage = engineRuntime.parseDeepRuntimePackage;
  } catch (error) {
    if (!String(error).includes("does not provide an export")) throw error;
    console.error("[runner] 包导出解析到陈旧 dist，带 --conditions=development 自拉起重跑…");
    const result = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args],
      { stdio: "inherit", env: { ...process.env, V1_CONDITIONS_RESPAWN: "1",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=development`.trim() } });
    process.exit(result.status ?? 1);
  }
} else {
  const compiler = await import(pathToFileURL(path.join(repo, "apps/web/src/delivery/compileSceneRuntimePackage.ts")).href);
  const engineRuntime = await import(pathToFileURL(path.join(repo, "packages/deep-engine/src/runtimePackage/index.ts")).href);
  compileSceneRuntimePackage = compiler.compileSceneRuntimePackage;
  parseDeepRuntimePackage = engineRuntime.parseDeepRuntimePackage;
}
const verifySceneNativeWindow = createNativeWindowVerifier(parseDeepRuntimePackage);

for (const dir of ["web", "webview", "native", "pixel-input-parity"]) await rm(path.join(output, dir), { recursive: true, force: true });
for (const dir of ["fixture", "web", "webview", "native", "pixel-input-parity"]) await mkdir(path.join(output, dir), { recursive: true });

// ---------- 切片 1：冻结场景 fixture（V2 最小 box 场景同族，三端消费同一运行包字节） ----------
// 输入轨迹参数（切片 5）：绕 target 的 orbit 球坐标轨迹，pitch/radius 由夹具原始机位 (3,2,5)/(0,1,0)
// 解析导出（radius=√35、pitch=asin(1/√35)），起点 yaw=atan2(3,5) 解析还原 position=(3,2,5)——
// 因此 pose0 与第一版夹具字节完全一致；三步确定性轨迹 yaw 0.540→0.875→1.2（弧度）。
const TRAJECTORY_TARGET = { x: 0, y: 1, z: 0 };
const TRAJECTORY_RADIUS = Math.sqrt(35);
const TRAJECTORY_PITCH = Math.asin(1 / Math.sqrt(35));
const TRAJECTORY_YAWS = [Math.atan2(3, 5), 0.875, 1.2];
const posePosition = (yaw: number) => ({
  x: TRAJECTORY_TARGET.x + TRAJECTORY_RADIUS * Math.sin(yaw) * Math.cos(TRAJECTORY_PITCH),
  y: TRAJECTORY_TARGET.y + TRAJECTORY_RADIUS * Math.sin(TRAJECTORY_PITCH),
  z: TRAJECTORY_TARGET.z + TRAJECTORY_RADIUS * Math.cos(yaw) * Math.cos(TRAJECTORY_PITCH),
});
const at = "2026-09-23T00:00:00Z";
const scene: SceneSnapshot = {
  schemaVersion: 1, id: "v1-tri-endpoint", projectId: "fixture", name: "V1 tri-endpoint frozen box",
  models: [],
  primitives: [{ modelId: "box", name: "Box", kind: "box", color: "#60a5fa", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }],
  measurements: [],
  camera: { mode: "orbit", position: { x: 3, y: 2, z: 5 }, target: { x: 0, y: 1, z: 0 } },
  environment: { skybox: "none", gridVisible: false, backgroundColor: "#172126" },
  createdAt: at, updatedAt: at,
};
const compiled = await compileSceneRuntimePackage(structuredClone(scene), {
  packageId: "scene.v1-tri-endpoint", packageVersion: "1.0.0",
  loadModel: async () => { throw new Error("冻结夹具不含模型资产"); },
});
const checked = parseDeepRuntimePackage(compiled.packageJson);
if (!checked.valid) throw new Error(`冻结运行包校验失败：${JSON.stringify(checked.issues)}`);
const packageJson = compiled.packageJson;
const packageBytes = Buffer.from(packageJson, "utf8");
const fixtureHash = checked.value.packageHash.value;
const cameraPayload = checked.value.payloads[checked.value.entrypoints.camera] as { schemaVersion?: number };
const fixtureMeta = {
  packageId: checked.value.packageId, packageVersion: checked.value.packageVersion, packageHash: fixtureHash,
  runtimePackageFile: "fixture/runtime-package.json", runtimePackageSha256: sha256(packageBytes), runtimePackageBytes: packageBytes.byteLength,
  resources: checked.value.resources.length, cameraSchemaVersion: cameraPayload?.schemaVersion ?? null,
  sceneSnapshotFile: "fixture/scene-snapshot.json", sceneSnapshotSha256: sha256(Buffer.from(JSON.stringify(scene, null, 2), "utf8")),
  note: "三端消费同一 runtime-package.json 字节：Native 报告 packageHash，Web/WebView 端 parse 校验同 hash。",
};
await writeFile(path.join(output, "fixture/runtime-package.json"), packageJson);
await writeFile(path.join(output, "fixture/scene-snapshot.json"), `${JSON.stringify(scene, null, 2)}\n`);
await writeFile(path.join(output, "fixture/fixture-meta.json"), `${JSON.stringify(fixtureMeta, null, 2)}\n`);

// 轨迹机位 fixture（切片 5，Native 端专用）：与 pose0 仅相机 position 不同（其余字段逐字节同源），
// 各自独立 packageId/packageHash；三端逐机位对拍时 Native 消费该包字节，Web/WebView 仍用 pose0 包
// + evaluate 注入同参数（两种执行方式都在矩阵注明，不冒充同字节）。
const poseFixtures: Array<{ pose: number; yaw: number; packageId: string; packageHash: string;
  runtimePackageSha256: string; sceneSnapshotSha256: string; position: { x: number; y: number; z: number } }> = [];
for (let pose = 1; pose < TRAJECTORY_YAWS.length; pose += 1) {
  const yaw = TRAJECTORY_YAWS[pose] as number;
  const position = posePosition(yaw);
  const poseScene: SceneSnapshot = { ...structuredClone(scene), id: `v1-tri-endpoint-pose${pose}`,
    camera: { mode: "orbit", position, target: { ...TRAJECTORY_TARGET } } };
  const poseCompiled = await compileSceneRuntimePackage(structuredClone(poseScene), {
    packageId: `scene.v1-tri-endpoint.pose${pose}`, packageVersion: "1.0.0",
    loadModel: async () => { throw new Error("冻结夹具不含模型资产"); },
  });
  const poseChecked = parseDeepRuntimePackage(poseCompiled.packageJson);
  if (!poseChecked.valid) throw new Error(`机位 ${pose} 运行包校验失败：${JSON.stringify(poseChecked.issues)}`);
  await mkdir(path.join(output, `fixture/pose${pose}`), { recursive: true });
  await writeFile(path.join(output, `fixture/pose${pose}/runtime-package.json`), poseCompiled.packageJson);
  await writeFile(path.join(output, `fixture/pose${pose}/scene-snapshot.json`), `${JSON.stringify(poseScene, null, 2)}\n`);
  poseFixtures.push({ pose, yaw, packageId: poseChecked.value.packageId, packageHash: poseChecked.value.packageHash.value,
    runtimePackageSha256: sha256(Buffer.from(poseCompiled.packageJson, "utf8")),
    sceneSnapshotSha256: sha256(Buffer.from(JSON.stringify(poseScene, null, 2), "utf8")), position });
}
// 轨迹参数与机位包清单随 fixture meta 落盘（数值全部脚本计算，含浮点全精度，不四舍五入冒充解析值）。
(fixtureMeta as Record<string, unknown>).trajectory = {
  kind: "orbit", target: TRAJECTORY_TARGET, radius: TRAJECTORY_RADIUS, pitch: TRAJECTORY_PITCH,
  yawSteps: TRAJECTORY_YAWS, startPoseEqualsOriginalFixture: true,
  nativeMode: "每机位一份冻结 fixture + verify + 实窗截帧（verify 脚本相机由 fixture 决定，固定机位三帧等效）",
  webMode: "同页面 evaluate 注入 window.setCameraPose 同参数（applyCamera 同一路径）",
  poses: poseFixtures,
};
await writeFile(path.join(output, "fixture/fixture-meta.json"), `${JSON.stringify(fixtureMeta, null, 2)}\n`);
console.log(`[fixture] packageId=${fixtureMeta.packageId} hash=${fixtureHash} bytes=${fixtureMeta.runtimePackageBytes} 轨迹机位包=${poseFixtures.length}`);

// ---------- 共享宿主：vite dev server（gi-crossend-matrix 同口径，与发布查看器同一渲染链） ----------
const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
const server = await createServer({ root: path.join(repo, "apps/web"), configFile: false,
  server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server.listen();
const origin = server.resolvedUrls.local[0];

interface Attempt { label: string; ok: boolean; error?: string }
interface EndpointCell {
  endpoint: string; loaded: boolean; rendererBackend: string; framesProduced: number | null; framesRequested: number;
  screenshotPaths: string[]; gpuErrorsClean: boolean | null; packageHashMatch: boolean | null;
  consoleErrors: string[]; attempts: Attempt[]; notes: string[];
}
/** 轨迹逐机位截图记录（切片 5）：per 机位独立可失败，失败原因随端点 attempts 落盘。 */
interface TrajectoryRun { screenshots: string[]; errors: string[] }
interface BrowserRun {
  result: { backend: string; frames: number; packageHash: string; presentations: Array<{ drawCalls: number | null }>; environmentProbe: unknown };
  consoleErrors: string[]; pageErrors: string[]; gpuErrorsClean: boolean; screenshot: string; packageHashMatch: boolean;
  trajectory: TrajectoryRun;
}

/** 浏览器端通用取证（Chrome 与 WebView2 共用）：同一 harness 页面加载冻结包渲染 N 帧 + 截图。 */
async function runBrowserBackend(page: PlaywrightPage, backend: "webgl" | "webgpu", dir: string, prefix: string): Promise<BrowserRun> {
  const consoleErrors: string[] = [], pageErrors: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300)); });
  page.on("pageerror", error => pageErrors.push(`pageerror: ${String(error).slice(0, 300)}`));
  await page.addInitScript(values => {
    window.frozenPackageJson = values.frozen; window.sceneSnapshotJson = values.snapshot; window.frameTarget = values.frames;
  }, { frozen: packageJson, snapshot: JSON.stringify(scene), frames: String(frames) });
  await page.goto(`${origin}scripts/v1-tri-endpoint.html?backend=${backend}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => (window as { result?: unknown }).result || (window as { failure?: string }).failure, undefined, { timeout: 60_000 });
  const failure = await page.evaluate(() => (window as { failure?: string }).failure);
  if (failure) throw new Error(failure);
  const result = await page.evaluate(() => window.result) as BrowserRun["result"];
  const screenshot = path.join(output, dir, `${prefix}-${backend}.png`);
  await page.locator("canvas").screenshot({ path: screenshot });
  // GPU 错误口径：未捕获异常与非资源类 console error 记为 GPU/渲染错误；
  // favicon 404 之类的资源加载噪声单独保留在 consoleErrors 里，不计入。
  const resourceNoise = (text: string) => text.startsWith("Failed to load resource");
  const gpuErrorsClean = pageErrors.length === 0 && consoleErrors.filter(text => !resourceNoise(text)).length === 0;
  // ---------- 切片 5：确定性相机轨迹（本端执行方式=evaluate 注入同参数，非换 fixture） ----------
  // pose0 帧即上面主截图（轨迹起点），这里从 pose1 开始逐机位注入；每机位独立可失败，
  // 失败不阻断后续机位，错误文案随 trajectory.errors 落盘。
  const trajectory: TrajectoryRun = { screenshots: [screenshot], errors: [] };
  for (let pose = 1; pose < TRAJECTORY_YAWS.length; pose += 1) {
    try {
      // 参数对象显式经 evaluate 传参序列化进页面（TRAJECTORY_* 是 runner 侧常量，页面闭包看不到）；
      // 页面未暴露 setCameraPose（harness 版本过旧）时 fail loud，不静默跳过。
      await page.evaluate(async injected => {
        const setter = (window as unknown as {
          setCameraPose?: (pose: typeof injected) => Promise<void>;
        }).setCameraPose;
        if (!setter) throw new Error("页面未暴露 window.setCameraPose（harness 版本过旧）");
        await setter(injected);
      }, { yaw: TRAJECTORY_YAWS[pose], pitch: TRAJECTORY_PITCH, radius: TRAJECTORY_RADIUS,
        targetX: TRAJECTORY_TARGET.x, targetY: TRAJECTORY_TARGET.y, targetZ: TRAJECTORY_TARGET.z });
      const shot = path.join(output, dir, `${prefix}-pose${pose}-${backend}.png`);
      await page.locator("canvas").screenshot({ path: shot });
      trajectory.screenshots.push(shot);
    } catch (error) {
      trajectory.errors.push(`pose${pose}: ${String(error).slice(0, 300)}`);
    }
  }
  return { result, consoleErrors, pageErrors, gpuErrorsClean, screenshot, packageHashMatch: result.packageHash === fixtureHash, trajectory };
}

// ---------- 切片 2a：Web 端（headless Chrome，webgpu 优先 + webgl 备选，都试都记录） ----------
const webCell: EndpointCell = { endpoint: "web", loaded: false, rendererBackend: "", framesProduced: null, framesRequested: frames,
  screenshotPaths: [], gpuErrorsClean: null, packageHashMatch: null, consoleErrors: [], attempts: [], notes: [] };
const webBackends: Array<Record<string, unknown>> = [];
let chromiumBrowser: Awaited<ReturnType<typeof playwright.chromium.launch>> | undefined;
try {
  if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
  chromiumBrowser = await playwright.chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"] });
  webCell.notes.push(`chrome=${chromiumBrowser.version()}`);
  for (const backend of ["webgpu", "webgl"] as const) {
    const page = await chromiumBrowser.newPage({ viewport: { width: 1000, height: 600 } });
    try {
      const run = await runBrowserBackend(page, backend, "web", "web");
      webBackends.push({ backend, loaded: true, frames: run.result.frames,
        drawCallFrames: run.result.presentations.filter(p => (p.drawCalls ?? 0) > 0).length,
        packageHashMatch: run.packageHashMatch, screenshot: path.relative(output, run.screenshot),
        trajectory: { screenshots: run.trajectory.screenshots.map(shot => path.relative(output, shot)), errors: run.trajectory.errors },
        consoleErrors: run.consoleErrors, pageErrors: run.pageErrors, gpuErrorsClean: run.gpuErrorsClean,
        environmentProbe: run.result.environmentProbe });
      webCell.screenshotPaths.push(path.relative(output, run.screenshot));
      webCell.screenshotPaths.push(...run.trajectory.screenshots.slice(1).map(shot => path.relative(output, shot)));
      webCell.rendererBackend ||= `chrome-${run.result.backend}`;
      webCell.framesProduced = Math.max(webCell.framesProduced ?? 0, run.result.frames);
      webCell.packageHashMatch = webCell.packageHashMatch ?? run.packageHashMatch;
      webCell.gpuErrorsClean = webCell.gpuErrorsClean ?? run.gpuErrorsClean;
      if (!webCell.consoleErrors.length) webCell.consoleErrors = run.consoleErrors;
      webCell.attempts.push({ label: `web-${backend}`, ok: true });
    } catch (error) {
      webCell.attempts.push({ label: `web-${backend}`, ok: false, error: String(error).slice(0, 400) });
    } finally { await page.close(); }
  }
  webCell.loaded = webBackends.length > 0;
} catch (error) {
  webCell.attempts.push({ label: "web-launch", ok: false, error: String(error).slice(0, 400) });
} finally { await chromiumBrowser?.close(); }
await writeFile(path.join(output, "web/web-result.json"), `${JSON.stringify({ endpoint: "web", frames, backends: webBackends }, null, 2)}\n`);
console.log(`[web] loaded=${webCell.loaded} backends=${webBackends.map(cell => cell.backend).join(",") || "none"}`);

// ---------- 切片 2c：Deep Native 端（verify 哈希链 + captureNativePlayerWindow 实窗截帧） ----------
const nativeCell: EndpointCell = { endpoint: "deep-native", loaded: false, rendererBackend: "", framesProduced: null, framesRequested: frames,
  screenshotPaths: [], gpuErrorsClean: null, packageHashMatch: null, consoleErrors: [], attempts: [], notes: [] };
// 轨迹帧登记（切片 5 消费）：pose0 → native/native.png，pose1/2 → native/pose{n}.png。
// 声明在端点 try 之外：单端失败时切片 5 仍能如实记录缺失机位。
const nativeTrajectoryFrames = new Map<number, string>();
try {
  const executable = process.env.DEEP_V1_NATIVE_EXE ?? path.join(repo, "packages/deep-engine-native/target/release/deep-engine-native.exe");
  if (!existsSync(executable)) throw new Error(`Native EXE 不存在：${executable}（可先 cargo build --release --bin deep-engine-native，或设 DEEP_V1_NATIVE_EXE）`);
  const packagePath = path.join(output, "fixture/runtime-package.json");
  const verify = await verifySceneNativeWindow({ packagePath, nativeExecutable: executable, frames });
  nativeCell.loaded = true;
  nativeCell.rendererBackend = verify.report.backend;
  nativeCell.framesProduced = verify.report.presentedFrames;
  nativeCell.gpuErrorsClean = verify.report.gpuErrorsClean;
  nativeCell.packageHashMatch = verify.packageHash.value === fixtureHash;
  nativeCell.notes.push(`window=${verify.report.width}x${verify.report.height}`, `exeSha256=${verify.executableSha256.slice(0, 16)}…`);
  nativeCell.attempts.push({ label: "native-verify", ok: true });
  await writeFile(path.join(output, "native/native-verify.json"), `${JSON.stringify(verify, null, 2)}\n`);
  // 实窗截帧 helper：PrintWindow 读回真实窗口（gi-crossend-matrix 同口径）→ 裁 client 区 →
  // 统一缩放 960×540（逐像素对拍的基线尺寸，与 Web/WebView 截图同一口径）。
  // 窗口枚举/读回存在非确定性瞬时失败（实测：同一执行方式 pose0 报 client rect 瞬空、pose1/2 成功），
  // 固定重试一次；两次仍失败才计入 attempts——不掩盖失败，也不因瞬时抖动丢基线帧。
  const capturePoseFrame = async (label: string, posePackagePath: string, png: string) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const capture = await captureNativePlayerWindow({ label, executable, args: ["--package", posePackagePath],
          outputDirectory: path.join(output, "native"), clientSize: [960, 540],
          presentedMarker: "native package recovery checkpoint committed after present", timeoutMs: 60_000 });
        await writeFile(path.join(output, "native", `${label}-capture.log`), capture.captureLog);
        const match = /client=(\d+)x(\d+) dpi=\d+ clientOffset=(\d+),(\d+)/.exec(capture.captureLog);
        if (!match) throw new Error(`captureLog 缺少 client 几何：${capture.captureLog.slice(0, 200)}`);
        const [w, h, left, top] = match.slice(1).map(Number) as [number, number, number, number];
        await sharp(capture.png).extract({ left, top, width: w, height: h }).resize(960, 540, { fit: "fill" }).png().toFile(png);
        return;
      } catch (error) {
        if (attempt >= 2) throw error;
        console.error(`[native] ${label} 第 ${attempt} 次截帧瞬时失败，2.5s 后重试：${String(error).slice(0, 160)}`);
        await new Promise(resolve => setTimeout(resolve, 2_500));
      }
    }
  };
  // 轨迹帧登记键值由各截帧成功路径写入（见下方 pose0 与 pose1/2 循环）。
  try {
    const png = path.join(output, "native/native.png");
    await capturePoseFrame("v1-native", packagePath, png);
    nativeCell.screenshotPaths.push(path.relative(output, png));
    nativeTrajectoryFrames.set(0, path.relative(output, png));
    nativeCell.attempts.push({ label: "native-capture", ok: true });
  } catch (error) { nativeCell.attempts.push({ label: "native-capture", ok: false, error: String(error).slice(0, 400) }); }
  // ---------- 切片 5（Native 侧）：固定机位三帧等效 ----------
  // verify 脚本相机由 fixture 决定、不支持运行时动态轨迹：每机位一份冻结 fixture（pose1/2），
  // 独立 verify（哈希链 + GPU 干净证据）+ 一次实窗截帧，作为同参数轨迹的 Native 等效执行。
  // 该口径与 Web/WebView 的"同页面 evaluate 注入"不同字节（机位包 packageHash 不同），矩阵如实注明。
  for (const poseFixture of poseFixtures) {
    const posePackagePath = path.join(output, `fixture/pose${poseFixture.pose}/runtime-package.json`);
    const posePng = path.join(output, "native", `pose${poseFixture.pose}.png`);
    try {
      const poseVerify = await verifySceneNativeWindow({ packagePath: posePackagePath, nativeExecutable: executable, frames });
      await writeFile(path.join(output, "native", `pose${poseFixture.pose}-verify.json`), `${JSON.stringify(poseVerify, null, 2)}\n`);
      nativeCell.attempts.push({ label: `native-pose${poseFixture.pose}-verify`, ok: true });
      await capturePoseFrame(`v1-native-pose${poseFixture.pose}`, posePackagePath, posePng);
      nativeCell.screenshotPaths.push(path.relative(output, posePng));
      nativeTrajectoryFrames.set(poseFixture.pose, path.relative(output, posePng));
      nativeCell.attempts.push({ label: `native-pose${poseFixture.pose}-capture`, ok: true });
    } catch (error) { nativeCell.attempts.push({ label: `native-pose${poseFixture.pose}`, ok: false, error: String(error).slice(0, 400) }); }
  }
} catch (error) { nativeCell.attempts.push({ label: "deep-native", ok: false, error: String(error).slice(0, 400) }); }
console.log(`[native] loaded=${nativeCell.loaded} frames=${nativeCell.framesProduced} backend=${nativeCell.rendererBackend}`);

// ---------- 切片 2b：Three WebView 端（Tauri EXE 真实进程 + WebView2 CDP） ----------
const webviewCell: EndpointCell = { endpoint: "three-webview", loaded: false, rendererBackend: "", framesProduced: null, framesRequested: frames,
  screenshotPaths: [], gpuErrorsClean: null, packageHashMatch: null, consoleErrors: [], attempts: [], notes: [] };
const webviewBackends: Array<Record<string, unknown>> = [];
try {
  const candidates = [process.env.V1_WEBVIEW_EXE, path.join(repo, "test-output/batch-e-20260921-r2/a4-product-verify/three-webview-new.exe"),
    path.join(repo, "test-output/three-webview-branding-20260918/final/default.exe"), "D:/Download/666666.three-webview.exe"]
    .filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find(candidate => existsSync(candidate));
  if (!executable) throw new Error(`Three WebView EXE 均不存在，已试：${candidates.join(" ; ")}`);
  webviewCell.notes.push(`exe=${path.relative(repo, executable)}`, `exeSha256=${sha256(await readFile(executable)).slice(0, 16)}…`);
  // WebView2 经 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 开 CDP（batch-e a4 探针同口径）。
  const debugPort = await new Promise<number>((resolve, reject) => {
    const net = requireWeb("net") as typeof import("net");
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const address = probe.address() as { port: number }; probe.close(() => resolve(address.port)); });
    probe.on("error", reject);
  });
  const child = spawn(executable, [], { cwd: path.dirname(executable), windowsHide: false,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` },
    stdio: ["ignore", "ignore", "ignore"] });
  try {
    let browser: Awaited<ReturnType<typeof playwright.chromium.connectOverCDP>> | undefined;
    for (let attempt = 0; attempt < 60 && !browser; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try { browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); } catch { /* EXE 尚未就绪 */ }
    }
    if (!browser) throw new Error(`CDP ${debugPort} 连接失败（EXE 未开调试端口）`);
    const mainWebviewPage = browser.contexts().flatMap(context => context.pages()).find(page => !page.url().startsWith("devtools"));
    if (!mainWebviewPage) throw new Error("未找到 WebView 主页面 target");
    // 实窗启动取证：EXE 内嵌 publication（历史构建内容）≠ 冻结夹具——如实记录，不冒充同内容。
    await mainWebviewPage.waitForFunction(() => document.readyState === "complete", undefined, { timeout: 20_000 }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 3_000));
    await mainWebviewPage.screenshot({ path: path.join(output, "webview/launch.png") });
    webviewCell.notes.push("EXE 内嵌 publication 为历史构建内容，与本冻结夹具不同；EXE 级同内容重打包列为边界。");
    webviewCell.attempts.push({ label: "webview-launch", ok: true });
    // 同内容取证：同一 WebView2 真实进程内导航到同一 harness 页面，加载冻结包渲染 N 帧。
    for (const backend of ["webgl", "webgpu"] as const) {
      try {
        const run = await runBrowserBackend(mainWebviewPage, backend, "webview", "webview");
        webviewBackends.push({ backend, loaded: true, frames: run.result.frames,
          drawCallFrames: run.result.presentations.filter(p => (p.drawCalls ?? 0) > 0).length,
          packageHashMatch: run.packageHashMatch, screenshot: path.relative(output, run.screenshot),
          trajectory: { screenshots: run.trajectory.screenshots.map(shot => path.relative(output, shot)), errors: run.trajectory.errors },
          consoleErrors: run.consoleErrors, pageErrors: run.pageErrors, gpuErrorsClean: run.gpuErrorsClean,
          environmentProbe: run.result.environmentProbe });
        webviewCell.screenshotPaths.push(path.relative(output, run.screenshot));
        webviewCell.screenshotPaths.push(...run.trajectory.screenshots.slice(1).map(shot => path.relative(output, shot)));
        webviewCell.rendererBackend ||= `webview2-${run.result.backend}`;
        webviewCell.framesProduced = Math.max(webviewCell.framesProduced ?? 0, run.result.frames);
        webviewCell.packageHashMatch = webviewCell.packageHashMatch ?? run.packageHashMatch;
        webviewCell.gpuErrorsClean = webviewCell.gpuErrorsClean ?? run.gpuErrorsClean;
        if (!webviewCell.consoleErrors.length) webviewCell.consoleErrors = run.consoleErrors;
        webviewCell.attempts.push({ label: `webview-${backend}`, ok: true });
      } catch (error) { webviewCell.attempts.push({ label: `webview-${backend}`, ok: false, error: String(error).slice(0, 400) }); }
    }
    webviewCell.loaded = webviewBackends.length > 0;
    await browser.close();
  } finally {
    // taskkill 树杀：连 WebView2 子进程一起清理，避免用户数据目录锁残留（a4 探针同口径）。
    await new Promise(resolve => { const { execFile } = requireWeb("child_process") as typeof import("child_process");
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve()); });
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
} catch (error) { webviewCell.attempts.push({ label: "three-webview", ok: false, error: String(error).slice(0, 400) }); }
await writeFile(path.join(output, "webview/webview-result.json"), `${JSON.stringify({ endpoint: "three-webview", frames, backends: webviewBackends }, null, 2)}\n`);
console.log(`[webview] loaded=${webviewCell.loaded} backends=${webviewBackends.map(cell => cell.backend).join(",") || "none"}`);

await server.close();

// ---------- 切片 4/5：逐像素画质基线 + 输入轨迹对拍（数值全部脚本计算；第一版建立基线，不设达标线、不判胜负） ----------
const parityDir = path.join(output, "pixel-input-parity");
const FRAME_SIZE = { width: 960, height: 540 };

/** 读端帧为对拍基线灰度：统一重采样 960×540（WebView2 物理像素帧下采样属口径一部分）→ 灰度单通道 float64。 */
async function loadGrayFrame(relativePath: string): Promise<Float64Array> {
  const raw = await sharp(path.join(output, relativePath)).flatten({ background: "#000000" })
    .resize(FRAME_SIZE.width, FRAME_SIZE.height, { fit: "fill" }).grayscale().raw().toBuffer();
  return Float64Array.from(raw);
}

/** 单配对完整评估：原始分块 SSIM + 线性校准（归一化尝试）后 SSIM + 分块差异热图；两套数值并列落盘，不判定优劣。 */
async function evaluatePair(left: string, right: string, heatmapFile?: string) {
  const a = await loadGrayFrame(left);
  const b = await loadGrayFrame(right);
  const raw = computeBlockSsim(a, b, FRAME_SIZE.width, FRAME_SIZE.height);
  // 归一化方向：以右端（right）为参照，拟合 right ≈ a·left + b（a、b 随证据落盘，方向在 json 口径段注明）。
  const calibration = fitLinearCalibration(a, b);
  const normalized = computeBlockSsim(applyLinearCalibration(a, calibration.a, calibration.b), b, FRAME_SIZE.width, FRAME_SIZE.height);
  let heatmap: string | undefined;
  if (heatmapFile) {
    // 热图值 = 1 − clamp(SSIM)：越接近 1（越红/亮）表示该块结构差异越大；SSIM 负值按 0 差异上限处理。
    const divergence = raw.blocks.map(value => 1 - Math.max(-1, Math.min(1, value)));
    const rgb = buildBlockHeatmapRgb(divergence, 16, 9, FRAME_SIZE.width, FRAME_SIZE.height);
    await sharp(Buffer.from(rgb), { raw: { width: FRAME_SIZE.width, height: FRAME_SIZE.height, channels: 3 } })
      .png().toFile(path.join(parityDir, heatmapFile));
    heatmap = path.relative(output, path.join(parityDir, heatmapFile));
  }
  return { left, right, reference: right,
    ssim: { mean: raw.mean, min: raw.min, max: raw.max },
    calibration: { a: calibration.a, b: calibration.b, degenerate: calibration.degenerate },
    ssimAfterCalibration: { mean: normalized.mean, min: normalized.min, max: normalized.max }, heatmap };
}

// ---------- 切片 4：pose0（基线机位）逐像素对拍 ----------
// 帧清单只登记真实存在的帧：单端失败时缺帧如实记录，不虚构配对。
const allPose0Frames = [
  { key: "web-webgpu", relative: "web/web-webgpu.png" }, { key: "web-webgl", relative: "web/web-webgl.png" },
  { key: "webview-webgl", relative: "webview/webview-webgl.png" }, { key: "webview-webgpu", relative: "webview/webview-webgpu.png" },
  { key: "native", relative: "native/native.png" },
];
const pose0Frames = allPose0Frames.filter(frame => existsSync(path.join(output, frame.relative)));
// 配对集合：Web 每后端 vs Native；Web 每后端 vs WebView 同后端。其余组合（如 WebView vs Native）可由
// 同机位帧离线复算，第一版不展开，避免热图数量膨胀。
const pairSpecs: Array<{ left: string; right: string; heatmap: string }> = [];
for (const frame of pose0Frames.filter(f => f.key.startsWith("web-"))) {
  const native = pose0Frames.find(f => f.key === "native");
  if (native) pairSpecs.push({ left: frame.relative, right: native.relative, heatmap: `heatmap-${frame.key}-vs-native.png` });
  const webview = pose0Frames.find(f => f.key === `webview-${frame.key.slice(4)}`);
  if (webview) pairSpecs.push({ left: frame.relative, right: webview.relative, heatmap: `heatmap-${frame.key}-vs-${webview.key}.png` });
}
const pixelPairs: Array<Awaited<ReturnType<typeof evaluatePair>>> = [];
for (const spec of pairSpecs) pixelPairs.push(await evaluatePair(spec.left, spec.right, spec.heatmap));
const pixelParity = {
  schema: "deep-monkey.v1-pixel-parity", schemaVersion: 1, generatedAt: new Date().toISOString(),
  caliber: {
    metric: "分块 SSIM（均值/最小/最大），范围 [-1,1]，1 为逐块相同",
    blocks: "16×9=144 块，每块 60×60，不重叠；块内总体统计（等价均匀窗）", dynamicRange: "L=255，C1=(0.01·L)²，C2=(0.03·L)²",
    luma: "sharp .grayscale()（libvips b-w，sRGB 亮度系数 0.2126/0.7152/0.0722）",
    resample: "全部帧统一重采样 960×540（fit fill）；WebView2 物理像素帧（1500×844）下采样会吸收部分 AA/锐度差异，属本口径一部分",
    normalization: "线性校准归一化尝试（曝光/色调映射类系统性差异）：以配对右端为参照做全图最小二乘 right≈a·left+b，clamp[0,255] 后重算 SSIM；归一化前后两套数值并列，不宣称哪套更正确",
    threshold: "第一版不设达标线：数值为基线，不判胜负",
  },
  frames: Object.fromEntries(pose0Frames.map(f => [f.key, f.relative])),
  missingFrames: allPose0Frames.filter(f => !pose0Frames.includes(f)).map(f => f.key),
  pairs: pixelPairs,
};
await writeFile(path.join(parityDir, "pixel-parity.json"), `${JSON.stringify(pixelParity, null, 2)}\n`);
console.log(`[pixel-parity] pairs=${pixelPairs.length} ` +
  pixelPairs.map(pair => `${pair.left}~${pair.right}=${pair.ssim.mean.toFixed(4)}(校准后 ${pair.ssimAfterCalibration.mean.toFixed(4)})`).join(" "));

// ---------- 切片 5：输入轨迹对拍（yaw 三步确定性轨迹） ----------
/** 选端轨迹帧：优先取机位齐全的后端记录，否则取覆盖机位最多的记录；仍缺的机位如实记 null。 */
function pickTrajectoryFrames(records: Array<{ backend: string; screenshots: string[]; errors: string[] }>) {
  const chosen = records.find(record => record.screenshots.length >= TRAJECTORY_YAWS.length) ??
    [...records].sort((x, y) => y.screenshots.length - x.screenshots.length)[0];
  if (!chosen) return { backend: null as string | null, frames: TRAJECTORY_YAWS.map(() => null), errors: [] as string[] };
  return { backend: chosen.backend as string | null,
    frames: TRAJECTORY_YAWS.map((_, pose) => chosen.screenshots[pose] ?? null), errors: chosen.errors };
}
const webTrajectory = pickTrajectoryFrames(webBackends.map(record => ({
  backend: String(record.backend), screenshots: (record.trajectory as TrajectoryRun).screenshots.map(shot => String(shot)),
  errors: (record.trajectory as TrajectoryRun).errors })));
const webviewTrajectory = pickTrajectoryFrames(webviewBackends.map(record => ({
  backend: String(record.backend), screenshots: (record.trajectory as TrajectoryRun).screenshots.map(shot => String(shot)),
  errors: (record.trajectory as TrajectoryRun).errors })));
const nativeTrajectoryFramesList = TRAJECTORY_YAWS.map((_, pose) => nativeTrajectoryFrames.get(pose) ?? null);
const trajectoryPoses: Array<Record<string, unknown>> = [];
for (let pose = 0; pose < TRAJECTORY_YAWS.length; pose += 1) {
  const webFrame = webTrajectory.frames[pose] ?? null, webviewFrame = webviewTrajectory.frames[pose] ?? null,
    nativeFrame = nativeTrajectoryFramesList[pose] ?? null;
  const pairs: Array<Awaited<ReturnType<typeof evaluatePair>>> = [];
  // 同机位跨端相似度：与切片 4 完全同口径（含归一化尝试与热图）。
  if (webFrame && nativeFrame) pairs.push(await evaluatePair(webFrame, nativeFrame, `heatmap-trajectory-pose${pose}-web-vs-native.png`));
  if (webFrame && webviewFrame) pairs.push(await evaluatePair(webFrame, webviewFrame, `heatmap-trajectory-pose${pose}-web-vs-webview.png`));
  trajectoryPoses.push({ pose, yaw: TRAJECTORY_YAWS[pose], frames: { web: webFrame, webview: webviewFrame, native: nativeFrame }, pairs });
}
const trajectoryParity = {
  schema: "deep-monkey.v1-trajectory-parity", schemaVersion: 1, generatedAt: new Date().toISOString(),
  trajectory: { kind: "orbit", target: TRAJECTORY_TARGET, radius: TRAJECTORY_RADIUS, pitch: TRAJECTORY_PITCH, yawSteps: TRAJECTORY_YAWS,
    startPoseEqualsOriginalFixture: "yaw=atan2(3,5) 解析还原夹具原始机位 (3,2,5)，pose0 帧与逐像素基线共用" },
  executionModes: {
    web: "同页面 evaluate 注入 window.setCameraPose（与场景快照同一条 applyCamera 路径），逐机位截帧",
    webview: "同 web（同一 harness 页面、同一注入实现）",
    native: "固定机位三帧等效：每机位一份冻结 fixture（pose1/2 独立 packageId/packageHash）+ verify + 实窗截帧——verify 脚本相机由 fixture 决定、不支持运行时动态轨迹；机位包与 pose0 包不同 hash（场景内容与相机参数相同），如实注明不冒充同字节",
  },
  endpoints: { web: { backend: webTrajectory.backend, errors: webTrajectory.errors },
    webview: { backend: webviewTrajectory.backend, errors: webviewTrajectory.errors }, native: { backend: nativeCell.rendererBackend } },
  caliber: pixelParity.caliber,
  poses: trajectoryPoses,
};
await writeFile(path.join(parityDir, "trajectory-parity.json"), `${JSON.stringify(trajectoryParity, null, 2)}\n`);
console.log(`[trajectory-parity] poses=${trajectoryPoses.length} ` +
  trajectoryPoses.map(entry => `pose${entry.pose} pairs=${(entry.pairs as Array<{ ssim: { mean: number } }>).length}`).join(" "));

// ---------- 切片 3：能力矩阵（md + 机器可读 json）；逐像素/输入轨迹本轮起有基线数值 ----------
const cells = [webCell, webviewCell, nativeCell];
const evidenceEndpoints = cells.filter(cell => cell.screenshotPaths.length > 0 || (cell.framesProduced ?? 0) > 0).length;
const passed = evidenceEndpoints >= 2;
const matrix = {
  schema: "deep-monkey.v1-tri-endpoint-matrix", schemaVersion: 1, generatedAt: new Date().toISOString(),
  runner: "scripts/verify-v1-tri-endpoint-matrix.mts", framesRequested: frames, viteOrigin: origin,
  frozenFixture: fixtureMeta,
  gate: { requiredEndpointsWithFrameEvidence: 2, endpointsWithFrameEvidence: evidenceEndpoints, passed,
    pixelParityPairs: pixelPairs.length, trajectoryPoses: trajectoryPoses.length },
  endpoints: cells,
  pixelParity,
  trajectoryParity,
  boundary: "比较维度=加载/渲染/帧产出/无GPU错误 + 逐像素画质基线（分块 SSIM，线性校准归一化前后双数值）+" +
    "输入轨迹对拍（yaw 三步确定性轨迹；Native 为固定机位三帧等效口径）。逐像素/轨迹数值为第一版基线，" +
    "不设达标线、不判胜负；归一化仅是曝光/色调映射类系统性差异的校准尝试，两套数值并列不择一。" +
    "WebView 端同内容证据为 WebView2 真实进程渲染器级（EXE 内嵌 publication 未重打包）；" +
    "所有差异进 capability matrix，不用降画质掩盖。",
};
await writeFile(path.join(output, "capability-matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`);
const rows = cells.map(cell => {
  const failed = cell.attempts.filter(attempt => !attempt.ok);
  return `| ${cell.endpoint} | ${cell.loaded ? "是" : "否"} | ${cell.rendererBackend || "—"} | ${cell.framesProduced ?? "—"}/${cell.framesRequested} | ` +
    `${cell.screenshotPaths.join("<br>") || "—"} | ${cell.gpuErrorsClean === null ? "—" : cell.gpuErrorsClean ? "干净" : "有错误"} | ` +
    `${cell.packageHashMatch === null ? "—" : cell.packageHashMatch ? "一致" : "不一致"} | ` +
    `${(failed.map(attempt => `${attempt.label}: ${attempt.error ?? ""}`).join("<br>")).slice(0, 300) || "—"} |`;
}).join("\n");
const pixelRows = pixelPairs.map(pair =>
  `| ${pair.left} vs ${pair.right}（参照） | ${pair.ssim.mean.toFixed(4)}（min ${pair.ssim.min.toFixed(4)} / max ${pair.ssim.max.toFixed(4)}） | ` +
  `a=${pair.calibration.a.toFixed(4)}，b=${pair.calibration.b.toFixed(2)}${pair.calibration.degenerate ? "（参照帧零方差兜底）" : ""} | ` +
  `${pair.ssimAfterCalibration.mean.toFixed(4)} | ${pair.heatmap ?? "—"} |`).join("\n");
const trajectoryRows = trajectoryPoses.map(entry => {
  const frames = entry.frames as { web: string | null; webview: string | null; native: string | null };
  const pairs = entry.pairs as Array<{ right: string; ssim: { mean: number }; ssimAfterCalibration: { mean: number } }>;
  // 按配对右端（参照端 key）定位：evaluatePair 的 right 即 native/webview 帧的相对路径。
  const pairCell = (hint: "native" | "webview") => {
    const pair = pairs.find(candidate => candidate.right.includes(hint));
    return pair ? `${pair.ssim.mean.toFixed(4)} / ${pair.ssimAfterCalibration.mean.toFixed(4)}` : "—";
  };
  return `| pose${entry.pose}（yaw=${(entry.yaw as number).toFixed(4)} rad） | ${frames.web ?? "—"} | ${frames.webview ?? "—"} | ${frames.native ?? "—"} | ` +
    `${pairCell("native")} | ${pairCell("webview")} |`;
}).join("\n");
await writeFile(path.join(output, "capability-matrix.md"), `# V1 三端同内容对拍——能力矩阵\n\n` +
  `- runner：\`npx tsx scripts/verify-v1-tri-endpoint-matrix.mts [--output <dir>] [--frames N]\`（同命令复跑产出同结构证据）\n` +
  `- 冻结夹具：packageId=\`${fixtureMeta.packageId}\`，packageHash=\`${fixtureHash}\`，运行包 SHA-256=\`${fixtureMeta.runtimePackageSha256}\`（三端同字节）\n` +
  `- 门禁：≥2 端真实帧/截图证据 → **${passed ? "PASS" : "FAIL"}**（实测 ${evidenceEndpoints}/3 端）\n\n` +
  `| 端点 | 加载 | 渲染后端 | 帧产出 | 截图/帧证据 | GPU 错误 | 包 hash 一致 | 失败/已试 |\n|---|---|---|---|---|---|---|---|\n${rows}\n\n` +
  `## 逐像素画质基线（切片 4，pose0 同机位）\n\n` +
  `- 口径：分块 SSIM（16×9=144 块、每块 60×60 均匀窗、灰度=sRGB 亮度），全帧统一重采样 960×540；` +
  `线性校准=以参照端（配对右端）做全图最小二乘 right≈a·left+b 后重算。\n` +
  `- **第一版建立基线：不设达标线、不判胜负**；归一化前后两套数值并列，不择一。\n\n` +
  `| 配对（left vs 参照） | 分块 SSIM（原始） | 线性校准 a/b | SSIM（校准后） | 差异热图 |\n|---|---|---|---|---|\n${pixelRows}\n\n` +
  `## 输入轨迹对拍（切片 5，确定性轨迹：yaw ${TRAJECTORY_YAWS.map(yaw => yaw.toFixed(4)).join(" → ")} rad，pitch/radius 固定）\n\n` +
  `- 执行方式：Web/WebView=同页面 evaluate 注入同参数（applyCamera 同一路径）；` +
  `Native=固定机位三帧等效（每机位一份冻结 fixture + verify + 实窗截帧；verify 脚本相机由 fixture 决定，不支持运行时动态轨迹——机位包与 pose0 包不同 hash，如实注明）。\n` +
  `- 相似度单元格格式：SSIM（原始） / SSIM（校准后）；缺帧如实记 —。\n\n` +
  `| 机位 | Web 帧 | WebView 帧 | Native 帧 | Web vs Native | Web vs WebView |\n|---|---|---|---|---|---|\n${trajectoryRows}\n\n` +
  `## 诚实边界\n\n` +
  `- 逐像素画质基线与输入轨迹对拍：第一版已产出数值，但定位是**建立基线**——不设达标线、不下胜负结论；` +
  `归一化仅是曝光/色调映射类系统性差异的线性校准尝试，校准参数（a/b）与两套数值随证据落盘。\n` +
  `- Native 轨迹为固定机位三帧等效（verify 脚本相机由 fixture 决定）：机位包与 pose0 包字节不同（独立 packageHash），` +
  `场景内容与相机参数相同；不冒充同字节同内容。\n` +
  `- Three WebView：EXE 内嵌 publication 为历史构建内容，本轮同内容证据为 WebView2 真实进程渲染器级（CDP 导航到同一 harness 页）；EXE 级同内容需重打包，列为后续动作。\n` +
  `- 各端失败明细见 capability-matrix.json 的 endpoints[].attempts 与 pixel-input-parity/*.json（含已试路径与失败原因）。\n`);
console.log(`[matrix] ${passed ? "PASS" : "FAIL"} evidenceEndpoints=${evidenceEndpoints}/3 → ${path.join(output, "capability-matrix.md")}`);
if (!passed) process.exitCode = 1;
