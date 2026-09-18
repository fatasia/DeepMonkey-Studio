// GI 跨端阈值矩阵:同一烘焙 GLB、同机位/曝光/照明下,真实 Chrome WebGPU 与 Native 读回成对采图并统计。
// 复用 verify-native-baked-gi.mts 的 Native 编译与捕获,以及 p08 的 Chrome WebGPU 启动口径与相似度统计。
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import playwright from "../apps/cloud-render-worker/node_modules/playwright-core/index.js";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { compileNativeSceneCandidate } from "../apps/api/src/nativeSceneCandidateCompiler.js";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const requireWeb = createRequire(path.join(repo, "apps/web/package.json"));
const sharp = requireWeb("sharp") as typeof import("sharp");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sourceExe = process.env.DEEP_GI_EXE
  ?? path.join(repo, "test-output/native-baked-gi-20260918/verified-player.exe");
const glbDir = path.join(repo, "test-output/lightmap-gi-20260918");
const output = path.join(repo, "test-output/gi-crossend-matrix-20260918");
await mkdir(output, { recursive: true });
const { compareImageFiles } = await import(pathToFileURL(path.join(repo, "apps/web/scripts/renderImageSimilarity.mjs")).href);

const scene: SceneSnapshot = { schemaVersion: 1, id: "baked-gi", projectId: "default", name: "Native baked GI", createdAt: "", updatedAt: "",
  models: [{ modelId: "room", assetModelId: "room", name: "Baked room", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
  primitives: [], measurements: [],
  camera: { mode: "orbit", position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 1.5, z: 0 } },
  environment: { skybox: "none", gridVisible: false, backgroundColor: "#172126" },
  lighting: { enabled: true, intensity: 1, shadowsEnabled: false, reflectionsEnabled: false, globalIlluminationEnabled: false,
    lights: [{ id: "sun", name: "Sun", type: "directional", enabled: true, color: "#ffffff", intensity: 0, position: { x: 5, y: 5, z: 5 }, target: { x: 0, y: 0, z: 0 }, castShadow: false },
      { id: "reference", name: "Fixed reference light", type: "point", enabled: true, color: "#ffffff", intensity: 2, position: { x: 1, y: 4, z: 3 }, distance: 20, decay: 2, castShadow: false }] } };

// ---------- Native 侧:同 GI GLB 编译进运行包并读回窗口 ----------
const executable = path.join(output, "verified-player.exe");
await copyFile(path.resolve(sourceExe), executable);
const nativeCells: Record<string, string> = {};
for (const kind of ["on", "off"] as const) {
  const source = await readFile(path.join(glbDir, `round-1-gi-${kind}.glb`));
  const compiled = await compileNativeSceneCandidate({ scene, models: new Map([["room", source]]) });
  const file = path.join(output, `native-${kind}.runtime.json`);
  await writeFile(file, compiled.packageJson);
  const capture = await captureNativePlayerWindow({ label: `gi-${kind}`, executable, args: ["--package", file],
    outputDirectory: output, clientSize: [960, 540],
    presentedMarker: "native package recovery checkpoint committed after present", timeoutMs: 60000 });
  const match = /client=(\d+)x(\d+) dpi=\d+ clientOffset=(\d+),(\d+)/.exec(capture.captureLog);
  assert(match, capture.captureLog);
  const [w, h, left, top] = match.slice(1).map(Number) as [number, number, number, number];
  const png = path.join(output, `native-${kind}.png`);
  await sharp(capture.png).extract({ left, top, width: w, height: h }).resize(960, 540, { fit: "fill" }).png().toFile(png);
  nativeCells[kind] = png;
}

// ---------- Web 侧:真实 Chrome WebGPU 渲染同一 GLB ----------
const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
const server = await createServer({ root: path.join(repo, "apps/web"), configFile: false,
  server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server.listen();
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"] });
const webCells: Record<string, string> = {};
try {
  for (const kind of ["on", "off"] as const) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    const glb = await readFile(path.join(glbDir, `round-1-gi-${kind}.glb`));
    await page.addInitScript(base64 => { (window as { glbBase64: string }).glbBase64 = base64; }, glb.toString("base64"));
    await page.goto(`${server.resolvedUrls.local[0]}scripts/gi-crossend.html`);
    await page.waitForFunction(() => (window as { result?: unknown; failure?: string }).result || (window as { failure?: string }).failure, undefined, { timeout: 60000 });
    const failure = await page.evaluate(() => (window as { failure?: string }).failure);
    assert(!failure, `Web ${kind} failed: ${failure}`);
    const canvas = page.locator("canvas");
    const shot = path.join(output, `web-${kind}.raw.png`);
    await canvas.screenshot({ path: shot });
    const png = path.join(output, `web-${kind}.png`);
    await sharp(shot).resize(960, 540, { fit: "fill" }).png().toFile(png);
    webCells[kind] = png;
    await page.close();
  }
} finally { await browser.close(); await server.close(); }

// ---------- 成对统计 ----------
const cells = [];
for (const kind of ["on", "off"] as const) {
  const metrics = await compareImageFiles(webCells[kind]!, nativeCells[kind]!, `web-${kind}`, `native-${kind}`,
    { differencePath: path.join(output, `diff-${kind}.png`) });
  const metaA = await sharp(webCells[kind]!).metadata(), metaB = await sharp(nativeCells[kind]!).metadata();
  cells.push({ kind, web: `${metaA.width}x${metaA.height}`, native: `${metaB.width}x${metaB.height}`, metrics });
  console.log(kind, JSON.stringify(metrics));
}
const matrix = { generatedAt: new Date().toISOString(), sourceGlb: "round-1-gi-{on,off}.glb (sha in lightmap evidence)",
  camera: "fov 25, direction (6,4,7), center (0,1.5,0), fit 1.05, ACES, sun 2@(5,5,5)",
  thresholds: "建议沿用 p08 口径:SSIM≥0.970 / changed≤3.01%;烘焙噪声导致的平坦区差异按 expected 标注,结构性缺失另行阻断",
  cells, boundary: "Web=真实 Chrome WebGPU(three.webgpu);Native=窗口 PrintWindow 读回;烘焙噪声明细见 lightmap-single-bounce spec" };
await writeFile(path.join(output, "matrix.json"), JSON.stringify(matrix, null, 2));
console.log("GI cross-end matrix written:", path.join(output, "matrix.json"));
