// V3 Unity WebGL 本机导出 + 托管端到端 runner：
//   1) 消费 run-v3-webgl-build.ps1 的真实 Unity WebGL 构建产物（build/WebGL + bim-studio-webgl.zip）；
//   2) ZIP → 解压目录逐文件 SHA-256 对拍（发布产物合同）；
//   3) Node 静态服务器按 bridge 合同托管（.wasm MIME / CORS）；
//   4) headless Chrome（playwright-core）加载 Deep Web 宿主页（复用产品 unityBridge.ts 合同），
//      断言真实 Unity WASM Player 启动；五项（加载/材质/输入/资源/发布）能验几项验几项，逐项留证。
// 用法：npx tsx scripts/verify-v3-unity-webgl-e2e.mts [--build-root <dir>] [--output <dir>]
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import playwright from "../apps/cloud-render-worker/node_modules/playwright-core/index.js";

const repo = path.resolve(import.meta.dirname, "..");
const requireWeb = createRequire(path.join(repo, "apps/web/package.json"));
const sharp = requireWeb("sharp") as typeof import("sharp");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const args = process.argv.slice(2);
const argValue = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const buildRoot = path.resolve(argValue("--build-root") ?? path.join(repo, "test-output/v3-unity-webgl-20260923"));
const output = path.resolve(argValue("--output") ?? buildRoot);
const sha256 = (bytes: Uint8Array | Buffer) => createHash("sha256").update(bytes).digest("hex");
const buildDir = path.join(buildRoot, "build/WebGL");
const zipPath = path.join(buildRoot, "build/bim-studio-webgl.zip");
if (!existsSync(buildDir)) throw new Error(`构建产物不存在：${buildDir}（先跑 tools/unity/v3-webgl-e2e/run-v3-webgl-build.ps1）`);
if (!existsSync(zipPath)) throw new Error(`ZIP 不存在：${zipPath}`);

await rm(path.join(output, "publish-unzip"), { recursive: true, force: true });
for (const dir of ["publish-unzip", "screenshots"]) await mkdir(path.join(output, dir), { recursive: true });

const buildSummary = existsSync(path.join(buildRoot, "build-summary.json"))
  ? JSON.parse(await readFile(path.join(buildRoot, "build-summary.json"), "utf8"))
  : {};
const manifestRaw = await readFile(path.join(buildDir, "bim-studio.manifest.json"), "utf8");
const manifestJson = JSON.parse(manifestRaw);
const indexHtml = await readFile(path.join(buildDir, "index.html"), "utf8");
const bridgeInjected = indexHtml.includes("unity-bridge.js") && indexHtml.includes("BimStudioUnityBridge.register")
  && indexHtml.includes("BimStudioUnityBridge.createTrackedInstance");

// ---------- 切片 A：发布产物合同 —— ZIP 解压与构建目录逐文件 SHA-256 对拍 ----------
const unzip = spawnSync("pwsh", ["-NoProfile", "-Command",
  `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${path.join(output, "publish-unzip")}' -Force`],
  { encoding: "utf8" });
const zipExtracted = unzip.status === 0;
const zipFiles: string[] = [];
const fileHashes = new Map<string, string>();
async function collectHashes(root: string, relative = "") {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collectHashes(path.join(root, entry.name), relativePath);
    else {
      zipFiles.push(relativePath);
      fileHashes.set(relativePath, sha256(await readFile(path.join(root, entry.name))));
    }
  }
}
let zipByteIdentical = false;
if (zipExtracted) {
  await collectHashes(buildDir);
  const unzipped = new Map<string, string>();
  let identical = true;
  for (const relative of zipFiles) {
    unzipped.set(relative, sha256(await readFile(path.join(output, "publish-unzip", relative))));
    if (unzipped.get(relative) !== fileHashes.get(relative)) identical = false;
  }
  const unzippedFiles = [...unzipped.keys()].sort();
  zipByteIdentical = identical && unzippedFiles.join(",") === [...fileHashes.keys()].sort().join(",");
}

