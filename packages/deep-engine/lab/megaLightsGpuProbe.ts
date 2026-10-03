/// <reference types="@webgpu/types" />
// B2 MegaLights M1 真机验收探针(headless Chrome WebGPU;模式沿用 clusterLightCullingGpuProbe):
//   ① perf:5000 动态点光(10% 移动)@1920×1080,RIS compute 两趟,wall-clock p50/p95(≤20ms 门);
//   ③ flicker:同场景静态 + 固定帧种子,逐帧颜色差 p99(≤2/255 门,线性域直比更严);
//   ④ area:64 面积光走既有 LTC 交付核(DEEP_AREA_LIGHTING_WGSL + LUT 区,compute 复用)
//      ↔ evaluateAreaLightCpu 网格 RMS(≤1% 门);
//   ⑤ parity:8 灯场景穷举模式(GPU ↔ CPU 精确和,退化一致性;容差吸收 GPU FMA)
//      + RIS 单帧无偏性烟雾(严格无偏性由 CPU vitest 门守)。
// runner:scripts/megaLightsGpuTest.mjs;证据:test-output/ue-class-b2/megalights-m1/。
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { AREA_LIGHT_DATA_VEC4S, AREA_LIGHT_DATA_VEC4_TOTAL, packAreaLights, type AreaLight } from "../src/lighting/areaLights.js";
import { evaluateAreaLightCpu, type AreaLightGeometryCpu } from "../src/lighting/ltc.js";
import { DEEP_AREA_LIGHTING_WGSL } from "../src/lighting/ltcAreaLightingWgsl.js";
import { decodeLtcLut } from "../src/lighting/ltcTables.js";
import { megaLightsFromClustered, packMegaLights, resolveDirectLightingPath } from "../src/lighting/megaLights.js";
import { megaLightsExhaustiveReferenceCpu } from "../src/lighting/megaLightsRisCpu.js";
import { MegaLightsRuntime } from "../src/lighting/megaLightsRuntime.js";
import type { ClusteredLights, LightVector3, PointLight } from "../src/lighting/types.js";

type LightingSessionShim = Pick<DeviceSession, "device" | "state" | "own" | "release">;

/** 真机 leg 共用的裸设备会话壳(own/release 语义与 DeviceSession 对齐:destroy 即释放)。 */
function shimSession(device: GPUDevice): LightingSessionShim {
  return { device, state: "ready",
    own<T extends { destroy(): void }>(resource: T): T { return resource; },
    release(resource: { destroy(): void }): void { resource.destroy(); } };
}

async function requestDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  return adapter.requestDevice();
}

// ---- 场景构造(确定性) ----

const PERF_LIGHT_COUNT = 5000;
const PERF_WIDTH = 1920, PERF_HEIGHT = 1080;

/** 5000 点光(10% 移动):第 index%10===0 号灯随帧做正弦漂移。 */
function buildPerfLights(frame: number): ClusteredLights {
  const points: PointLight[] = [];
  for (let index = 0; index < PERF_LIGHT_COUNT; index++) {
    const angle = index * 2.399963229728653;
    const radius = 1.5 + (index % 11) * 0.55;
    const moving = index % 10 === 0;
    const wobble = moving ? Math.sin(frame * 0.07 + index) * 0.6 : 0;
    points.push({
      positionView: [Math.cos(angle) * radius + wobble, 0.5 + Math.sin(angle * 1.7) * 0.8,
        1.2 + Math.cos(angle * 0.6) * 0.5 + (moving ? Math.cos(frame * 0.05 + index) * 0.4 : 0)],
      range: 0, color: [1, 0.95 - (index % 4) * 0.08, 0.9 - (index % 3) * 0.12],
      intensity: 0.5 + (index % 7) * 0.25, decay: 2,
    });
  }
  return { points };
}

/** 1920×1080 视空间表面:z=−3 朗伯墙,逐像素轻微法线扰动(确定性)。 */
function buildPerfSurfaces(width: number, height: number): Float32Array {
  const surfaces = new Float32Array(width * height * 3 * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3 * 4;
      const px = (x / width - 0.5) * 3.2, py = (0.5 - y / height) * 1.8;
      surfaces[index] = px; surfaces[index + 1] = py; surfaces[index + 2] = -3;
      surfaces[index + 3] = 0; // metallic
      const nx = Math.sin(x * 0.013) * 0.15, ny = Math.cos(y * 0.017) * 0.15;
      const nl = 1 / Math.hypot(nx, ny, 1);
      surfaces[index + 4] = nx * nl; surfaces[index + 5] = ny * nl; surfaces[index + 6] = nl;
      surfaces[index + 7] = 0.5; // roughness
      surfaces[index + 8] = 0.8; surfaces[index + 9] = 0.78; surfaces[index + 10] = 0.75;
    }
  }
  return surfaces;
}

