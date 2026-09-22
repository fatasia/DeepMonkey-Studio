// GI 跨端阈值矩阵:同一烘焙 GLB、同机位/曝光/照明下,真实 Chrome WebGPU 与 Native 读回成对采图并统计。
// 复用 verify-native-baked-gi.mts 的 Native 编译与捕获,以及 p08 的 Chrome WebGPU 启动口径与相似度统计。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const [exeArg, glbDirArg, outputArg] = process.argv.slice(2);
const sourceExe = path.resolve(exeArg ?? process.env.DEEP_GI_EXE
  ?? path.join(repo, "test-output/native-baked-gi-20260918/verified-player.exe"));
const glbDir = path.resolve(glbDirArg ?? process.env.DEEP_GI_GLB_DIR ?? path.join(repo, "test-output/lightmap-gi-20260918"));
const output = path.resolve(outputArg ?? process.env.DEEP_GI_OUTPUT ?? path.join(repo, "test-output/gi-crossend-matrix-20260918"));
await mkdir(output, { recursive: true });
const { compareImageFiles } = await import(pathToFileURL(path.join(repo, "apps/web/scripts/renderImageSimilarity.mjs")).href);

const radius = Math.hypot(3, 1.5, 3);
const normal = Math.hypot(6, 4, 7);
const distance = radius / Math.sin(50 * Math.PI / 180) * 1.05;
const cameraPosition = { x: 6 * distance / normal, y: 1.5 + 4 * distance / normal, z: 7 * distance / normal };

