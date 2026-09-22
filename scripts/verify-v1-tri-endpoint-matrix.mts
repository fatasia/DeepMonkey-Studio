// V1 三端同内容对拍统一 runner：同一冻结 box 场景（同 packageId/packageHash/文件 SHA-256），
// 分别由 Web headless Chrome、Three WebView（Tauri EXE 内 WebView2 真实进程）、Deep Native
// （wgpu 真实窗口）加载并渲染 N 帧，逐端留截图/帧证据，最后落能力矩阵（md + 机器可读 json）。
// 复用骨架：verify-gi-crossend-matrix.mts（vite+playwright 取证口径）、verify-scene-native-window.mjs
// （Native 实窗哈希链验证）、test-output/v2-native-release-20260923/build-minimal-fixture.mts（夹具）。
// 第一版比较维度从简：加载 / 渲染 / 帧产出 / 无 GPU 错误；逐像素画质比较显式列为边界，不做。
// 每端独立可失败：单端异常不阻断其余端，矩阵如实记录失败与已试命令。
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

for (const dir of ["web", "webview", "native"]) await rm(path.join(output, dir), { recursive: true, force: true });
for (const dir of ["fixture", "web", "webview", "native"]) await mkdir(path.join(output, dir), { recursive: true });

// ---------- 切片 1：冻结场景 fixture（V2 最小 box 场景同族，三端消费同一运行包字节） ----------
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
console.log(`[fixture] packageId=${fixtureMeta.packageId} hash=${fixtureHash} bytes=${fixtureMeta.runtimePackageBytes}`);

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
interface BrowserRun {
  result: { backend: string; frames: number; packageHash: string; presentations: Array<{ drawCalls: number | null }>; environmentProbe: unknown };
  consoleErrors: string[]; pageErrors: string[]; gpuErrorsClean: boolean; screenshot: string; packageHashMatch: boolean;
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
  return { result, consoleErrors, pageErrors, gpuErrorsClean, screenshot, packageHashMatch: result.packageHash === fixtureHash };
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
        consoleErrors: run.consoleErrors, pageErrors: run.pageErrors, gpuErrorsClean: run.gpuErrorsClean,
        environmentProbe: run.result.environmentProbe });
      webCell.screenshotPaths.push(path.relative(output, run.screenshot));
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
  // 实窗截帧：PrintWindow 读回真实窗口（gi-crossend-matrix 同口径）。
  try {
    const capture = await captureNativePlayerWindow({ label: "v1-native", executable, args: ["--package", packagePath],
      outputDirectory: path.join(output, "native"), clientSize: [960, 540],
      presentedMarker: "native package recovery checkpoint committed after present", timeoutMs: 60_000 });
    await writeFile(path.join(output, "native/native-capture.log"), capture.captureLog);
    const match = /client=(\d+)x(\d+) dpi=\d+ clientOffset=(\d+),(\d+)/.exec(capture.captureLog);
    if (!match) throw new Error(`captureLog 缺少 client 几何：${capture.captureLog.slice(0, 200)}`);
    const [w, h, left, top] = match.slice(1).map(Number) as [number, number, number, number];
    const png = path.join(output, "native/native.png");
    await sharp(capture.png).extract({ left, top, width: w, height: h }).resize(960, 540, { fit: "fill" }).png().toFile(png);
    nativeCell.screenshotPaths.push(path.relative(output, png));
    nativeCell.attempts.push({ label: "native-capture", ok: true });
  } catch (error) { nativeCell.attempts.push({ label: "native-capture", ok: false, error: String(error).slice(0, 400) }); }
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
          consoleErrors: run.consoleErrors, pageErrors: run.pageErrors, gpuErrorsClean: run.gpuErrorsClean,
          environmentProbe: run.result.environmentProbe });
        webviewCell.screenshotPaths.push(path.relative(output, run.screenshot));
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

// ---------- 切片 3：能力矩阵（md + 机器可读 json）；第一版维度从简，逐像素比较显式不做 ----------
const cells = [webCell, webviewCell, nativeCell];
const evidenceEndpoints = cells.filter(cell => cell.screenshotPaths.length > 0 || (cell.framesProduced ?? 0) > 0).length;
const passed = evidenceEndpoints >= 2;
const matrix = {
  schema: "deep-monkey.v1-tri-endpoint-matrix", schemaVersion: 1, generatedAt: new Date().toISOString(),
  runner: "scripts/verify-v1-tri-endpoint-matrix.mts", framesRequested: frames, viteOrigin: origin,
  frozenFixture: fixtureMeta,
  gate: { requiredEndpointsWithFrameEvidence: 2, endpointsWithFrameEvidence: evidenceEndpoints, passed },
  endpoints: cells,
  boundary: "第一版比较维度=加载/渲染/帧产出/无GPU错误；逐像素画质比较与输入轨迹对拍显式不做（列边界）。" +
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
await writeFile(path.join(output, "capability-matrix.md"), `# V1 三端同内容对拍——能力矩阵\n\n` +
  `- runner：\`npx tsx scripts/verify-v1-tri-endpoint-matrix.mts [--output <dir>] [--frames N]\`（同命令复跑产出同结构证据）\n` +
  `- 冻结夹具：packageId=\`${fixtureMeta.packageId}\`，packageHash=\`${fixtureHash}\`，运行包 SHA-256=\`${fixtureMeta.runtimePackageSha256}\`（三端同字节）\n` +
  `- 门禁：≥2 端真实帧/截图证据 → **${passed ? "PASS" : "FAIL"}**（实测 ${evidenceEndpoints}/3 端）\n\n` +
  `| 端点 | 加载 | 渲染后端 | 帧产出 | 截图/帧证据 | GPU 错误 | 包 hash 一致 | 失败/已试 |\n|---|---|---|---|---|---|---|---|\n${rows}\n\n` +
  `## 诚实边界\n\n- 逐像素画质比较与输入轨迹对拍：第一版不做（显式边界，非结论）。\n` +
  `- Three WebView：EXE 内嵌 publication 为历史构建内容，本轮同内容证据为 WebView2 真实进程渲染器级（CDP 导航到同一 harness 页）；EXE 级同内容需重打包，列为后续动作。\n` +
  `- 各端失败明细见 capability-matrix.json 的 endpoints[].attempts（含已试路径与失败原因）。\n`);
console.log(`[matrix] ${passed ? "PASS" : "FAIL"} evidenceEndpoints=${evidenceEndpoints}/3 → ${path.join(output, "capability-matrix.md")}`);
if (!passed) process.exitCode = 1;