// ---------- 切片 B：托管链 —— 静态服务器按 bridge 合同服务（.wasm MIME + CORS） ----------
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json",
  ".wasm": "application/wasm", ".data": "application/octet-stream", ".css": "text/css", ".png": "image/png",
};
const staticServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const file = path.join(buildDir, relative);
  if (!file.startsWith(buildDir) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": mimeTypes[path.extname(file)] ?? "application/octet-stream",
    "access-control-allow-origin": "*",
  });
  createReadStream(file).pipe(response);
});
await new Promise<void>((resolveReady) => staticServer.listen(0, "127.0.0.1", resolveReady));
const staticAddress = staticServer.address();
if (!staticAddress || typeof staticAddress === "string") throw new Error("静态托管服务器启动失败");
const staticOrigin = `http://127.0.0.1:${staticAddress.port}`;

// ---------- 切片 C：Deep Web 宿主（vite dev server，v1-tri 同口径） ----------
const { createServer: createViteServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
const vite = await createViteServer({ root: path.join(repo, "apps/web"), configFile: false, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await vite.listen();
const hostOrigin = vite.resolvedUrls!.local[0];

// ---------- 切片 D：headless Chrome 端到端 ----------
interface Check { pass: boolean; details: Record<string, unknown> }
const checks: Record<string, Check> = {};
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
let chromeVersion = "";
let hostUrl = "";
if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true });
try {
  chromeVersion = browser.version();
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300)); });
  page.on("pageerror", error => pageErrors.push(`pageerror: ${String(error).slice(0, 300)}`));
  hostUrl = `${hostOrigin}scripts/v3-unity-e2e.html?manifest=${encodeURIComponent(`${staticOrigin}/bim-studio.manifest.json`)}`;
  await page.goto(hostUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // Unity WASM 编译 + Player 启动预算 150s（宿主页 finished 在 ready + init/ping/action 交互后置位）。
  await page.waitForFunction(() => (window as { __v3?: { failure?: string; finished?: boolean } }).__v3?.failure
    || (window as { __v3?: { finished?: boolean } }).__v3?.finished, undefined, { timeout: 150_000 });
  const state = await page.evaluate(() => (window as { __v3?: unknown }).__v3) as Record<string, any>;
  if (state.failure) throw new Error(`宿主页失败：${state.failure}`);

  const runtimeFiles = [...fileHashes.entries()].map(([file, hash]) => ({ file, hash }));
  const loader = runtimeFiles.find(item => item.file.endsWith(".loader.js"));
  const framework = runtimeFiles.find(item => item.file.includes(".framework.js"));
  const wasm = runtimeFiles.find(item => item.file.endsWith(".wasm"));
  const data = runtimeFiles.find(item => item.file.endsWith(".data"));
  const wasmBytes = wasm ? (await stat(path.join(buildDir, wasm.file))).size : 0;

  // 五项之一【加载】：manifest 合同解析 + 真实进度序列 + ready + iframe 内 canvas。
  const canvasFrame = page.frameLocator("iframe");
  const canvasBoxRect = await canvasFrame.locator("canvas").boundingBox().catch(() => null);
  checks.load = {
    pass: state.ready === true && state.progress.length > 0 && state.progress.at(-1) === 1 && canvasBoxRect !== null,
    details: {
      progressSequence: state.progress, ready: state.ready, bridgeInjected, manifestParsed: Boolean(state.manifest),
      loaderFile: loader?.file, frameworkFile: framework?.file, wasmFile: wasm?.file, dataFile: data?.file, wasmBytes,
      iframeCanvasDetected: canvasBoxRect !== null, canvasBox: canvasBoxRect,
    },
  };
  // 交互完成后等待 Unity 个人版强制闪屏（MADE WITH Unity）淡出，再取真实场景渲染帧。
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: path.join(output, "screenshots/01-host-iframe-player.png"), fullPage: true });
  const iframeShot = path.join(output, "screenshots/02-unity-canvas.png");
  await page.locator("iframe").screenshot({ path: iframeShot });

  // 五项之二【材质】：真实渲染输出 —— 立方体探针红像素 + 多色方差（SwiftShader WebGL 真实光栅化）。
  const image = sharp(iframeShot);
  const { width, height } = await image.metadata().then(meta => ({ width: meta.width ?? 0, height: meta.height ?? 0 }));
  const pixels = new Uint8Array(await image.raw().toBuffer());
  let redPixels = 0, backgroundPixels = 0;
  const colorSet = new Set<string>();
  for (let offset = 0; offset + 2 < pixels.length; offset += 3) {
    const [r, g, b] = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
    if (r > 140 && r > g + 45 && r > b + 45) redPixels += 1;
    if (r < 70 && g < 90 && b < 110 && b >= g && g >= r) backgroundPixels += 1;
    if (colorSet.size < 4096) colorSet.add(`${r >> 4},${g >> 4},${b >> 4}`);
  }
  const total = width * height;
  // Unlit/Color 无光照 + 纯色背景 = 确定性双色光栅化（红立方体 + 深青背景）；
  // 判定 = 红色像素显著存在（>0.5%）且未吞没画面（<90%），即真实几何被光栅化而非空场/闪屏。
  checks.material = {
    pass: redPixels > total * 0.005 && redPixels < total * 0.9 && colorSet.size >= 2,
    details: {
      screenshot: path.relative(output, iframeShot), width, height, sampledPixels: total,
      redPixelRatio: Number((redPixels / total).toFixed(5)), backgroundPixelRatio: Number((backgroundPixels / total).toFixed(5)),
      uniqueColorBuckets: colorSet.size,
      note: "探针立方体 = Unlit/Color 红(0.86,0.28,0.22)，背景深青 SolidColor；红色像素占比 0.5%~90% 且 ≥2 色彩桶 = 真实几何光栅化（无光照 Unlit 下干净双色即确定性证据）。",
      splashHandling: "Unity 个人许可强制闪屏（MADE WITH Unity）；ready + 消息交互完成后等待 6s 闪屏淡出再取场景帧。",
    },
  };

  // 五项之三【输入】：host→Unity 消息链 —— init/ping/action 全部被 Unity 主线程 ack；ping 回 health。
  const sentTypes = (state.sent as Array<{ type: string }>).map(item => item.type);
  const ackTypes = (state.acks as Array<{ messageType: string }>).map(item => item.messageType);
  const hasAck = (type: string) => ackTypes.includes(type);
  checks.input = {
    pass: hasAck("init") && hasAck("ping") && hasAck("action") && Number(state.health?.fps ?? 0) > 0,
    details: {
      sentTypes, ackTypes, ackLatencyTracked: state.acks.length,
      health: state.health,
      note: "输入链 = 宿主 postMessage → iframe bridge → Unity C# ApplyStudioMessage → BimStudioEvents.Ack/Health（jslib）→ 宿主；真实 Unity 主线程往返。",
    },
  };

  // 五项之四【资源】：build manifest 资源清单（场景/事件/动作/数据层/业务对象）与解析、下发一致。
  const manifest = state.manifest ?? {};
  checks.resources = {
    pass: Array.isArray(manifest.scenes) && manifest.scenes.includes("V3Probe")
      && (manifest.events ?? []).includes("device-click") && (manifest.actions ?? []).includes("focus")
      && (manifest.dataLayers ?? []).some((layer: { key?: string }) => layer.key === "telemetry")
      && typeof manifest.objects?.[0]?.id === "string" && hasAck("init"),
    details: {
      unityVersion: manifest.unityVersion, bridgeVersion: manifest.bridgeVersion, bridgePackageVersion: manifest.bridgePackageVersion,
      scenes: manifest.scenes, events: manifest.events, actions: manifest.actions,
      dataLayers: manifest.dataLayers, objects: manifest.objects, runtimeCapabilities: manifest.runtimeCapabilities,
      manifestUrl: `${staticOrigin}/bim-studio.manifest.json`,
    },
  };
} catch (error) {
  const reason = String(error instanceof Error ? error.message : error).slice(0, 600);
  if (!checks.load) checks.load = { pass: false, details: { error: reason } };
  consoleErrors.push(`runner: ${reason}`);
  try {
    const page = (await browser.contexts()[0]?.pages()[0]);
    await page?.screenshot({ path: path.join(output, "screenshots/00-failure.png"), fullPage: true });
  } catch { /* 截图尽力而为 */ }
} finally {
  await browser.close();
}