const scene: SceneSnapshot = { schemaVersion: 1, id: "baked-gi", projectId: "default", name: "Native baked GI", createdAt: "", updatedAt: "",
  models: [{ modelId: "room", assetModelId: "room", name: "Baked room", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
  primitives: [], measurements: [],
  // Keep the Native payload on the exact same orbit as the Web host. A zero
  // placeholder here renders only a sliver at the near plane and invalidates
  // every cross-end metric while still producing a superficially valid frame.
  camera: { mode: "orbit", position: cameraPosition, target: { x: 0, y: 1.5, z: 0 } },
  environment: { skybox: "none", gridVisible: false, backgroundColor: "#172126" },
  lighting: { enabled: true, intensity: 1, shadowsEnabled: false, reflectionsEnabled: false, globalIlluminationEnabled: false,
    lights: [{ id: "sun", name: "Sun", type: "directional", enabled: true, color: "#ffffff", intensity: 0, position: { x: 5, y: 5, z: 5 }, target: { x: 0, y: 0, z: 0 }, castShadow: false },
      { id: "reference", name: "Fixed reference light", type: "point", enabled: true, color: "#ffffff", intensity: 2, position: { x: 1, y: 4, z: 3 }, distance: 20, decay: 2, castShadow: false }] } };

// ---------- Native 侧:同 GI GLB 编译进运行包并读回窗口 ----------
const executable = path.join(output, "verified-player.exe");
if (path.resolve(sourceExe) !== executable) await copyFile(sourceExe, executable);
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
  const exposureNormalized = await compareExposureNormalized(webCells[kind]!, nativeCells[kind]!);
  const edgeBand = await compareEdgeBand(webCells[kind]!, nativeCells[kind]!);
  const metaA = await sharp(webCells[kind]!).metadata(), metaB = await sharp(nativeCells[kind]!).metadata();
  cells.push({ kind, web: `${metaA.width}x${metaA.height}`, native: `${metaB.width}x${metaB.height}`, metrics,
    exposureNormalized, edgeBand });
  console.log(kind, JSON.stringify({ metrics, exposureNormalized, edgeBand }));
}
const matrix = { schemaVersion: 2, generatedAt: new Date().toISOString(),
  source: { executable: sourceExe, executableSha256: sha(await readFile(sourceExe)), glbDir,
    glb: Object.fromEntries(await Promise.all(["on", "off"].map(async kind => {
      const bytes = await readFile(path.join(glbDir, `round-1-gi-${kind}.glb`));
      return [kind, { sha256: sha(bytes), bytes: bytes.byteLength }];
    }))) },
  camera: { fov: 50, direction: [6, 4, 7], center: [0, 1.5, 0], fit: 1.05, position: cameraPosition,
    toneMapping: "ACESFilmic", pointLight: { intensity: 2, position: [1, 4, 3], decay: 2 } },
  thresholds: {
    raw: { ssimMin: 0.970, changedPixelRatioMax: 0.0301, status: "unchanged dashboard baseline; not met by this GI pair" },
    exposureNormalized: { normalizedSsimMin: 0.85, normalizedMaeMax: 0.08, edgeBandF1Min: 0.90,
      status: "proposed diagnostic gate; requires complex-geometry calibration before release" },
  },
  cells, boundary: "Web=真实 Chrome WebGPU(three.webgpu);Native=窗口 PrintWindow 读回;raw 指标保留，normalized 只消除整体曝光标度，不掩盖 edge-band 结构缺失;烘焙噪声明细见 lightmap-single-bounce spec" };
await writeFile(path.join(output, "matrix.json"), JSON.stringify(matrix, null, 2));
console.log("GI cross-end matrix written:", path.join(output, "matrix.json"));

type RgbImage = { data: Buffer; width: number; height: number };
async function readRgb(file: string): Promise<RgbImage> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`Expected RGB screenshot, got ${info.channels} channels: ${file}`);
  return { data, width: info.width, height: info.height };
}
function luminance(data: Uint8Array, offset: number): number {
  return data[offset]! * 0.2126 + data[offset + 1]! * 0.7152 + data[offset + 2]! * 0.0722;
}
function clampByte(value: number): number { return Math.max(0, Math.min(255, Math.round(value))); }
function rgbMetrics(reference: Uint8Array, candidate: Uint8Array) {
  const count = reference.length / 3;
  let absolute = 0, squared = 0, refMean = 0, candidateMean = 0, changed = 0, severe = 0, max = 0;
  for (let i = 0; i < reference.length; i += 3) {
    const left = luminance(reference, i), right = luminance(candidate, i);
    refMean += left; candidateMean += right;
    let pixelMax = 0;
    for (let c = 0; c < 3; c += 1) { const delta = reference[i + c]! - candidate[i + c]!; absolute += Math.abs(delta); squared += delta * delta; pixelMax = Math.max(pixelMax, Math.abs(delta)); }
    max = Math.max(max, pixelMax); if (pixelMax > 8) changed += 1; if (pixelMax > 32) severe += 1;
  }
  refMean /= count; candidateMean /= count;
  let refVariance = 0, candidateVariance = 0, covariance = 0;
  for (let i = 0; i < reference.length; i += 3) {
    const left = luminance(reference, i) - refMean, right = luminance(candidate, i) - candidateMean;
    refVariance += left * left; candidateVariance += right * right; covariance += left * right;
  }
  const denominator = Math.max(count - 1, 1); refVariance /= denominator; candidateVariance /= denominator; covariance /= denominator;
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  const ssim = ((2 * refMean * candidateMean + c1) * (2 * covariance + c2)) /
    ((refMean ** 2 + candidateMean ** 2 + c1) * (refVariance + candidateVariance + c2));
  return { ssim, meanAbsoluteError: absolute / reference.length / 255, changedPixelRatio: changed / count,
    severePixelRatio: severe / count, maximumChannelError: max,
    psnrDb: squared === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / (squared / reference.length)) };
}
async function compareExposureNormalized(referencePath: string, candidatePath: string) {
  const reference = await readRgb(referencePath), candidate = await readRgb(candidatePath);
  if (reference.width !== candidate.width || reference.height !== candidate.height) throw new Error("GI screenshot sizes differ");
  let refMean = 0, candidateMean = 0, count = 0;
  for (let i = 0; i < reference.data.length; i += 3) {
    const left = luminance(reference.data, i), right = luminance(candidate.data, i);
    // Exclude the flat background from the fit when possible; include the pair
    // if one side contains geometry so structure cannot be hidden by the fit.
    if (left > 30 || right > 30) { refMean += left; candidateMean += right; count += 1; }
  }
  if (count < 32) throw new Error("Not enough foreground pixels for exposure fit");
  refMean /= count; candidateMean /= count;
  let covariance = 0, variance = 0;
  for (let i = 0; i < reference.data.length; i += 3) {
    const left = luminance(reference.data, i), right = luminance(candidate.data, i);
    if (left > 30 || right > 30) { covariance += (right - candidateMean) * (left - refMean); variance += (right - candidateMean) ** 2; }
  }
  const gain = Math.max(0.25, Math.min(4, variance > 1e-9 ? covariance / variance : 1));
  const bias = refMean - gain * candidateMean;
  const normalized = Buffer.alloc(candidate.data.length);
  for (let i = 0; i < candidate.data.length; i += 3) {
    const sourceLuma = luminance(candidate.data, i), targetLuma = Math.max(0, gain * sourceLuma + bias);
    const scale = sourceLuma > 1e-6 ? targetLuma / sourceLuma : 0;
    normalized[i] = clampByte(candidate.data[i]! * scale); normalized[i + 1] = clampByte(candidate.data[i + 1]! * scale); normalized[i + 2] = clampByte(candidate.data[i + 2]! * scale);
  }
  const metrics = rgbMetrics(reference.data, normalized);
  return { fit: { gain, bias, foregroundPixels: count }, normalizedSsim: metrics.ssim,
    normalizedMae: metrics.meanAbsoluteError, normalizedPsnrDb: metrics.psnrDb };
}
function gradientMap(image: RgbImage): { values: Float32Array; threshold: number; mask: Uint8Array } {
  const { data, width, height } = image, values = new Float32Array(width * height); let maximum = 0;
  const at = (x: number, y: number) => luminance(data, (y * width + x) * 3);
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const gx = at(x + 1, y) - at(x - 1, y), gy = at(x, y + 1) - at(x, y - 1), value = Math.hypot(gx, gy); values[y * width + x] = value; maximum = Math.max(maximum, value);
  }
  // Use a per-image relative threshold: Native's darker output has edge
  // gradients below the fixed 4-channel cutoff used by dashboard captures.
  // Relative magnitude keeps this structural probe exposure-insensitive while
  // still retaining the raw RGB/SSIM gate above.
  const threshold = Math.max(0.5, maximum * 0.05);
  const mask = Uint8Array.from(values, value => value >= threshold ? 1 : 0); return { values, threshold, mask };
}
async function compareEdgeBand(referencePath: string, candidatePath: string) {
  const reference = await readRgb(referencePath), candidate = await readRgb(candidatePath);
  if (reference.width !== candidate.width || reference.height !== candidate.height) throw new Error("GI screenshot sizes differ");
  const left = gradientMap(reference), right = gradientMap(candidate), { width, height } = reference;
  const near = (mask: Uint8Array, x: number, y: number) => { for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
    const xx = x + dx, yy = y + dy; if (xx >= 0 && xx < width && yy >= 0 && yy < height && mask[yy * width + xx]) return true;
  } return false; };
  let leftCount = 0, rightCount = 0, leftMatched = 0, rightMatched = 0;
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const index = y * width + x;
    if (left.mask[index]) { leftCount += 1; if (near(right.mask, x, y)) leftMatched += 1; }
    if (right.mask[index]) { rightCount += 1; if (near(left.mask, x, y)) rightMatched += 1; }
  }
  const recall = leftCount ? leftMatched / leftCount : 0, precision = rightCount ? rightMatched / rightCount : 0;
  return { referenceThreshold: left.threshold, candidateThreshold: right.threshold, referenceEdgePixels: leftCount,
    candidateEdgePixels: rightCount, recall, precision, f1: recall + precision ? 2 * recall * precision / (recall + precision) : 0 };
}
function sha(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
