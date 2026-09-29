/// <reference types="@webgpu/types" />
// C2 白炉多灯腿(复用 whiteFurnace.ts 的白炉常数/容差/净差判定,新增多灯腿):
// 白 Lambert 全屏墙 + 均匀环境 E=0.5 + 4 灯(暖/冷交替,intensity 2,decay 2)。
// 不变量:像素 ≡ E + Σ analyticDirect(与 probe WGSL 逐式同源的 CPU 参考)。
// 判据:1) 集群腿 mean/max 相对误差过 FURNACE_TOLERANCES.geometry*;2) 色偏增益;
// 3) 集群 ↔ 逐灯逐像素净差 p99 过 evaluateSsrToggleChecks(剔除不丢能量);
// 4) 两腿 Reinhard 显示帧 PNG 截图(视觉对照)。
import { FURNACE_TOLERANCES, WHITE_FURNACE_ENVIRONMENT_RADIANCE, evaluateSsrToggleChecks } from "../src/webgpu/whiteFurnace.js";
import type { PointLight } from "../src/lighting/types.js";
import { withBenchmarkHarness, type BenchmarkHarness } from "./clusterLightCullingBenchmarkProbe.js";
import { BENCH_GRID, pointContributionCpu } from "./clusterLightCullingProbeScene.js";

const WIDTH = BENCH_GRID.viewportWidth, HEIGHT = BENCH_GRID.viewportHeight;
const BGRA_BYTES_PER_ROW = WIDTH * 4; // 2560,256 对齐。
const BENCH_FOV = BENCH_GRID.verticalFovRadians;
const FURNACE_LIGHTS: readonly PointLight[] = [
  { positionView: [-3, 1, -4], range: 6, color: [1, 0.82, 0.6], intensity: 2 },
  { positionView: [3, -1, -4], range: 6, color: [0.55, 0.75, 1], intensity: 2 },
  { positionView: [0, 2, -12], range: 8, color: [1, 0.82, 0.6], intensity: 2 },
  { positionView: [0, -2, -12], range: 8, color: [0.55, 0.75, 1], intensity: 2 },
];

export interface FurnaceCheck { readonly name: string; readonly passed: boolean; readonly detail: string }
export interface ClusterLightCullingFurnaceResult {
  readonly action: "cluster-light-culling-furnace";
  readonly environmentRadiance: number;
  readonly meanRelativeError: number;
  readonly maxAbsRelativeError: number;
  readonly p99AbsRelativeError: number;
  readonly channelGain: readonly [number, number, number];
  readonly parityP99: number;
  readonly perLightMean: number;
  readonly clusterMean: number;
  readonly checks: readonly FurnaceCheck[];
  readonly perLightPngBase64: string;
  readonly clusterPngBase64: string;
  readonly success: boolean;
}

function compactRgb(pixels: Float32Array): Float32Array {
  const result = new Float32Array(pixels.length / 4 * 3);
  for (let index = 0; index < result.length / 3; index++) {
    result[index * 3] = pixels[index * 4]!;
    result[index * 3 + 1] = pixels[index * 4 + 1]!;
    result[index * 3 + 2] = pixels[index * 4 + 2]!;
  }
  return result;
}

/** 与 probe WGSL probeSurface 逐式同源:白墙在视深 8,法线 +z,像素中心采样。 */
function surfaceAt(x: number, y: number): [number, number, number] {
  const depth = 8, tanHalfFovY = Math.tan(BENCH_FOV / 2), tanHalfFovX = tanHalfFovY * WIDTH / HEIGHT;
  const ndcX = (x + 0.5) / WIDTH * 2 - 1, ndcY = (y + 0.5) / HEIGHT * 2 - 1;
  return [ndcX * tanHalfFovX * depth, -ndcY * tanHalfFovY * depth, -depth];
}

function analyticFrame(environment: number): Float32Array {
  const frame = new Float32Array(WIDTH * HEIGHT * 3);
  const normal: readonly [number, number, number] = [0, 0, 1];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const positionView = surfaceAt(x, y);
      const view: [number, number, number] = [-positionView[0], -positionView[1], -positionView[2]];
      const viewLength = Math.hypot(view[0], view[1], view[2]);
      const viewDir: [number, number, number] = [view[0] / viewLength, view[1] / viewLength, view[2] / viewLength];
      let r = environment, g = environment, b = environment;
      for (const light of FURNACE_LIGHTS) {
        const [cr, cg, cb] = pointContributionCpu(light, positionView, [1, 1, 1], 0, 1, normal, viewDir);
        r += cr; g += cg; b += cb;
      }
      const base = (y * WIDTH + x) * 3;
      frame[base] = r; frame[base + 1] = g; frame[base + 2] = b;
    }
  }
  return frame;
}

function statsAgainst(pixels: Float32Array, reference: Float32Array): {
  meanRelativeError: number; maxAbsRelativeError: number; p99AbsRelativeError: number;
  mean: number; channelGain: [number, number, number] } {
  let sum = 0, refSum = 0;
  const channelSums: [number, number, number] = [0, 0, 0], relative: number[] = [];
  for (let index = 0; index < pixels.length / 3; index++) {
    const base = index * 3;
    for (let channel = 0; channel < 3; channel++) {
      sum += pixels[base + channel]!; refSum += reference[base + channel]!; channelSums[channel]! += pixels[base + channel]!;
    }
    const luma = 0.2126 * pixels[base]! + 0.7152 * pixels[base + 1]! + 0.0722 * pixels[base + 2]!;
    const refLuma = 0.2126 * reference[base]! + 0.7152 * reference[base + 1]! + 0.0722 * reference[base + 2]!;
    relative.push(Math.abs(luma - refLuma) / refLuma);
  }
  relative.sort((left, right) => left - right);
  const count = pixels.length / 3, meanLuma = sum / count / 3;
  const gain = channelSums.map(channelSum => channelSum / count / meanLuma) as [number, number, number];
  return { meanRelativeError: (sum / count - refSum / count) / (refSum / count),
    maxAbsRelativeError: relative[relative.length - 1]!,
    p99AbsRelativeError: relative[Math.floor(0.99 * (relative.length - 1))]!, mean: meanLuma, channelGain: gain };
}

