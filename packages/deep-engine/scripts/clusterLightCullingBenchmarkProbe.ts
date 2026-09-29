/// <reference types="@webgpu/types" />
// C2 帧时基准 probe(真机 wall-clock submit+done 口径):
// N∈{16,100,1000,10000} 灯,同一灯场下四腿对照——
//   perLight(每像素扫全部灯,经典 forward 基线) / clusterFrame(C2 剔除 compute + 集群着色)
//   / cullOnly(C2 剔除 compute 单独) / b1Assign(B1 簇心分配 compute,cluster-centric 对照)。
import { ClusterLightCuller, type ClusterLightCullingResources } from "../src/lighting/clusterLightCulling.js";
import { ForwardPlusClusterAssigner } from "../src/lighting/clusterCompute.js";
import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { BENCH_GRID, seededLights } from "./clusterLightCullingProbeScene.js";
import { PROBE_SHADING_WGSL } from "./clusterLightCullingBenchmarkWgsl.js";

export const BENCH_LIGHT_COUNTS = [16, 100, 1000, 10000] as const;
const WIDTH = BENCH_GRID.viewportWidth, HEIGHT = BENCH_GRID.viewportHeight;
const HDR_BYTES_PER_ROW = WIDTH * 8; // rgba16float,640*8=5120(256 对齐)。

export interface BenchmarkLeg {
  readonly lightCount: number;
  readonly perLightFrameMs: number;
  readonly clusterFrameMs: number;
  readonly prepareOnlyMs: number;
  readonly cullOnlyMs: number;
  readonly b1AssignMs: number;
  readonly overflow: number;
  readonly measuredFrames: number;
}
export interface ClusterLightCullingBenchmarkResult {
  readonly action: "cluster-light-culling-benchmark";
  readonly timingMethod: string;
  readonly viewport: readonly [number, number];
  readonly legs: readonly BenchmarkLeg[];
  readonly success: boolean;
}

export interface BenchmarkHarness {
  readonly device: GPUDevice;
  readonly session: DeviceSession;
  readonly culler: ClusterLightCuller;
  readonly b1: ForwardPlusClusterAssigner;
  readonly linearTarget: GPUTexture;
  readonly bindGroupFor(resources: ClusterLightCullingResources): GPUBindGroup;
  readonly pipelineFor(entry: "shadePerLight" | "shadeClustered" | "displayPerLight" | "displayClustered"): GPURenderPipeline;
  readonly pipelineForFormat(entry: "displayPerLight" | "displayClustered", format: GPUTextureFormat): GPURenderPipeline;
  readonly setEnv(envRadiance: number): void;
  readonly encodeLinearFrame(encoder: GPUCommandEncoder, bindGroup: GPUBindGroup, entry: "shadePerLight" | "shadeClustered"): void;
  readonly encodeDisplayFrame(encoder: GPUCommandEncoder, bindGroup: GPUBindGroup, entry: "displayPerLight" | "displayClustered",
    target: GPUTextureView, format: GPUTextureFormat): void;
  readonly readLinear(target: GPUTexture): Promise<Float32Array>;
}