// 五项之五【发布】：ZIP 产物 → 解压目录逐字节一致 + playerUrl HTTP 可达（托管发布合同）。
let playerUrlReachable = false;
try {
  playerUrlReachable = (await fetch(`${staticOrigin}/index.html`)).status === 200;
} catch { /* 留 false */ }
checks.publish = {
  pass: zipExtracted && zipByteIdentical && playerUrlReachable,
  details: {
    zipPath: path.relative(repo, zipPath), zipBytes: buildSummary.checks?.zipBytes ?? null,
    zipSha256: buildSummary.checks?.zipSha256 ?? null, zipExtracted, zipByteIdentical,
    fileCount: zipFiles.length, playerUrlReachable,
    boundary: "产品控制台 ZIP 上传/发布记录落库链路不在本轮 headless 范围，列为诚实边界；本轮验证 ZIP→托管→可加载的发布产物合同。",
  },
};

await staticServer.close();
// vite.close 在部分版本下回调不可靠，加超时护栏避免 runner 挂死。
await Promise.race([
  Promise.resolve(vite.close()).then(() => undefined),
  new Promise(resolve => setTimeout(resolve, 5_000)),
]);

// ---------- 证据落盘 ----------
const allPass = Object.values(checks).every(check => check.pass);
const matrix = {
  schemaVersion: "deep-monkey.v3-unity-webgl-e2e.v1",
  generatedAt: new Date().toISOString(),
  verdict: allPass ? "PASS" : "PARTIAL",
  environment: {
    editor: buildSummary.editor ?? "D:\\Soft\\Unity\\6000.0.52f1\\Editor\\Unity.exe",
    editorVersion: buildSummary.editorVersion ?? "6000.0.52f1",
    webGlModule: buildSummary.webGlModule ?? "D:\\Soft\\Unity\\6000.0.52f1\\Editor\\Data\\PlaybackEngines\\WebGLSupport",
    chromeVersion, hostOrigin, staticOrigin, hostUrl,
    buildElapsedSeconds: buildSummary.elapsedSeconds ?? null,
    compression: "uncompressed（构建脚本显式 EditorUserBuildSettings.webGLCompressionFormat = Uncompressed）",
  },
  checks,
  consoleErrors, pageErrors,
  boundaries: [
    "输入验证为 bridge 消息链真实往返（Unity 主线程 ack/health），未含鼠标/键盘像素级交互轨迹。",
    "发布验证为 ZIP→托管→playerUrl 可达的产物合同；产品控制台 ZIP 上传与发布记录落库链路未在本轮覆盖。",
    "渲染经 headless Chrome SwiftShader；GPU 硬件光栅化表现未在本轮声明。",
    "Unity 构建压缩格式显式取 Uncompressed；brotli/gzip 托管需 Content-Encoding 协商，未在本轮覆盖。",
  ],
};
await writeFile(path.join(output, "e2e-result.json"), `${JSON.stringify(matrix, null, 2)}\n`);
const lines = [
  "# V3 Unity WebGL 本机导出 + 托管端到端 —— 五项矩阵", "",
  `- 结论：**${matrix.verdict}**（${Object.entries(checks).filter(([, check]) => check.pass).length}/5 项通过）`,
  `- Unity：${matrix.environment.editorVersion}（WebGL 模块：${matrix.environment.webGlModule}），构建耗时 ${matrix.environment.buildElapsedSeconds ?? "?"}s`,
  `- Chrome：${chromeVersion}（headless）；宿主 ${hostOrigin}；托管 ${staticOrigin}`, "",
  "| 项 | 结果 | 证据要点 |", "|---|---|---|",
  ...Object.entries(checks).map(([name, check]) => `| ${name} | ${check.pass ? "PASS" : "FAIL"} | ${JSON.stringify(check.details).slice(0, 160)}… |`), "",
  "## 诚实边界", ...matrix.boundaries.map(item => `- ${item}`), "",
];
await writeFile(path.join(output, "capability-matrix.md"), lines.join("\n"));
console.log(`[v3-e2e] verdict=${matrix.verdict} ${Object.entries(checks).map(([name, check]) => `${name}=${check.pass ? "PASS" : "FAIL"}`).join(" ")}`);
console.log(`[v3-e2e] 证据：${output}`);
if (!allPass) process.exitCode = 2;