async function readbackColor(device: GPUDevice, runtime: MegaLightsRuntime): Promise<Float32Array> {
  const pixels = runtime.pixelCount;
  const buffer = device.createBuffer({ label: "MegaLights probe color readback", size: pixels * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder({ label: "MegaLights probe readback" });
    encoder.copyBufferToBuffer(runtime.colorBuffer, 0, buffer, 0, pixels * 16);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    return new Float32Array(buffer.getMappedRange().slice(0));
  } finally { buffer.destroy(); }
}

/** wall-clock 口径(C2 同款):submit→onSubmittedWorkDone,含 CPU 提交开销,诚实偏大。 */
async function runFrame(device: GPUDevice, runtime: MegaLightsRuntime,
  resources: { width: number; height: number; lightCount: number }, timed: boolean): Promise<number> {
  const encoder = device.createCommandEncoder({ label: "MegaLights probe frame" });
  runtime.encode(encoder, resources);
  const start = performance.now();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  return timed ? performance.now() - start : 0;
}

/** ① perf + ③ flicker 合并腿:先动态灯计时,再静止 + 固定种子测逐帧差。 */
/** 抓 Tint 编译诊断(shader 编译失败在 Chrome 是异步 uncaptured error,dispatch 静默变 no-op)。 */
async function compilationMessages(runtime: MegaLightsRuntime): Promise<string[]> {
  const info = await runtime.shaderModule.getCompilationInfo();
  return info.messages.map(message => `${message.type}:${message.lineNum}:${message.message}`);
}

async function perfAndFlickerLeg(): Promise<Record<string, unknown>> {
  const device = await requestDevice();
  device.addEventListener?.("uncapturederror", (event) => {
    console.error("[uncapturederror]", (event as GPUUncapturedErrorEvent).error.message);
  });
  const runtime = new MegaLightsRuntime(shimSession(device));
  try {
    const width = PERF_WIDTH, height = PERF_HEIGHT;
    const surfaces = buildPerfSurfaces(width, height);
    const frameTimes: number[] = [];
    let resources = { width, height, lightCount: 0 };
    let movers = 0, lightCount = 0;
    for (let frame = 0; frame < 68; frame++) {
      const packed = packMegaLights(megaLightsFromClustered(buildPerfLights(frame)));
      lightCount = packed.count;
      movers = Math.ceil(lightCount / 10);
      resources = { width, height, lightCount };
      runtime.prepare({ width, height, lights: packed, surfaces,
        temporalEnabled: true, spatialEnabled: false, alphaBlend: frame === 0 ? 1 : 1 / 32 });
      frameTimes.push(await runFrame(device, runtime, resources, frame >= 8));
    }
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    const perf = { frames: frameTimes.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95),
      maxMs: sorted[sorted.length - 1]!, lightCount, movers, width, height, gateMs: 20 };
    const compileMessages = await compilationMessages(runtime);
    if (compileMessages.length) console.error("[compilation]", compileMessages.join(" | "));

    // ③ 静态 + 固定帧种子:同输入逐位回放 → 逐帧差应为 0;门 = 2/255(线性域直比更严)。
    // 首帧 alpha=1 全量替换(冲掉 perf 腿的 EMA 残留;残留收敛期会产出假帧差)。
    const staticPacked = packMegaLights(megaLightsFromClustered(buildPerfLights(0)));
    runtime.prepare({ width, height, lights: staticPacked, surfaces,
      temporalEnabled: true, spatialEnabled: false, frameSeed: 7, alphaBlend: 1 });
    let previous: Float32Array | undefined;
    let maxFrameDiffP99 = 0, framesCompared = 0;
    for (let frame = 0; frame < 12; frame++) {
      if (frame === 1) {
        runtime.prepare({ width, height, lights: staticPacked, surfaces,
          temporalEnabled: true, spatialEnabled: false, frameSeed: 7, alphaBlend: 1 / 32 });
      }
      await runFrame(device, runtime, { width, height, lightCount: staticPacked.count }, false);
      const color = await readbackColor(device, runtime);
      if (previous) {
        const diffs: number[] = [];
        for (let index = 0; index < color.length; index += 4) {
          diffs.push(Math.abs(color[index]! - previous[index]!) + Math.abs(color[index + 1]! - previous[index + 1]!)
            + Math.abs(color[index + 2]! - previous[index + 2]!));
        }
        diffs.sort((a, b) => a - b);
        maxFrameDiffP99 = Math.max(maxFrameDiffP99, diffs[Math.floor(diffs.length * 0.99)]!);
        framesCompared++;
      }
      previous = color;
    }
    // 非零输出哨兵:全零 = 通路空转(③ 的 diff=0 会是空真),必须挡下。
    const meanLuminance = previous!.reduce((sum, value, index) => index % 4 === 3 ? sum : sum + value, 0)
      / (previous!.length / 4 * 3);
    return { action: "megalights-perf-flicker", perf, compileMessages,
      meanLuminance,
      flicker: { framesCompared, maxFrameDiffP99, gate: 2 / 255, pass: maxFrameDiffP99 <= 2 / 255 },
      perfPass: percentile(0.95) <= 20 && meanLuminance > 0 };
  } finally { runtime.dispose(); }
}