async function renderLinear(harness: BenchmarkHarness, bindGroup: GPUBindGroup,
  entry: "shadePerLight" | "shadeClustered"): Promise<Float32Array> {
  const encoder = harness.device.createCommandEncoder({ label: `C2 furnace linear ${entry}` });
  harness.encodeLinearFrame(encoder, bindGroup, entry);
  harness.device.queue.submit([encoder.finish()]);
  await harness.device.queue.onSubmittedWorkDone();
  return harness.readLinear(harness.linearTarget);
}

/** 显示帧截图:bgra8 离屏渲染 → 读回 → 2D canvas PNG(BGRA→RGBA 摆位)。 */
async function renderDisplayPng(harness: BenchmarkHarness, bindGroup: GPUBindGroup,
  entry: "displayPerLight" | "displayClustered"): Promise<string> {
  const device = harness.device;
  const target = device.createTexture({ label: `C2 furnace display ${entry}`, size: [WIDTH, HEIGHT], format: "bgra8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const readback = device.createBuffer({ label: `C2 furnace png readback ${entry}`, size: BGRA_BYTES_PER_ROW * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder({ label: `C2 furnace png ${entry}` });
    harness.encodeDisplayFrame(encoder, bindGroup, entry, target.createView(), "bgra8unorm");
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: BGRA_BYTES_PER_ROW, rowsPerImage: HEIGHT },
      [WIDTH, HEIGHT]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(readback.getMappedRange().slice(0));
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH; canvas.height = HEIGHT;
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(WIDTH, HEIGHT);
    for (let index = 0; index < WIDTH * HEIGHT; index++) {
      image.data[index * 4] = bytes[index * 4 + 2]!; image.data[index * 4 + 1] = bytes[index * 4 + 1]!;
      image.data[index * 4 + 2] = bytes[index * 4]!; image.data[index * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  } finally { readback.destroy(); target.destroy(); }
}

export async function runClusterLightCullingFurnace(): Promise<ClusterLightCullingFurnaceResult> {
  return withBenchmarkHarness(async harness => {
    const environment = WHITE_FURNACE_ENVIRONMENT_RADIANCE;
    harness.setEnv(environment);
    const resources = harness.culler.prepare(BENCH_GRID, { points: [...FURNACE_LIGHTS] });
    const bindGroup = harness.bindGroupFor(resources);
    const cullEncoder = harness.device.createCommandEncoder({ label: "C2 furnace cull" });
    harness.culler.encode(cullEncoder);
    harness.device.queue.submit([cullEncoder.finish()]);
    await harness.device.queue.onSubmittedWorkDone();
    const perLightFrame = await renderLinear(harness, bindGroup, "shadePerLight");
    const clusterFrame = await renderLinear(harness, bindGroup, "shadeClustered");
    const reference = analyticFrame(environment);
    const perLightRgb = compactRgb(perLightFrame), clusterRgb = compactRgb(clusterFrame);
    const stats = statsAgainst(clusterRgb, reference);
    const perLightStats = statsAgainst(perLightRgb, reference);
    const parity = evaluateSsrToggleChecks(perLightRgb, clusterRgb, environment, undefined);
    const percent = (value: number): string => `${(100 * value).toFixed(3)}%`;
    const checks: FurnaceCheck[] = [
      { name: "furnace-multi-light-conserved", passed: Math.abs(stats.meanRelativeError) <= FURNACE_TOLERANCES.geometryMeanRelative
        && stats.maxAbsRelativeError <= FURNACE_TOLERANCES.geometryMaxRelative,
        detail: `meanErr=${percent(stats.meanRelativeError)} maxErr=${percent(stats.maxAbsRelativeError)} p99=${percent(stats.p99AbsRelativeError)}` },
      { name: "furnace-multi-light-no-chroma-drift",
        passed: stats.channelGain.every(gain => Math.abs(gain - 1) <= FURNACE_TOLERANCES.channelGainDrift),
        detail: `gain=[${stats.channelGain.map(value => value.toFixed(4)).join(", ")}]` },
      { name: "furnace-multi-light-cull-parity", passed: parity.every(check => check.passed),
        detail: parity.map(check => check.detail).join("; ") },
      { name: "furnace-multi-light-perlight-conserved",
        passed: Math.abs(perLightStats.meanRelativeError) <= FURNACE_TOLERANCES.geometryMeanRelative,
        detail: `perLightMeanErr=${percent(perLightStats.meanRelativeError)}` },
    ];
    const perLightPngBase64 = await renderDisplayPng(harness, bindGroup, "displayPerLight");
    const clusterPngBase64 = await renderDisplayPng(harness, bindGroup, "displayClustered");
    return { action: "cluster-light-culling-furnace", environmentRadiance: environment,
      meanRelativeError: stats.meanRelativeError, maxAbsRelativeError: stats.maxAbsRelativeError,
      p99AbsRelativeError: stats.p99AbsRelativeError, channelGain: stats.channelGain,
      parityP99: Number(parity[0]?.detail.match(/p99Delta=([\d.]+)%/)?.[1] ?? "-1") / 100,
      perLightMean: perLightStats.mean, clusterMean: stats.mean,
      checks, perLightPngBase64, clusterPngBase64,
      success: checks.every(check => check.passed) };
  });
}
