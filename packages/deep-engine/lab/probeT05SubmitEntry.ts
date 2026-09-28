/**
 * T05 验收切片浏览器探针入口(lab 内:apps/web 架构边界禁止跨包相对深导入)：T00 工厂 fixture（FactoryMachine.glb ×10,000）上
 * 「T00 基线提交路径 vs 当前剔除提交路径」单开关 A/B。
 * 两档唯一差异 = PbrRenderer features.occlusionCulling；其余（baseline-equivalent 画质合同、
 * 阴影 exactProfile、toneMapping、相机、画布）逐字段对齐 lab DeepBenchmarkBackend 基线档。
 * 由 probe-t05-culling-submit.mjs 用 esbuild 打包并在 headless Chrome 中驱动。
 */

import { PbrRenderer } from "../src/webgpu/index.js";
import type { RenderView } from "../src/webgpu/index.js";
import { loadModelPacket } from "./modelPacket.js";
import { benchmarkPacketSphere } from "./benchmarkPacketBounds.js";
import { prepareRenderPacket } from "../src/renderPacket.js";
import { captureWebGpuBenchmarkImage } from "./benchmarkImage.js";
import { PacketCullingResources } from "../src/webgpu/packetCulling.js";

// 非侵入诊断：包裹 encode 记录每相批统计与候选规模（只在探针页面生效）。
interface CullTraceEntry { phase: string; frustumBatches: number; occlusionBatches: number; candidates: number }
const cullTrace: CullTraceEntry[] = [];
const originalEncode = PacketCullingResources.prototype.encode as
  (this: PacketCullingResources, ...args: Parameters<typeof PacketCullingResources.prototype.encode>) =>
    ReturnType<typeof PacketCullingResources.prototype.encode>;
PacketCullingResources.prototype.encode = function (...args: Parameters<typeof PacketCullingResources.prototype.encode>) {
  const stats = originalEncode.apply(this, args);
  const batches = args[4] as ReadonlyMap<string, unknown>;
  cullTrace.push({ phase: stats.phase, frustumBatches: stats.frustumBatches, occlusionBatches: stats.occlusionBatches,
    candidates: batches.size });
  return stats;
};
declare global { interface Window { __t05CullTrace?: CullTraceEntry[] } }

export interface SubmitRound {
  readonly round: number;
  readonly order: string;
  readonly baseline: { readonly p50: number; readonly p95: number; readonly p99: number; readonly drawCalls: number };
  readonly culled: { readonly p50: number; readonly p95: number; readonly p99: number; readonly drawCalls: number };
  readonly culledOcclusionActive: boolean;
  readonly errors: readonly string[];
}

const CANVAS = { width: 960, height: 540, dpr: 1 };
const BACKGROUND = [0.018, 0.024, 0.034] as const, FLOOR = [0.07, 0.08, 0.095] as const;
const LIGHT = { directionWorld: [-1.6, -2.8, -1.2] as const, color: [2.5, 2.4, 2.25] as const, intensity: 1 };
// T11 factory-fair 冻结相机（docs/reports/deep-core/T11-implementation.md 公平基线）。
const CAMERA = {
  eye: [236.55022784829885, 254.09654863370363, 304.13600723352715] as const,
  target: [0, 0.6498759390977019, 0] as const, up: [0, 1, 0] as const,
  fov: 0.7853981633974483, near: 0.1, far: 3379.2889692614126 };

function quantile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

async function createRenderer(canvas: HTMLCanvasElement, packet: Awaited<ReturnType<typeof loadModelPacket>>,
  view: RenderView, occlusionCulling: boolean, signal: AbortSignal): Promise<PbrRenderer> {
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, signal, {
    meshlets: true, deformation: true,
    shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 2048, depthBias: 0.00075,
      receiverNormalBias: "constant-one-texel" as const } },
    features: { environment: false, fog: false, groundGrid: false, ambientOcclusion: false,
      temporalAa: false, spatialAa: false, bloom: false, vignette: false, toneMapping: "three-aces-r185" as const,
      occlusionCulling },
  });
  try {
    await renderer.setPacketValidated(packet, signal);
    await renderer.validateFrame(view);
    return renderer;
  } catch (error) { renderer.dispose(); throw error; }
}

function viewFor(packet: Awaited<ReturnType<typeof loadModelPacket>>): RenderView {
  const sphere = benchmarkPacketSphere(packet);
  const extent = Math.max(0.1, sphere.radius);
  return { width: CANVAS.width, height: CANVAS.height, pixelRatio: CANVAS.dpr,
    eye: CAMERA.eye, target: CAMERA.target, up: CAMERA.up, extent,
    background: BACKGROUND, floor: FLOOR, exposure: 1, roughness: 1,
    verticalFovRadians: CAMERA.fov, near: CAMERA.near, far: CAMERA.far, lights: { directional: [LIGHT] } };
}