export async function withBenchmarkHarness<T>(run: (harness: BenchmarkHarness) => Promise<T>): Promise<T> {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  const canvas = document.createElement("canvas");
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const device = session.device;
  const module = device.createShaderModule({ label: "C2 benchmark shading", code: PROBE_SHADING_WGSL });
  const layout = device.createBindGroupLayout({ label: "C2 benchmark layout", entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
  ] });
  const uniform = device.createBuffer({ label: "C2 benchmark shade uniform", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uniformWords = new ArrayBuffer(16);
  new Float32Array(uniformWords).set([0, 0]);
  new Uint32Array(uniformWords).set([WIDTH, HEIGHT], 2);
  const linearTarget = device.createTexture({ label: "C2 benchmark linear target", size: [WIDTH, HEIGHT], format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const linearView = linearTarget.createView();
  const pipelineCache: Record<string, GPURenderPipeline> = {};
  const bindGroups = new Map<ClusterLightCullingResources, GPUBindGroup>();
  const pipelineLayout = device.createPipelineLayout({ label: "C2 benchmark pipeline layout", bindGroupLayouts: [layout] });
  const harness: BenchmarkHarness = {
    device, session,
    culler: new ClusterLightCuller(session),
    b1: new ForwardPlusClusterAssigner(session),
    linearTarget,
    bindGroupFor: resources => {
      const cached = bindGroups.get(resources);
      if (cached) return cached;
      const bindGroup = device.createBindGroup({ label: "C2 benchmark bindings", layout, entries: [
        { binding: 0, resource: { buffer: resources.clusterParameterBuffer } },
        { binding: 1, resource: { buffer: resources.localBoundsBuffer } },
        { binding: 2, resource: { buffer: resources.clusterHeaderBuffer } },
        { binding: 3, resource: { buffer: resources.clusterLightIndexBuffer } },
        { binding: 4, resource: { buffer: uniform } },
      ] });
      bindGroups.set(resources, bindGroup); return bindGroup;
    },
    pipelineFor: entry => harness.pipelineForFormat(entry, "rgba16float"),
    pipelineForFormat: (entry, format) => {
      const key = `${entry}:${format}`;
      const cached = pipelineCache[key];
      if (cached) return cached;
      const pipeline = device.createRenderPipeline({ label: `C2 benchmark ${key}`, layout: pipelineLayout,
        vertex: { module, entryPoint: "probeVertex" },
        fragment: { module, entryPoint: entry, targets: [{ format }] } });
      pipelineCache[key] = pipeline; return pipeline;
    },
    setEnv: envRadiance => {
      new Float32Array(uniformWords).set([envRadiance, 0]);
      device.queue.writeBuffer(uniform, 0, uniformWords);
    },
    encodeLinearFrame: (encoder, bindGroup, entry) => {
      const pass = encoder.beginRenderPass({ label: `C2 benchmark ${entry}`, colorAttachments: [{
        view: linearView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
      pass.setPipeline(harness.pipelineFor(entry)); pass.setBindGroup(0, bindGroup);
      pass.draw(3); pass.end();
    },
    encodeDisplayFrame: (encoder, bindGroup, entry, target, format) => {
      const pass = encoder.beginRenderPass({ label: `C2 display ${entry}`, colorAttachments: [{
        view: target, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
      pass.setPipeline(harness.pipelineForFormat(entry, format)); pass.setBindGroup(0, bindGroup);
      pass.draw(3); pass.end();
    },
    readLinear: async target => {
      const readback = device.createBuffer({ label: "C2 benchmark readback", size: HDR_BYTES_PER_ROW * HEIGHT,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder({ label: "C2 benchmark readback" });
      encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: HDR_BYTES_PER_ROW, rowsPerImage: HEIGHT },
        [WIDTH, HEIGHT]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const halves = new Uint16Array(readback.getMappedRange().slice(0));
      readback.unmap(); readback.destroy();
      const pixels = new Float32Array(WIDTH * HEIGHT * 4);
      for (let index = 0; index < WIDTH * HEIGHT * 4; index++) pixels[index] = decodeHalf(halves[index]!);
      return pixels;
    },
  };
  device.queue.writeBuffer(uniform, 0, uniformWords);
  try { return await run(harness); } finally {
    harness.culler.dispose(); harness.b1.dispose();
    linearTarget.destroy(); uniform.destroy();
    session.dispose();
  }
}

function decodeHalf(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1, exponent = (bits >>> 10) & 0x1f, fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * fraction / 1024;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** wall-clock 口径:warmup 后逐帧 submit→onSubmittedWorkDone,返回 ms/帧(含 CPU 提交开销,诚实偏大)。 */
async function measureFrameTime(device: GPUDevice, warmup: number, frames: number,
  body: (encoder: GPUCommandEncoder) => void): Promise<number> {
  for (let frame = 0; frame < warmup; frame++) {
    const encoder = device.createCommandEncoder({ label: "C2 bench warmup" });
    body(encoder); device.queue.submit([encoder.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  const start = performance.now();
  for (let frame = 0; frame < frames; frame++) {
    const encoder = device.createCommandEncoder({ label: "C2 bench measured" });
    body(encoder); device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
  }
  return (performance.now() - start) / frames;
}

async function readOverflow(device: GPUDevice, resources: ClusterLightCullingResources): Promise<number> {
  const readback = device.createBuffer({ label: "C2 bench overflow readback", size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: "C2 bench overflow" });
  encoder.copyBufferToBuffer(resources.overflowBuffer, 0, readback, 0, 4);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const value = new Uint32Array(readback.getMappedRange().slice(0))[0] ?? 0;
  readback.unmap(); readback.destroy();
  return value;
}

export async function runClusterLightCullingBenchmark(): Promise<ClusterLightCullingBenchmarkResult> {
  return withBenchmarkHarness(async harness => {
    const device = harness.device, legs: BenchmarkLeg[] = [];
    const adapterInfo = await probeLabel();
    for (const count of BENCH_LIGHT_COUNTS) {
      const lights = seededLights(count);
      const resources = harness.culler.prepare(BENCH_GRID, { points: lights });
      const bindGroup = harness.bindGroupFor(resources);
      const frames = count >= 1000 ? 5 : 20;
      // 整腿口径:cluster 腿含每帧 prepare(CPU 打包+脏检查)+invalidate+剔除 dispatch+着色,
      // 与 ForwardPlusPbrRuntime.prepareAndEncode 的真实每帧路径同构;prepareOnlyMs 单列以分解
      // CPU 打包成本,GPU 剔除净成本 ≈ cullOnlyMs − prepareOnlyMs。
      const perLightFrameMs = await measureFrameTime(device, 2, frames,
        encoder => harness.encodeLinearFrame(encoder, bindGroup, "shadePerLight"));
      const prepareOnlyMs = await measureFrameTime(device, 1, frames,
        () => harness.culler.prepare(BENCH_GRID, { points: lights }));
      const clusterFrameMs = await measureFrameTime(device, 2, frames, encoder => {
        harness.culler.prepare(BENCH_GRID, { points: lights });
        harness.culler.invalidateAssignment(); harness.culler.encode(encoder);
        harness.encodeLinearFrame(encoder, bindGroup, "shadeClustered");
      });
      const cullOnlyMs = await measureFrameTime(device, 2, frames, encoder => {
        harness.culler.prepare(BENCH_GRID, { points: lights });
        harness.culler.invalidateAssignment(); harness.culler.encode(encoder);
      });
      harness.b1.prepare(BENCH_GRID, { points: lights });
      // B1 语义:invalidate 会连 prepared 一起清,必须 invalidate→prepare→encode 顺序。
      const b1AssignMs = await measureFrameTime(device, 1, count >= 1000 ? 3 : 10, encoder => {
        harness.b1.invalidateAssignment();
        harness.b1.prepare(BENCH_GRID, { points: lights });
        harness.b1.encode(encoder);
      });
      legs.push({ lightCount: count, perLightFrameMs, clusterFrameMs, prepareOnlyMs, cullOnlyMs, b1AssignMs,
        overflow: await readOverflow(device, resources), measuredFrames: frames });
    }
    const success = legs.every(leg => Number.isFinite(leg.perLightFrameMs) && Number.isFinite(leg.clusterFrameMs)
      && leg.clusterFrameMs > 0);
    return { action: "cluster-light-culling-benchmark", timingMethod: `wall-clock submit+done (${adapterInfo})`,
      viewport: [WIDTH, HEIGHT], legs, success };
  });
}

async function probeLabel(): Promise<string> {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter?.info?.vendor && adapter?.info?.architecture ? `${adapter.info.vendor}/${adapter.info.architecture}` : "adapter";
  } catch { return "adapter"; }
}