// ---- ④ 64 面积光 GPU 腿:既有 LTC 交付核(DEEP_AREA_LIGHTING_WGSL)compute 复用 ----

async function areaLightLtcLeg(): Promise<Record<string, unknown>> {
  const device = await requestDevice();
  // 诊断定案组:全部正面朝向探针表面的单面灯(排除 twoSided 背面路径;背面路径
  // 的差异由 perLightSamples 单独暴露)。
  const dumpPoint: LightVector3 = [0, 0, 0.5];
  const lights: AreaLight[] = Array.from({ length: 64 }, (_, index) => {
    const positionView: LightVector3 = [Math.cos(index * 0.7) * 2, Math.sin(index * 1.3) * 2, -1 - (index % 4)];
    const toSurface: LightVector3 = [dumpPoint[0] - positionView[0], dumpPoint[1] - positionView[1], dumpPoint[2] - positionView[2]];
    const toLength = Math.hypot(...toSurface);
    const directionView: LightVector3 = [toSurface[0] / toLength, toSurface[1] / toLength, toSurface[2] / toLength];
    // up 预先正交化(打包端 orthonormalBasis 会正交归一;CPU 参考端不重做,必须喂同轴)。
    const dirLength = Math.hypot(...directionView);
    const dotUp = directionView[1];
    const upView: LightVector3 = [-dotUp * directionView[0] / dirLength ** 2,
      1 - dotUp * directionView[1] / dirLength ** 2, -dotUp * directionView[2] / dirLength ** 2];
    return {
    positionView,
    directionView,
    upView,
    halfExtent: [0.2 + (index % 5) * 0.1, 0.15 + (index % 3) * 0.1],
    range: 0,
    color: [1, 0.8, 0.6], intensity: 1 + (index % 6),
    twoSided: false,
    };
  });
  const packed = packAreaLights(lights);
  const lut = decodeLtcLut();
  const data = new Float32Array(AREA_LIGHT_DATA_VEC4_TOTAL * 4);
  data.set(packed.lights, 0);
  data.set(lut, AREA_LIGHT_DATA_VEC4S * 4);
  const lightBuffer = device.createBuffer({ label: "MegaLights probe area data", size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(lightBuffer, 0, data.buffer as ArrayBuffer);

  // 探针 compute:16×16 表面网格逐灯求和(LTC 交付核同式;与 evaluateAreaLightCpu 对拍)。
  const pixelCount = 256;
  const module = device.createShaderModule({ label: "MegaLights probe area LTC", code: /* wgsl */ `
    ${DEEP_AREA_LIGHTING_WGSL}
    struct ProbeParams { lightCount: u32, pixelCount: u32, pad0: u32, pad1: u32, };
    @group(0) @binding(0) var<uniform> params: ProbeParams;
    @group(0) @binding(1) var<storage, read> deepAreaLightData: array<vec4<f32>>;
    @group(0) @binding(2) var<storage, read> surfaces: array<vec4<f32>>;
    @group(0) @binding(3) var<storage, read_write> sums: array<vec4<f32>>;
    @compute @workgroup_size(64)
    fn probeAreaSum(@builtin(global_invocation_id) gid: vec3u) {
      if (gid.x >= params.pixelCount) { return; }
      let surface = surfaces[gid.x * 2u];
      let material = surfaces[gid.x * 2u + 1u];
      var total = vec3f(0.0);
      for (var index = 0u; index < params.lightCount; index = index + 1u) {
        total = total + deepAreaLightContribution(index * 6u, surface.xyz,
          vec3f(material.x, material.y, material.z), vec3f(0.0, 0.1, 1.0),
          vec3f(0.8, 0.75, 0.7), 0.0, 0.4, 0.04, vec3f(1.0));
      }
      sums[gid.x] = vec4f(total, 0.0);
    }
  ` });
  const pipeline = device.createComputePipeline({ label: "MegaLights probe area pipeline", layout: "auto",
    compute: { module, entryPoint: "probeAreaSum" } });
  const surfaces = new Float32Array(pixelCount * 2 * 4);
  for (let index = 0; index < pixelCount; index++) {
    const x = index % 16, y = Math.floor(index / 16);
    surfaces[index * 8] = (x / 16 - 0.5) * 2;
    surfaces[index * 8 + 1] = (0.5 - y / 16) * 1.5;
    surfaces[index * 8 + 2] = 0.5;
    surfaces[index * 8 + 4] = Math.sin(index) * 0.2;
    surfaces[index * 8 + 5] = Math.cos(index * 1.3) * 0.2;
    surfaces[index * 8 + 6] = 1;
  }
  const surfaceBuffer = device.createBuffer({ label: "MegaLights probe area surfaces", size: surfaces.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(surfaceBuffer, 0, surfaces.buffer as ArrayBuffer);
  const sumBuffer = device.createBuffer({ label: "MegaLights probe area sums", size: pixelCount * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const paramsBuffer = device.createBuffer({ label: "MegaLights probe area params", size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([lights.length, pixelCount, 0, 0]));
  const readback = device.createBuffer({ label: "MegaLights probe area readback", size: pixelCount * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: paramsBuffer } }, { binding: 1, resource: { buffer: lightBuffer } },
    { binding: 2, resource: { buffer: surfaceBuffer } }, { binding: 3, resource: { buffer: sumBuffer } }] });
  // 逐灯诊断:固定一个表面,每 lane = 单灯贡献(GPU),供与 CPU 同位对拍定位差异项。
  const dumpModule = device.createShaderModule({ label: "MegaLights probe area per-light", code: /* wgsl */ `
    ${DEEP_AREA_LIGHTING_WGSL}
    @group(0) @binding(0) var<storage, read> deepAreaLightData: array<vec4<f32>>;
    @group(0) @binding(1) var<storage, read_write> perLight: array<vec4<f32>>;
    @compute @workgroup_size(64)
    fn probePerLight(@builtin(global_invocation_id) gid: vec3u) {
      let light = gid.x;
      perLight[light] = vec4f(deepAreaLightContribution(light * 6u, vec3f(0.0, 0.0, 0.5),
        vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.1, 1.0), vec3f(0.8, 0.75, 0.7), 0.0, 0.4, 0.04, vec3f(1.0)), 0.0);
    }
  ` });
  const dumpPipeline = device.createComputePipeline({ label: "MegaLights probe per-light pipeline", layout: "auto",
    compute: { module: dumpModule, entryPoint: "probePerLight" } });
  const dumpBuffer = device.createBuffer({ label: "MegaLights probe per-light", size: 64 * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const dumpReadback = device.createBuffer({ label: "MegaLights probe per-light readback", size: 64 * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  // diffuse 分项诊断副本(仅探针;与交付核同式拆开,定位差异项)。
  const splitModule = device.createShaderModule({ label: "MegaLights probe area split", code: /* wgsl */ `
    ${DEEP_AREA_LIGHTING_WGSL}
    @group(0) @binding(0) var<storage, read> deepAreaLightData: array<vec4<f32>>;
    @group(0) @binding(1) var<storage, read_write> splitOut: array<vec4<f32>>;
    fn probeDiffuseOnly(base: u32) -> vec3f {
      let positionRange = deepAreaLightData[base];
      let normalDecay = deepAreaLightData[base + 1u];
      let upFlags = deepAreaLightData[base + 2u];
      let extentsScale = deepAreaLightData[base + 3u];
      let radiance = deepAreaLightData[base + 5u].xyz;
      let flags = u32(upFlags.w);
      let lightNormal = normalize(normalDecay.xyz);
      let lightUp = normalize(upFlags.xyz);
      let positionView = vec3f(0.0, 0.0, 0.5);
      let toSurface = positionView - positionRange.xyz;
      let facing = dot(toSurface, lightNormal);
      if ((flags & DEEP_AREA_LIGHT_FLAG_TWO_SIDED) == 0u && facing < 0.0) { return vec3f(0.0); }
      let surfaceNormal = vec3f(0.0, 0.0, 1.0);
      let viewDirection = normalize(vec3f(0.0, 0.1, 1.0));
      let viewDot = dot(viewDirection, surfaceNormal);
      let viewTangent = select(
        normalize(cross(vec3f(0.0, 1.0, 0.0), surfaceNormal)),
        normalize(viewDirection - surfaceNormal * viewDot), viewDot < 0.9999);
      let bitangent = cross(surfaceNormal, viewTangent);
      let lightBitangent = cross(lightNormal, lightUp);
      let corners = array<vec3f, 4>(
        positionRange.xyz + lightUp * extentsScale.x + lightBitangent * extentsScale.y,
        positionRange.xyz - lightUp * extentsScale.x + lightBitangent * extentsScale.y,
        positionRange.xyz - lightUp * extentsScale.x - lightBitangent * extentsScale.y,
        positionRange.xyz + lightUp * extentsScale.x - lightBitangent * extentsScale.y);
      var local0 = vec3f(0.0);
      var local1 = vec3f(0.0);
      var local2 = vec3f(0.0);
      var local3 = vec3f(0.0);
      for (var index = 0u; index < 4u; index++) {
        let direction = normalize(corners[index] - positionView);
        let local = vec3f(dot(direction, viewTangent), dot(direction, bitangent), dot(direction, surfaceNormal));
        if (index == 0u) { local0 = local; } else if (index == 1u) { local1 = local; }
        else if (index == 2u) { local2 = local; } else { local3 = local; }
      }
      let diffuseFactor = deepAreaPolygonFormFactor(local0, local1, local2, local3);
      let diffuseSigned = select(diffuseFactor, abs(diffuseFactor), (flags & DEEP_AREA_LIGHT_FLAG_TWO_SIDED) != 0u);
      return max(vec3f(0.8, 0.75, 0.7), vec3f(0.0)) * radiance * max(diffuseSigned, 0.0)
        / DEEP_AREA_LIGHT_PI * vec3f(1.0);
    }
    @compute @workgroup_size(64)
    fn probeSplit(@builtin(global_invocation_id) gid: vec3u) {
      splitOut[gid.x] = vec4f(probeDiffuseOnly(gid.x * 6u), 0.0);
    }
  ` });
  const splitPipeline = device.createComputePipeline({ label: "MegaLights probe split pipeline", layout: "auto",
    compute: { module: splitModule, entryPoint: "probeSplit" } });
  const splitBuffer = device.createBuffer({ label: "MegaLights probe split", size: 64 * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const splitReadback = device.createBuffer({ label: "MegaLights probe split readback", size: 64 * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const dumpGroup = device.createBindGroup({ layout: dumpPipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: lightBuffer } }, { binding: 1, resource: { buffer: dumpBuffer } }] });
  const splitGroup = device.createBindGroup({ layout: splitPipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: lightBuffer } }, { binding: 1, resource: { buffer: splitBuffer } }] });

  const encoder = device.createCommandEncoder({ label: "MegaLights probe area" });
  const pass = encoder.beginComputePass({ label: "MegaLights probe area pass" });
  pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(4); pass.end();
  const dumpPass = encoder.beginComputePass({ label: "MegaLights probe per-light pass" });
  dumpPass.setPipeline(dumpPipeline); dumpPass.setBindGroup(0, dumpGroup); dumpPass.dispatchWorkgroups(1); dumpPass.end();
  const splitPass = encoder.beginComputePass({ label: "MegaLights probe split pass" });
  splitPass.setPipeline(splitPipeline); splitPass.setBindGroup(0, splitGroup); splitPass.dispatchWorkgroups(1); splitPass.end();
  encoder.copyBufferToBuffer(sumBuffer, 0, readback, 0, pixelCount * 16);
  encoder.copyBufferToBuffer(dumpBuffer, 0, dumpReadback, 0, 64 * 16);
  encoder.copyBufferToBuffer(splitBuffer, 0, splitReadback, 0, 64 * 16);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const gpuSums = new Float32Array(readback.getMappedRange().slice(0));
  readback.destroy();
  await dumpReadback.mapAsync(GPUMapMode.READ);
  const gpuPerLight = new Float32Array(dumpReadback.getMappedRange().slice(0));
  dumpReadback.destroy();
  await splitReadback.mapAsync(GPUMapMode.READ);
  const gpuDiffuseOnly = new Float32Array(splitReadback.getMappedRange().slice(0));
  splitReadback.destroy();

  // CPU 逐灯同位参考(与 GPU dump 同表面同参数)。
  const cpuPerLight: number[] = [];
  {
    const surface = { position: [0, 0, 0.5] as LightVector3, normal: [0, 0, 1] as LightVector3,
      view: [0, 0.1, 1] as LightVector3, baseColor: [0.8, 0.75, 0.7], metallic: 0, roughness: 0.4 };
    for (const light of lights) {
      const geometry: AreaLightGeometryCpu = { position: light.positionView, normal: light.directionView,
        up: light.upView, halfWidth: light.halfExtent[0], halfHeight: light.halfExtent[1] };
      const evaluation = evaluateAreaLightCpu(lut, { ...geometry, twoSided: light.twoSided === true,
        range: light.range, intensity: light.intensity, color: light.color }, surface);
      cpuPerLight.push(evaluation.diffuse[0] + evaluation.specular[0]);
    }
  }
  const perLightSamples = [0, 1, 2, 3].map(index => {
    const surface = { position: [0, 0, 0.5] as LightVector3, normal: [0, 0, 1] as LightVector3,
      view: [0, 0.1, 1] as LightVector3, baseColor: [0.8, 0.75, 0.7], metallic: 0, roughness: 0.4 };
    const light = lights[index]!;
    const geometry: AreaLightGeometryCpu = { position: light.positionView, normal: light.directionView,
      up: light.upView, halfWidth: light.halfExtent[0], halfHeight: light.halfExtent[1] };
    const evaluation = evaluateAreaLightCpu(lut, { ...geometry, twoSided: light.twoSided === true,
      range: light.range, intensity: light.intensity, color: light.color }, surface);
    return { light: index, gpuR: gpuPerLight[index * 4], cpuR: cpuPerLight[index],
      gpuDiffuseR: gpuDiffuseOnly[index * 4], cpuDiffuseR: evaluation.diffuse[0],
      cpuSpecularR: evaluation.specular[0] };
  });

  // CPU 参考:evaluateAreaLightCpu 逐灯求和(与 WGSL 同式;LUT 同表)。
  let squares = 0, gpuEnergy = 0, cpuEnergy = 0;
  for (let index = 0; index < pixelCount; index++) {
    const surface = {
      position: [surfaces[index * 8]!, surfaces[index * 8 + 1]!, surfaces[index * 8 + 2]!] as LightVector3,
      normal: [surfaces[index * 8 + 4]!, surfaces[index * 8 + 5]!, surfaces[index * 8 + 6]!] as LightVector3,
      view: [0, 0.1, 1] as LightVector3, baseColor: [0.8, 0.75, 0.7], metallic: 0, roughness: 0.4,
    };
    let total: LightVector3 = [0, 0, 0];
    for (const light of lights) {
      const geometry: AreaLightGeometryCpu = { position: light.positionView, normal: light.directionView,
        up: light.upView, halfWidth: light.halfExtent[0], halfHeight: light.halfExtent[1] };
      const evaluation = evaluateAreaLightCpu(lut, { ...geometry, twoSided: light.twoSided === true,
        range: light.range, intensity: light.intensity, color: light.color }, surface);
      total = [total[0] + evaluation.diffuse[0] + evaluation.specular[0],
        total[1] + evaluation.diffuse[1] + evaluation.specular[1],
        total[2] + evaluation.diffuse[2] + evaluation.specular[2]];
    }
    for (let channel = 0; channel < 3; channel++) {
      squares += (gpuSums[index * 4 + channel]! - total[channel]!) ** 2;
      gpuEnergy += gpuSums[index * 4 + channel]! ** 2;
      cpuEnergy += total[channel]! ** 2;
    }
  }
  const rmseValue = Math.sqrt(squares / (pixelCount * 3));
  const gpuOverCpuEnergy = Math.sqrt(gpuEnergy / Math.max(cpuEnergy, 1e-12));
  lightBuffer.destroy(); surfaceBuffer.destroy(); sumBuffer.destroy(); paramsBuffer.destroy(); readback.destroy();
  dumpBuffer.destroy(); splitBuffer.destroy();
  return { action: "megalights-64-area-ltc", lightCount: lights.length, pixels: pixelCount,
    rmse: rmseValue, gpuOverCpuEnergy, gate: 0.01, perLightSamples,
    pass: rmseValue <= 0.01 && Math.abs(gpuOverCpuEnergy - 1) <= 0.01 };
}

// ---- ⑤ parity:8 灯穷举(退化一致性)+ RIS 无偏性烟雾 ----

const PARITY_WIDTH = 16, PARITY_HEIGHT = 16;

function buildParityScene(): { readonly lights: readonly Parameters<typeof packMegaLights>[0]; readonly surfaces: Float32Array } {
  const lights: Parameters<typeof packMegaLights>[0] = Array.from({ length: 8 }, (_, index) => ({
    kind: index % 4 === 3 ? "spot" : "point",
    positionView: [Math.cos(index * 0.9) * 1.8, Math.sin(index * 1.1) * 1.8, 1.5 + (index % 3)] as LightVector3,
    range: index % 5 === 0 ? 0 : 9, color: [1, 0.9, 0.75], intensity: 0.8 + (index % 4) * 0.6, decay: 2,
    ...(index % 4 === 3 ? { directionView: [-Math.cos(index * 0.9), -Math.sin(index * 1.1), -1] as LightVector3,
      innerConeCos: 0.92, outerConeCos: 0.78 } : {}),
  }));
  const surfaces = new Float32Array(PARITY_WIDTH * PARITY_HEIGHT * 3 * 4);
  for (let index = 0; index < PARITY_WIDTH * PARITY_HEIGHT; index++) {
    const x = index % PARITY_WIDTH, y = Math.floor(index / PARITY_WIDTH);
    surfaces[index * 12] = (x / PARITY_WIDTH - 0.5) * 3;
    surfaces[index * 12 + 1] = (0.5 - y / PARITY_HEIGHT) * 3;
    surfaces[index * 12 + 2] = -2.5;
    surfaces[index * 12 + 3] = 0; // metallic
    surfaces[index * 12 + 4] = 0; surfaces[index * 12 + 5] = 0; surfaces[index * 12 + 6] = 1; // normal
    surfaces[index * 12 + 7] = 0.45; // roughness
    surfaces[index * 12 + 8] = 0.8; surfaces[index * 12 + 9] = 0.8; surfaces[index * 12 + 10] = 0.8;
  }
  return { lights, surfaces };
}

/** 运行时灯池缓冲句柄(诊断读回;生产面不经此)。 */
function poolBufferOf(runtime: MegaLightsRuntime): GPUBuffer {
  return (runtime as unknown as { resources?: { lights: GPUBuffer } }).resources!.lights;
}

function paritySurfaceViews(surfaces: Float32Array): (readonly (number | LightVector3)[])[] {
  const views: (readonly (number | LightVector3)[])[] = [];
  for (let index = 0; index < PARITY_WIDTH * PARITY_HEIGHT; index++) {
    const base = index * 12;
    views.push([
      [surfaces[base]!, surfaces[base + 1]!, surfaces[base + 2]!, surfaces[base + 3]!] as unknown as LightVector3,
      [surfaces[base + 4]!, surfaces[base + 5]!, surfaces[base + 6]!, surfaces[base + 7]!] as unknown as LightVector3,
      [surfaces[base + 8]!, surfaces[base + 9]!, surfaces[base + 10]!, surfaces[base + 11]!] as unknown as LightVector3,
    ]);
  }
  return views;
}

async function parityLeg(): Promise<Record<string, unknown>> {
  const device = await requestDevice();
  device.addEventListener?.("uncapturederror", (event) => {
    console.error("[parity uncapturederror]", (event as GPUUncapturedErrorEvent).error.message);
  });
  const runtime = new MegaLightsRuntime(shimSession(device));
  try {
    const { lights, surfaces } = buildParityScene();
    const views = paritySurfaceViews(surfaces);
    const width = PARITY_WIDTH, height = PARITY_HEIGHT;
    const packed = packMegaLights(lights);
    const runMode = async (exhaustive: boolean): Promise<Float32Array> => {
      runtime.prepare({ width, height, lights: packed, surfaces, temporalEnabled: false,
        spatialEnabled: false, exhaustive, frameSeed: 11, alphaBlend: 1 });
      await runFrame(device, runtime, { width, height, lightCount: packed.count }, false);
      return readbackColor(device, runtime);
    };
    const gpuExhaustive = await runMode(true);
    const gpuRis = await runMode(false);
    const cpuExhaustive = megaLightsExhaustiveReferenceCpu(lights, views, width, height);
    // 穷举一致性(GPU ↔ CPU 精确和;相对 RMS 容差吸收 GPU FMA 融合,先例 A3 布料口径)。
    let exhaustiveSquares = 0, energy = 0;
    for (let index = 0; index < cpuExhaustive.length; index++) {
      exhaustiveSquares += (gpuExhaustive[index * 4]! - cpuExhaustive[index]!) ** 2;
      energy += cpuExhaustive[index]! ** 2;
    }
    const exhaustiveRms = Math.sqrt(exhaustiveSquares / cpuExhaustive.length);
    const exhaustiveRelative = Math.sqrt(exhaustiveSquares / Math.max(energy, 1e-12));
    // RIS 单帧 vs 穷举:无偏性烟雾(单帧方差大,只记录规模;严格无偏性由 CPU vitest 门守)。
    let risSquares = 0;
    for (let index = 0; index < cpuExhaustive.length; index++) {
      risSquares += (gpuRis[index * 4]! - cpuExhaustive[index]!) ** 2;
    }
    const risRms = Math.sqrt(risSquares / cpuExhaustive.length);
    const compileMessages = await compilationMessages(runtime);
    if (compileMessages.length) console.error("[parity compilation]", compileMessages.join(" | "));
    // 池记录读回:GPU 端灯池 8×16 词 vs CPU 打包字(定位上传/布局分歧)。
    const poolReadback = device.createBuffer({ label: "MegaLights probe pool readback", size: packed.data.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    {
      const poolEncoder = device.createCommandEncoder({ label: "MegaLights probe pool readback" });
      poolEncoder.copyBufferToBuffer(poolBufferOf(runtime), 0, poolReadback, 0, packed.data.byteLength);
      device.queue.submit([poolEncoder.finish()]);
      await poolReadback.mapAsync(GPUMapMode.READ);
    }
    const gpuPool = new Float32Array(poolReadback.getMappedRange().slice(0));
    poolReadback.destroy();
    let poolDrift = 0;
    for (let index = 0; index < packed.data.length; index++) {
      if (gpuPool[index] !== packed.data[index]) poolDrift++;
    }
    const pathDecision = resolveDirectLightingPath({ points: lights.length, spots: 0, forceMegaLights: true });
    const samples = [0, 64, 128, 192].map(index => ({
      pixel: index, gpu: gpuExhaustive[index * 4], gpuRis: gpuRis[index * 4], cpu: cpuExhaustive[index] }));
    // NaN 像素清单(前 8 个)与占比。
    const nanPixels: number[] = [];
    for (let index = 0; index < cpuExhaustive.length; index++) {
      if (!Number.isFinite(gpuExhaustive[index * 4]) && nanPixels.length < 8) nanPixels.push(index);
    }
    return { action: "megalights-parity-8", lightCount: lights.length, path: pathDecision, samples, compileMessages,
      poolDriftWords: poolDrift, nanPixels,
      exhaustive: { rms: exhaustiveRms, relativeRms: exhaustiveRelative, gate: 0.002, pass: exhaustiveRelative <= 0.002 },
      risSmoke: { rms: risRms, relativeRms: Math.sqrt(risSquares / Math.max(energy, 1e-12)), note: "single-frame unbiasedness smoke; strict gate lives in vitest" } };
  } finally { runtime.dispose(); }
}

// ---- 组装入口(runner 逐腿调用) ----

export function probeAdapterInfo(): unknown {
  return { href: location.href, userAgent: navigator.userAgent, webgpu: "gpu" in navigator };
}

export async function runPerfFlicker(): Promise<Record<string, unknown>> {
  return perfAndFlickerLeg();
}

export async function runAreaLtc(): Promise<Record<string, unknown>> {
  return areaLightLtcLeg();
}

export async function runParity(): Promise<Record<string, unknown>> {
  return parityLeg();
}