function sampleFrames(renderer: PbrRenderer, view: RenderView, warmup: number, samples: number):
  { p50: number; p95: number; p99: number; drawCalls: number; occlusionActive: boolean; trace: string[] } {
  const trace: string[] = [];
  for (let frame = 0; frame < warmup; frame++) {
    const metrics = renderer.render(view);
    if (trace.length < 8) trace.push(`w${frame}:occ=${metrics?.occlusionCulling},frustum=${metrics?.frustumCulledBatches},hizOcc=${metrics?.hiZOccludedBatches},mips=${metrics?.hiZMipLevels}`);
  }
  const cpu: number[] = [];
  let drawCalls = 0, occlusionActive = false;
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    const frame = renderer.render(view);
    cpu.push(performance.now() - started);
    if (!frame) throw new Error("Frame was not submitted.");
    drawCalls = frame.drawCalls;
    occlusionActive = frame.occlusionCulling;
  }
  return { p50: quantile(cpu, 0.5), p95: quantile(cpu, 0.95), p99: quantile(cpu, 0.99),
    drawCalls, occlusionActive, trace };
}

/** 浏览器入口：加载工厂 fixture，建双渲染器，交替 order A/B·B/A 采 count 轮。 */
export async function runSubmitProbe(rounds: number, warmup: number, samples: number): Promise<{
  readonly rounds: readonly SubmitRound[];
  readonly fixture: Readonly<Record<string, unknown>>;
  readonly errors: readonly string[];
  readonly surfaces: Readonly<Record<string, { meanLuminance: number; geometryDetailFraction: number }>>;
  readonly cullTrace: readonly { phase: string; frustumBatches: number; occlusionBatches: number; candidates: number }[];
}> {
  const errors: string[] = [];
  window.addEventListener("error", event => errors.push(event.message));
  window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
  const signal = new AbortController().signal;
  const packet = await loadModelPacket("FactoryMachine", 10_000, signal);
  const view = viewFor(packet);
  const prepared = prepareRenderPacket(packet);
  const batchShape = prepared.batches.map(batch => ({ key: batch.key.slice(0, 80), count: batch.count,
    lod: batch.lod !== undefined, alphaMode: batch.alphaMode }));
  const triangles = packet.geometries.reduce((sum, geometry) => sum + geometry.indices.length / 3, 0);
  const makeCanvas = (id: string): HTMLCanvasElement => {
    const canvas = document.createElement("canvas");
    canvas.id = id;
    canvas.width = CANVAS.width;
    canvas.height = CANVAS.height;
    document.body.append(canvas);
    return canvas;
  };
  const baselineCanvas = makeCanvas("baseline-canvas");
  const culledCanvas = makeCanvas("culled-canvas");
  const baseline = await createRenderer(baselineCanvas, packet, view, false, signal);
  const culled = await createRenderer(culledCanvas, packet, view, true, signal);
  const rounds_out: SubmitRound[] = [];
  let surfaces: Readonly<Record<string, { meanLuminance: number; geometryDetailFraction: number }>> | undefined;
  try {
    for (let round = 1; round <= rounds; round++) {
      const culledFirst = round % 2 === 0;
      const first = culledFirst ? culled : baseline;
      const second = culledFirst ? baseline : culled;
      const firstStats = sampleFrames(first, view, warmup, samples);
      const secondStats = sampleFrames(second, view, warmup, samples);
      const base = culledFirst ? secondStats : firstStats;
      const culledStats = culledFirst ? firstStats : secondStats;
      rounds_out.push({ round, order: culledFirst ? "culled,base" : "base,culled",
        baseline: { p50: base.p50, p95: base.p95, p99: base.p99, drawCalls: base.drawCalls },
        culled: { p50: culledStats.p50, p95: culledStats.p95, p99: culledStats.p99, drawCalls: culledStats.drawCalls },
        culledOcclusionActive: culledStats.occlusionActive, errors: [...errors] });
    }
    const capture = async (renderer: PbrRenderer, canvas: HTMLCanvasElement) => {
      renderer.render(view);
      const image = await captureWebGpuBenchmarkImage(renderer.session.device, renderer.session.context,
        renderer.session.format, canvas.width, canvas.height);
      return { meanLuminance: image.meanLuminance, geometryDetailFraction: image.geometryDetailFraction };
    };
    surfaces = { baseline: await capture(baseline, baselineCanvas), culled: await capture(culled, culledCanvas) };
  } finally {
    baseline.dispose();
    culled.dispose();
  }
  if (!surfaces) throw new Error("Surface capture did not run.");
  return { rounds: rounds_out, errors, surfaces, cullTrace: cullTrace.slice(0, 24),
    fixture: { instanceCount: packet.instances.length, triangles, geometryCount: packet.geometries.length,
      materialCount: packet.materials.length, canvas: [CANVAS.width, CANVAS.height], dpr: CANVAS.dpr,
      batchShape, camera: CAMERA, light: LIGHT } };
}

declare global {
  interface Window { __t05SubmitProbe?: { run(rounds: number, warmup: number, samples: number):
    Promise<{ rounds: readonly SubmitRound[]; fixture: Readonly<Record<string, unknown>>; errors: readonly string[] }> } }
}
window.__t05SubmitProbe = { run: (rounds, warmup, samples) => runSubmitProbe(rounds, warmup, samples) };
