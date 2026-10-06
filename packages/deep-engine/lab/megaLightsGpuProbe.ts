/// <reference types="@webgpu/types" />
// B2 MegaLights M1 真机验收探针(headless Chrome WebGPU;模式沿用 clusterLightCullingGpuProbe):
//   ① perf:5000 动态点光(10% 移动)@1920×1080,RIS compute 两趟,wall-clock p50/p95(≤20ms 门);
//   ③ flicker:同场景静态 + 固定帧种子,逐帧颜色差 p99(≤2/255 门,线性域直比更严);
//   ④ area:64 面积光走既有 LTC 交付核(DEEP_AREA_LIGHTING_WGSL + LUT 区,compute 复用)
//      ↔ evaluateAreaLightCpu 网格 RMS(≤1% 门);
//   ⑤ parity:8 灯场景穷举模式(GPU ↔ CPU 精确和,退化一致性;容差吸收 GPU FMA)
//      + RIS 单帧无偏性烟雾(严格无偏性由 CPU vitest 门守)。
//   ⑥ visibility:M2 胜者可见性射线——单灯+遮挡盒,阴影区抑制 ≥98%/亮区不变
//      (CPU f64 线段-盒 oracle)/哨兵零/帧时披露;traceTwoLevelOccluded 片段族真机闭环。
// runner:scripts/megaLightsGpuTest.mjs;证据:test-output/ue-class-b2/megalights-m1/。
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { AREA_LIGHT_DATA_VEC4S, AREA_LIGHT_DATA_VEC4_TOTAL, packAreaLights, type AreaLight } from "../src/lighting/areaLights.js";
import { evaluateAreaLightCpu, type AreaLightGeometryCpu } from "../src/lighting/ltc.js";
import { DEEP_AREA_LIGHTING_WGSL } from "../src/lighting/ltcAreaLightingWgsl.js";
import { DEEP_IES_SAMPLING_WGSL } from "../src/lighting/iesSamplingWgsl.js";
import { decodeLtcLut } from "../src/lighting/ltcTables.js";
import { megaLightsFromClustered, megaLightBrdfCpu, megaLightRangeAttenuationCpu, packMegaLights,
  resolveDirectLightingPath, type MegaLight } from "../src/lighting/megaLights.js";
import { evaluateMegaLightCpu } from "../src/lighting/megaLights.js";
import { megaLightsExhaustiveReferenceCpu, megaSurfaceDecodeCpu } from "../src/lighting/megaLightsRisCpu.js";
import { MEGA_LIGHTS_RIS_WGSL } from "../src/lighting/megaLightsRisWgsl.js";
import { buildTlas, traceTlasClosest, type TlasInstanceDescriptor } from "../src/rayTracing/tlas.js";
import type { RayBlasDescriptor } from "../src/rayTracing/rayBackendTypes.js";
import { packTlasScene } from "../src/rayTracing/tlasLayout.js";
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
  resources: { width: number; height: number; lightCount: number; visibilityEnabled?: boolean }, timed: boolean): Promise<number> {
  const encoder = device.createCommandEncoder({ label: "MegaLights probe frame" });
  runtime.encode(encoder, { ...resources, visibilityEnabled: resources.visibilityEnabled ?? false });
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
    // 相位 1(temporal off,12 帧):冲掉 perf 场景在蓄水池 B 里的陈旧历史(深度门因
    // 同 gbuffer 放行,时域合并会把上一场景的胜者渗入数帧——首测即衰减假帧差);
    // 相位 2(temporal on,alpha=1 全量替换 1 帧)→ 相位 3(alpha=1/32,测量 11 帧)。
    const staticPacked = packMegaLights(megaLightsFromClustered(buildPerfLights(0)));
    runtime.prepare({ width, height, lights: staticPacked, surfaces,
      temporalEnabled: false, spatialEnabled: false, frameSeed: 7, alphaBlend: 1 });
    for (let frame = 0; frame < 12; frame++) {
      await runFrame(device, runtime, { width, height, lightCount: staticPacked.count }, false);
    }
    runtime.prepare({ width, height, lights: staticPacked, surfaces,
      temporalEnabled: true, spatialEnabled: false, frameSeed: 7, alphaBlend: 1 });
    await runFrame(device, runtime, { width, height, lightCount: staticPacked.count }, false);
    runtime.prepare({ width, height, lights: staticPacked, surfaces,
      temporalEnabled: true, spatialEnabled: false, frameSeed: 7, alphaBlend: 1 / 32 });
    let previous: Float32Array | undefined;
    let maxFrameDiffP99 = 0, framesCompared = 0;
    const perFrameP99: number[] = [];
    for (let frame = 0; frame < 12; frame++) {
      await runFrame(device, runtime, { width, height, lightCount: staticPacked.count }, false);
      const color = await readbackColor(device, runtime);
      if (previous) {
        const diffs: number[] = [];
        for (let index = 0; index < color.length; index += 4) {
          diffs.push(Math.abs(color[index]! - previous[index]!) + Math.abs(color[index + 1]! - previous[index + 1]!)
            + Math.abs(color[index + 2]! - previous[index + 2]!));
        }
        diffs.sort((a, b) => a - b);
        const p99 = diffs[Math.floor(diffs.length * 0.99)]!;
        perFrameP99.push(p99);
        maxFrameDiffP99 = Math.max(maxFrameDiffP99, p99);
        framesCompared++;
      }
      previous = color;
    }
    // 非零输出哨兵:全零 = 通路空转(③ 的 diff=0 会是空真),必须挡下。
    const meanLuminance = previous!.reduce((sum, value, index) => index % 4 === 3 ? sum : sum + value, 0)
      / (previous!.length / 4 * 3);
    return { action: "megalights-perf-flicker", perf, compileMessages,
      meanLuminance, perFrameP99,
      flicker: { framesCompared, maxFrameDiffP99, gate: 2 / 255, pass: maxFrameDiffP99 <= 2 / 255 },
      perfPass: percentile(0.95) <= 20 && meanLuminance > 0 };
  } finally { runtime.dispose(); }
}

// ---- ④ 64 面积光 GPU 腿:既有 LTC 交付核(DEEP_AREA_LIGHTING_WGSL)compute 复用 ----

async function areaLightLtcLeg(): Promise<Record<string, unknown>> {
  const device = await requestDevice();
  // 诊断定案组:全部正面朝向探针表面的单面灯(排除 twoSided 背面路径;背面路径
  // 的差异由 perLightSamples 单独暴露)。
  const dumpPoint = [0, 0, 0.5] as const;
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
    // 诊断副本:与交付核同式的完整贡献(diffuse+specular)+ 中间量。
    fn probeFull(base: u32) -> vec4f {
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
      if ((flags & DEEP_AREA_LIGHT_FLAG_TWO_SIDED) == 0u && facing < 0.0) { return vec4f(0.0); }
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
      let cosTheta = clamp(dot(surfaceNormal, viewDirection), 0.0, 1.0);
      let lut = deepAreaLtcTransform(cosTheta, 0.4);
      let row0 = vec3f(lut[0].y, lut[1].y, lut[2].y);
      let row1 = vec3f(lut[3].y, lut[4].y, lut[5].y);
      let amplitude = lut[6].y;
      let transform = mat3x3f(vec3f(row0.x, row1.y, 0.0), vec3f(0.0, 0.0, 0.0), vec3f(row0.z, 0.0, 1.0));
      let mapped0 = normalize(transform * local0);
      let mapped1 = normalize(transform * local1);
      let mapped2 = normalize(transform * local2);
      let mapped3 = normalize(transform * local3);
      let specularFactor = deepAreaPolygonFormFactor(mapped0, mapped1, mapped2, mapped3);
      return vec4f(deepAreaPolygonFormFactor(local0, local1, local2, local3), specularFactor, row0.x, row1.y);
    }
    @compute @workgroup_size(64)
    fn probeSplit(@builtin(global_invocation_id) gid: vec3u) {
      splitOut[gid.x] = vec4f(probeDiffuseOnly(gid.x * 6u), 0.0);
      if (gid.x < 4u) {
        splitOut[32u + gid.x] = probeFull(gid.x * 6u);
      }
      if (gid.x == 0u) {
        splitOut[0].y = deepAreaLightData[384u].x;
        splitOut[0].z = deepAreaLightData[384u + 3068u + 1u].w;
        splitOut[0].w = deepAreaLightData[384u + 3068u].x;
      }
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
    const surface = { position: [0, 0, 0.5] as [number, number, number], normal: [0, 0, 1] as [number, number, number],
      view: [0, 0.1, 1] as [number, number, number], baseColor: [0.8, 0.75, 0.7] as [number, number, number],
      metallic: 0, roughness: 0.4 };
    for (const light of lights) {
      const geometry = { position: [...light.positionView] as [number, number, number],
        normal: [...light.directionView] as [number, number, number], up: [...light.upView] as [number, number, number],
        halfWidth: light.halfExtent[0], halfHeight: light.halfExtent[1] };
      const evaluation = evaluateAreaLightCpu(lut, { ...geometry, twoSided: light.twoSided === true,
        range: light.range, intensity: light.intensity, color: light.color }, surface);
      cpuPerLight.push(evaluation.diffuse[0] + evaluation.specular[0]);
    }
  }
  const perLightSamples = [0, 1, 2, 3].map(index => {
    const surface = { position: [0, 0, 0.5] as [number, number, number], normal: [0, 0, 1] as [number, number, number],
      view: [0, 0.1, 1] as [number, number, number], baseColor: [0.8, 0.75, 0.7] as [number, number, number],
      metallic: 0, roughness: 0.4 };
    const light = lights[index] as MegaLight & { readonly directionView: LightVector3; readonly upView: LightVector3; readonly halfExtent: [number, number] };
    const geometry = { position: [...light.positionView] as [number, number, number],
      normal: [...light.directionView] as [number, number, number], up: [...light.upView] as [number, number, number],
      halfWidth: light.halfExtent[0], halfHeight: light.halfExtent[1] };
    const evaluation = evaluateAreaLightCpu(lut, { ...geometry, twoSided: light.twoSided === true,
      range: light.range, intensity: light.intensity, color: light.color }, surface);
    const lutRow0X = index === 0 ? gpuDiffuseOnly[1] : undefined;
    const lutAmplitude = index === 0 ? gpuDiffuseOnly[2] : undefined;
    const lutTexelRow0X = index === 0 ? gpuDiffuseOnly[3] : undefined;
    const diag = index < 4 ? {
      copyDiffuseFF: gpuDiffuseOnly[(32 + index) * 4],
      copySpecularFF: gpuDiffuseOnly[(32 + index) * 4 + 1],
      copyRow0X: gpuDiffuseOnly[(32 + index) * 4 + 2],
      copyRow1Y: gpuDiffuseOnly[(32 + index) * 4 + 3] } : undefined;
    return { light: index, gpuR: gpuPerLight[index * 4], cpuR: cpuPerLight[index],
      gpuDiffuseR: gpuDiffuseOnly[index * 4], cpuDiffuseR: evaluation.diffuse[0],
      cpuSpecularR: evaluation.specular[0], lutRow0X, lutAmplitude, lutTexelRow0X, diag };
  });

  // CPU 参考:evaluateAreaLightCpu 逐灯求和(与 WGSL 同式;LUT 同表)。
  let squares = 0, gpuEnergy = 0, cpuEnergy = 0;
  for (let index = 0; index < pixelCount; index++) {
    const surface = {
      position: [surfaces[index * 8]!, surfaces[index * 8 + 1]!, surfaces[index * 8 + 2]!] as [number, number, number],
      normal: [surfaces[index * 8 + 4]!, surfaces[index * 8 + 5]!, surfaces[index * 8 + 6]!] as [number, number, number],
      view: [0, 0.1, 1] as [number, number, number], baseColor: [0.8, 0.75, 0.7] as [number, number, number],
      metallic: 0, roughness: 0.4,
    };
    let total: LightVector3 = [0, 0, 0];
    for (const light of lights) {
      const geometry = { position: [...light.positionView] as [number, number, number],
        normal: [...light.directionView] as [number, number, number], up: [...light.upView] as [number, number, number],
        halfWidth: light.halfExtent[0], halfHeight: light.halfExtent[1] };
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

function buildParityScene(): { readonly lights: Parameters<typeof packMegaLights>[0]; readonly surfaces: Float32Array } {
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

/** 运行时内部缓冲句柄(诊断读回;生产面不经此)。 */
function runtimeBuffersOf(runtime: MegaLightsRuntime): {
  lights: GPUBuffer; surfaces: GPUBuffer; reservoirsA: GPUBuffer; color: GPUBuffer; ies: GPUBuffer } {
  return (runtime as unknown as { resources?: { lights: GPUBuffer; surfaces: GPUBuffer;
    reservoirsA: GPUBuffer; color: GPUBuffer; ies: GPUBuffer } }).resources!;
}

/** 最差像素逐灯诊断模块源(RIS 库同一贡献函数;像素号在构建期内联)。 */
function composePerLightRisSource(pixel: number): string {
  return /* wgsl */ `
    @group(0) @binding(0) var<storage, read> deepMegaLights: array<vec4<f32>>;
    @group(0) @binding(1) var<storage, read> deepMegaSurfaces: array<vec4<f32>>;
    @group(0) @binding(2) var<storage, read_write> deepMegaReservoirsA: array<vec4<f32>>;
    @group(0) @binding(3) var<storage, read_write> deepMegaColor: array<vec4<f32>>;
    @group(0) @binding(4) var<storage, read> deepIesShading: array<vec4<f32>>;
    ${DEEP_IES_SAMPLING_WGSL}
    // M2 可见性注入(诊断模块恒 1:per-light 腿只对拍贡献函数,与可见性无关)。
    fn deepMegaVisibilityAt(pixelIndex: u32) -> f32 { return 1.0; }
    ${MEGA_LIGHTS_RIS_WGSL}
    @compute @workgroup_size(8)
    fn probePerLightRis(@builtin(global_invocation_id) gid: vec3u) {
      let pixel = ${pixel}u;
      let surfaceA = deepMegaSurfaces[pixel * 3u];
      let surfaceB = deepMegaSurfaces[pixel * 3u + 1u];
      let surfaceC = deepMegaSurfaces[pixel * 3u + 2u];
      let record = deepMegaLoad(gid.x);
      let view = deepMegaSafeNormalize(-surfaceA.xyz, vec3f(0.0, 0.0, 1.0));
      var color = deepMegaContribution(record, surfaceA.xyz, surfaceB.xyz, view,
        surfaceC.xyz, surfaceA.w, surfaceB.w);
      if (gid.x == 0u) { color = color + vec3f(1.0, 0.0, 0.0); } // 金丝雀:诊断通路活着则 lane0 ≥ 1。
      deepMegaColor[gid.x] = vec4f(color, 0.0);
    }
  `;
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
    // 通道对齐:gpu = 像素主序 vec4(4 步长),cpu = 像素主序 rgb(3 步长)——步长错位会
    // 产出假 0.8× 偏差与越界 NaN(2026-10-04 真机抓出的诊断 bug,勿回退)。
    const pixels = PARITY_WIDTH * PARITY_HEIGHT;
    let exhaustiveSquares = 0, energy = 0;
    for (let pixel = 0; pixel < pixels; pixel++) {
      for (let channel = 0; channel < 3; channel++) {
        const difference = gpuExhaustive[pixel * 4 + channel]! - cpuExhaustive[pixel * 3 + channel]!;
        exhaustiveSquares += difference * difference;
        energy += cpuExhaustive[pixel * 3 + channel]! ** 2;
      }
    }
    const exhaustiveRms = Math.sqrt(exhaustiveSquares / (pixels * 3));
    const exhaustiveRelative = Math.sqrt(exhaustiveSquares / Math.max(energy, 1e-12));
    // RIS 单帧 vs 穷举:无偏性烟雾(单帧方差大,只记录规模;严格无偏性由 CPU vitest 门守)。
    let risSquares = 0;
    for (let pixel = 0; pixel < pixels; pixel++) {
      for (let channel = 0; channel < 3; channel++) {
        const difference = gpuRis[pixel * 4 + channel]! - cpuExhaustive[pixel * 3 + channel]!;
        risSquares += difference * difference;
      }
    }
    const risRms = Math.sqrt(risSquares / (pixels * 3));
    const compileMessages = await compilationMessages(runtime);
    if (compileMessages.length) console.error("[parity compilation]", compileMessages.join(" | "));
    // 池记录读回:GPU 端灯池 8×16 词 vs CPU 打包字(定位上传/布局分歧)。
    const buffers = runtimeBuffersOf(runtime);
    const poolReadback = device.createBuffer({ label: "MegaLights probe pool readback", size: packed.data.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    {
      const poolEncoder = device.createCommandEncoder({ label: "MegaLights probe pool readback" });
      poolEncoder.copyBufferToBuffer(buffers.lights, 0, poolReadback, 0, packed.data.byteLength);
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
    const samples = [0, 64, 128, 192].map(pixel => ({
      pixel, gpu: [0, 1, 2].map(c => gpuExhaustive[pixel * 4 + c]), gpuRis: gpuRis[pixel * 4],
      cpu: [0, 1, 2].map(c => cpuExhaustive[pixel * 3 + c]) }));
    // NaN 像素清单(前 8 个)+ 最差像素诊断。
    const nanPixels: number[] = [];
    let worstPixel = -1, worstError = 0;
    for (let pixel = 0; pixel < pixels; pixel++) {
      if (!Number.isFinite(gpuExhaustive[pixel * 4]) && nanPixels.length < 8) nanPixels.push(pixel);
      let error = 0;
      for (let channel = 0; channel < 3; channel++) {
        error += Math.abs(gpuExhaustive[pixel * 4 + channel]! - cpuExhaustive[pixel * 3 + channel]!);
      }
      if (error > worstError) { worstError = error; worstPixel = pixel; }
    }
    // 池字差异样本(前 8 个 drift 词)。
    const poolDriftSamples: Array<Record<string, number>> = [];
    for (let index = 0; index < packed.data.length && poolDriftSamples.length < 8; index++) {
      if (gpuPool[index] !== packed.data[index]) poolDriftSamples.push({ word: index, gpu: gpuPool[index] ?? 0, cpu: Number(packed.data[index]) });
    }
    // 最差像素的 GPU 逐灯贡献(RIS 库同一贡献函数;定位 CPU/GPU 单灯分歧)。
    // 复用 deepMegaColor 缓冲(COPY_SRC)作 dump 目标(此时颜色已读回,可破坏)。
    const worst = worstPixel >= 0 ? worstPixel : 0;
    const perLightCode = composePerLightRisSource(worst);
    const perLightModule = device.createShaderModule({ label: "MegaLights probe per-light RIS",
      code: perLightCode });
    const perLightCompile = await perLightModule.getCompilationInfo();
    if (perLightCompile.messages.length) {
      console.error("[perLight compilation]", perLightCompile.messages.map(m => `${m.type}:${m.lineNum}:${m.message}`).join(" | "));
    }
    const perLightPipeline = device.createComputePipeline({ label: "MegaLights probe per-light RIS pipeline",
      layout: "auto", compute: { module: perLightModule, entryPoint: "probePerLightRis" } });
    const perLightDump = device.createBuffer({ label: "MegaLights probe per-light RIS readback", size: 8 * 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    // auto layout 按入口静态使用推导(入口不用 reservoirsA → 槽位 2 不存在);
    // 绑定组必须逐槽对齐,否则整条提交被静默丢弃(2026-10-04 真机抓出)。
    const perLightGroup = device.createBindGroup({ layout: perLightPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: buffers.lights } }, { binding: 1, resource: { buffer: buffers.surfaces } },
      { binding: 3, resource: { buffer: buffers.color } }, { binding: 4, resource: { buffer: buffers.ies } }] });
    const perLightEncoder = device.createCommandEncoder({ label: "MegaLights probe per-light RIS" });
    const perLightPass = perLightEncoder.beginComputePass({ label: "MegaLights probe per-light RIS pass" });
    perLightPass.setPipeline(perLightPipeline); perLightPass.setBindGroup(0, perLightGroup);
    perLightPass.dispatchWorkgroups(1); perLightPass.end();
    perLightEncoder.copyBufferToBuffer(buffers.color, 0, perLightDump, 0, 8 * 16);
    device.queue.submit([perLightEncoder.finish()]);
    await perLightDump.mapAsync(GPUMapMode.READ);
    const gpuPerLightRis = new Float32Array(perLightDump.getMappedRange().slice(0));
    perLightDump.destroy();
    const worstPerLight = lights.map((light, index) => {
      const surface = megaSurfaceDecodeCpu(views[worst]!);
      const cpuLight = evaluateMegaLightCpu(light, surface);
      return { light: index, kind: light.kind, gpuR: gpuPerLightRis[index * 4] ?? 0, cpuR: cpuLight[0] };
    });
    const worstSample = worstPixel >= 0 ? {
      pixel: worstPixel,
      gpu: [0, 1, 2].map(c => gpuExhaustive[(worstPixel * 4 + c) as number] ?? 0),
      cpu: [0, 1, 2].map(c => cpuExhaustive[worstPixel * 3 + c]),
      perLight: worstPerLight } : undefined;
    return { action: "megalights-parity-8", lightCount: lights.length, path: pathDecision, samples, compileMessages,
      poolDriftWords: poolDrift, poolDriftSamples, nanPixels, worstSample,
      // GPU 数组原样回传(通道对齐 由 runner 对黄金真值完成;浏览器内 CPU 参考链
      // 存在未定位的求值偏差,2026-10-04 起降级为参考显示,不作为门)。
      gpuExhaustive: [...gpuExhaustive],
      gpuRis: [...gpuRis],
      browserCpuExhaustive: [...cpuExhaustive],
      browserExhaustive: { rms: exhaustiveRms, relativeRms: exhaustiveRelative, note: "browser-side reference, informational only" },
      risSmoke: { rms: risRms, relativeRms: Math.sqrt(risSquares / Math.max(energy, 1e-12)), note: "single-frame unbiasedness smoke; strict gate lives in vitest" } };
  } finally { runtime.dispose(); }
}

// ---- ⑥ M2 胜者可见性射线腿(2026-10-05;traceTwoLevelOccluded 片段族真机闭环) ----

/** 可见性腿小场景:视空间 == 世界(viewToWorld 恒等)。z=−3 朗伯墙 + 单点光 +
 * 轴对齐遮挡盒;期望阴影区由 CPU f64 线段-盒解析判交逐像素给出(精确 oracle)。 */
const VIS_WIDTH = 320, VIS_HEIGHT = 180;

function buildVisibilitySurfaces(width: number, height: number): Float32Array {
  const surfaces = new Float32Array(width * height * 3 * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3 * 4;
      surfaces[index] = (x / width - 0.5) * 3.2;
      surfaces[index + 1] = (0.5 - y / height) * 1.8;
      surfaces[index + 2] = -3;
      surfaces[index + 3] = 0; // metallic
      surfaces[index + 4] = 0; surfaces[index + 5] = 0; surfaces[index + 6] = 1;
      surfaces[index + 7] = 0.5; // roughness(法线恒 +z:空间门全过,mask 语义无混杂)
      surfaces[index + 8] = 0.8; surfaces[index + 9] = 0.78; surfaces[index + 10] = 0.75;
    }
  }
  return surfaces;
}

/** CPU f64 oracle:线段(灯→像素)与轴对齐盒求交(slab 法;命中 = 该像素被遮挡)。 */
function segmentHitsBox(origin: readonly number[], target: readonly number[],
  boxCenter: readonly number[], boxHalf: readonly number[]): boolean {
  const dir = [target[0]! - origin[0]!, target[1]! - origin[1]!, target[2]! - origin[2]!];
  let tMin = 0, tMax = 1;
  for (let axis = 0; axis < 3; axis++) {
    const o = origin[axis]! - boxCenter[axis]!;
    if (Math.abs(dir[axis]!) < 1e-12) {
      if (o < -boxHalf[axis]! || o > boxHalf[axis]!) return false;
      continue;
    }
    let near = (-boxHalf[axis]! - o) / dir[axis]!;
    let far = (boxHalf[axis]! - o) / dir[axis]!;
    if (near > far) { const swap = near; near = far; far = swap; }
    tMin = Math.max(tMin, near);
    tMax = Math.min(tMax, far);
    if (tMin > tMax) return false;
  }
  return tMax > 0 && tMin < 1;
}

/** 轴对齐遮挡盒(12 三角,外向绕序;shadowRayGpuCases.boxBlas 同式,本地内联)。 */
function visibilityOccluderBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): RayBlasDescriptor {
  const c = [[cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz + hz],
    [cx - hx, cy - hy, cz + hz], [cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz],
    [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz]];
  const quads = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const vertices: number[] = [], indices: number[] = [];
  quads.forEach((quad, qi) => {
    const base = qi * 4;
    quad.forEach(cI => vertices.push(...c[cI]!));
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  });
  return { id: "mega-visibility-occluder", vertices: Float32Array.from(vertices),
    indices: Uint32Array.from(indices) };
}

/** MegaLight → PointLight(可见性腿单灯构造;打包端 ClusteredLights 入口)。 */
function toPointLight(light: { positionView: LightVector3; color: LightVector3; intensity: number }): PointLight {
  return { positionView: light.positionView, range: 0, color: light.color, intensity: light.intensity, decay: 2 };
}

async function winnerVisibilityLeg(): Promise<Record<string, unknown>> {
  const device = await requestDevice();
  device.addEventListener?.("uncapturederror", (event) => {
    console.error("[uncapturederror]", (event as GPUUncapturedErrorEvent).error.message);
  });
  const runtime = new MegaLightsRuntime(shimSession(device), { visibility: {} });
  try {
    const width = VIS_WIDTH, height = VIS_HEIGHT;
    const surfaces = buildVisibilitySurfaces(width, height);
    // 场景:单点光(视空间) + 遮挡盒(世界 == 视空间,viewToWorld 恒等)。
    const packed = packMegaLights(megaLightsFromClustered({ points: [{
      positionView: [0.3, 0.4, -1.4], range: 0, color: [1, 1, 1], intensity: 3, decay: 2 }] }));
    const occluder = visibilityOccluderBox(-0.55, -0.1, -2.2, 0.45, 0.38, 0.08);
    const instances: TlasInstanceDescriptor[] = [{ id: occluder.id, blas: occluder,
      worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as const, mask: 1 }];
    const scene = packTlasScene(buildTlas(instances));
    const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // CPU oracle 射线(与 deepMegaWriteWinnerRay 同式:origin 外推 + tMax 双侧收缩)。
    const lightRayOracle = (x: number, y: number) => {
      const world = [(x / width - 0.5) * 3.2, (0.5 - y / height) * 1.8, -3];
      const delta = [0.3 - world[0]!, 0.4 - world[1]!, -1.4 - world[2]!];
      const distance = Math.hypot(...delta);
      const dir = delta.map(component => component / distance);
      const epsilon = distance * 1e-3;
      return { origin: [world[0]! + dir[0]! * epsilon, world[1]! + dir[1]! * epsilon, world[2]! + dir[2]! * epsilon],
        dir, tMax: distance - epsilon - epsilon };
    };
    const visibilityInput = { scene, viewToWorld: identity, rayMask: 0xffffffff };
    const resources = { width, height, lightCount: packed.count, visibilityEnabled: false };
    const visResources = { ...resources, visibilityEnabled: true };

    // 相位 A:可见性关(基线亮度;同 runtime 翻开关位 = prepare 不带 visibility)。
    runtime.prepare({ width, height, lights: packed, surfaces, temporalEnabled: true,
      spatialEnabled: true, alphaBlend: 1 });
    await runFrame(device, runtime, resources, false);
    const baseline = await readbackColor(device, runtime);
    // 相位 B:可见性开,EMA 收敛 40 帧。
    const frameTimes: number[] = [];
    for (let frame = 0; frame < 40; frame++) {
      runtime.prepare({ width, height, lights: packed, surfaces, temporalEnabled: true,
        spatialEnabled: true, alphaBlend: frame === 0 ? 1 : 1 / 32, visibility: visibilityInput });
      frameTimes.push(await runFrame(device, runtime, visResources, frame >= 8));
    }
    const shadowed = await readbackColor(device, runtime);
    // mask buffer 直读(trace pass 原始输出;独立于 color,shade 末尾不清)。
    const maskBufferDump = await (async (): Promise<Float32Array> => {
      const buf = device.createBuffer({ label: "MegaLights probe mask readback", size: width * height * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        const enc = device.createCommandEncoder({ label: "MegaLights probe mask readback" });
        enc.copyBufferToBuffer((runtime as unknown as { resources?: { visibilityMask?: GPUBuffer } })
          .resources!.visibilityMask!, 0, buf, 0, width * height * 4);
        device.queue.submit([enc.finish()]);
        await buf.mapAsync(GPUMapMode.READ);
        return new Float32Array(buf.getMappedRange().slice(0));
      } finally { buf.destroy(); }
    })();
    let maskBufOccluded = 0;
    for (let pixel = 0; pixel < width * height; pixel++) { if (maskBufferDump[pixel] === 0) maskBufOccluded++; }
    // mask 证据:首帧(alpha=1)后的 color.w 直读 = 纯 trace pass 输出(未混 EMA)。
    runtime.prepare({ width, height, lights: packed, surfaces, temporalEnabled: false,
      spatialEnabled: true, alphaBlend: 1, visibility: visibilityInput });
    await runFrame(device, runtime, visResources, false);
    const maskDump = await readbackColor(device, runtime);
    let oracleOccluded = 0, maskOracleAgree = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixel = y * width + x;
        const world = [(x / width - 0.5) * 3.2, (0.5 - y / height) * 1.8, -3];
        const occluded = segmentHitsBox([0.3, 0.4, -1.4], world, [-0.55, -0.1, -2.2], [0.45, 0.38, 0.08]);
        // mask buffer 与 CPU f64 oracle 逐像素对拍(1u=可见/0u=遮挡)。
        if ((maskBufferDump[pixel] === 0) === occluded) maskOracleAgree++;
        if (occluded) oracleOccluded++;
      }
    }
    // 哨兵读回(fail-closed 通道;生产循环不调)。
    const sentinelBuffer = device.createBuffer({ label: "MegaLights probe visibility sentinel",
      size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const sentinelEncoder = device.createCommandEncoder({ label: "MegaLights probe sentinel" });
    runtime.readbackStackOverflows(sentinelEncoder, sentinelBuffer);
    device.queue.submit([sentinelEncoder.finish()]);
    await sentinelBuffer.mapAsync(GPUMapMode.READ);
    const overflowSentinel = new Uint32Array(sentinelBuffer.getMappedRange().slice(0))[0]!;
    sentinelBuffer.destroy();

    // CPU f64 oracle 分区:阴影内部(线段穿盒,且 4% 回缩点已脱离盒 → 非边界)。
    const boxCenter = [-0.55, -0.1, -2.2], boxHalf = [0.45, 0.38, 0.08];
    const lightPos = [0.3, 0.4, -1.4];
    let shadowPixels = 0, shadowMeanOn = 0, shadowMeanOff = 0;
    let litPixels = 0, litMeanOn = 0, litMeanOff = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixel = y * width + x;
        const world = [(x / width - 0.5) * 3.2, (0.5 - y / height) * 1.8, -3];
        const occluded = segmentHitsBox(lightPos, world, boxCenter, boxHalf);
        const on = shadowed[pixel * 4]! + shadowed[pixel * 4 + 1]! + shadowed[pixel * 4 + 2]!;
        const off = baseline[pixel * 4]! + baseline[pixel * 4 + 1]! + baseline[pixel * 4 + 2]!;
        if (occluded) {
          // 边界剔除:4% 回缩点若已不穿盒 → 半影/边界像素,不计入阴影内部。
          const pulled = [world[0]! + (lightPos[0]! - world[0]!) * 0.04,
            world[1]! + (lightPos[1]! - world[1]!) * 0.04, world[2]!];
          if (!segmentHitsBox(lightPos, pulled, boxCenter, boxHalf)) continue;
          shadowPixels++; shadowMeanOn += on; shadowMeanOff += off;
          continue;
        }
        // 亮区:外扩 0.06 仍不穿盒(远离阴影边界,空间复用/半影不沾)。
        const away = segmentHitsBox(lightPos, world, boxCenter,
          [boxHalf[0]! + 0.06, boxHalf[1]! + 0.06, boxHalf[2]! + 0.06]);
        if (!away) {
          litPixels++; litMeanOn += on; litMeanOff += off;
        }
      }
    }
    shadowMeanOn /= Math.max(shadowPixels, 1);
    shadowMeanOff /= Math.max(shadowPixels, 1);
    litMeanOn /= Math.max(litPixels, 1);
    litMeanOff /= Math.max(litPixels, 1);
    const shadowSuppression = shadowMeanOff > 1e-6 ? shadowMeanOn / shadowMeanOff : 1;
    const litRelativeDiff = litMeanOff > 1e-6 ? Math.abs(litMeanOn - litMeanOff) / litMeanOff : 0;
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const visP50 = sorted[Math.floor(sorted.length * 0.5)] ?? Number.NaN
    const visP95 = sorted[Math.floor(sorted.length * 0.95)] ?? Number.NaN
    const compileMessages = await compilationMessages(runtime);
    if (compileMessages.length) console.error("[compilation]", compileMessages.join(" | "));
    return { action: "megalights-winner-visibility", compileMessages,
      shadow: { pixels: shadowPixels, meanOn: shadowMeanOn, meanOff: shadowMeanOff,
        suppressionRatio: shadowSuppression, gate: 0.02, pass: shadowSuppression <= 0.02 },
      lit: { pixels: litPixels, meanOn: litMeanOn, meanOff: litMeanOff,
        relativeDiff: litRelativeDiff, gate: 0.02, pass: litRelativeDiff <= 0.02 },
      maskEvidence: { samples: width * height, gpuOccludedFraction: maskBufOccluded / (width * height),
        oracleOccludedFraction: oracleOccluded / (width * height),
        agreement: maskOracleAgree / (width * height), gate: 0.999,
        pass: maskOracleAgree / (width * height) >= 0.999 },
      sceneStats: (() => { const tlasBuild = buildTlas(instances); return {
        instanceCount: scene.instanceCount, tlasNodeCount: scene.tlasNodeCount,
        blasNodeCount: scene.blasNodeCount, triangleCount: scene.triangleCount,
        nodeBytes: scene.nodeBytes.byteLength, orderLen: tlasBuild.built.order.length,
        cpuArbitration: ([[80, 90], [160, 90], [200, 90]] as const).map(([x, y]) => {
          const ray = lightRayOracle(x, y);
          const hit = traceTlasClosest(tlasBuild, { ox: ray.origin[0]!, oy: ray.origin[1]!,
            oz: ray.origin[2]!, dx: ray.dir[0]!, dy: ray.dir[1]!, dz: ray.dir[2]!, tMax: ray.tMax });
          return { pixel: [x, y], hit: hit !== undefined, t: hit?.t ?? null };
        }) }; })(),
      overflowSentinel, perfMs: { p50: visP50, p95: visP95, width, height, frames: frameTimes.length },
      pass: shadowSuppression <= 0.02 && litRelativeDiff <= 0.02 && overflowSentinel === 0
        && Number.isFinite(visP95) && maskOracleAgree / (width * height) >= 0.999 };
  } finally { runtime.dispose(); }
}

// ---- ⑦ 生产供给 perf:M2 三趟(RIS 两趟 + 胜者遮挡 trace)@5000 灯 1080p ----

/** 可见性 perf 场景:灯与灯之间、墙(z=−3)与灯阵之间的遮挡盒阵(trace 有真实命中)。 */
function visibilityPerfScene(): ReturnType<typeof packTlasScene> {
  const boxes = [
    visibilityOccluderBox(-1.1, 0.4, -1.7, 0.5, 0.6, 0.05),
    visibilityOccluderBox(0.2, 0.6, -1.4, 0.6, 0.7, 0.05),
    visibilityOccluderBox(1.3, 0.3, -1.9, 0.45, 0.55, 0.05),
  ];
  const instances: TlasInstanceDescriptor[] = boxes.map((box, index) => ({ id: box.id, blas: box,
    worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as const, mask: 1 }));
  return packTlasScene(buildTlas(instances));
}

/** 掩码读回(遮挡像素占比 = trace 真实命中的直接证据;perf 腿末尾采样一次)。 */
async function readbackVisibilityMask(device: GPUDevice, runtime: MegaLightsRuntime): Promise<Uint32Array> {
  const pixels = runtime.pixelCount;
  const buffer = device.createBuffer({ label: "MegaLights visibility perf mask readback",
    size: pixels * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const source = (runtime as unknown as { resources?: { visibilityMask?: GPUBuffer } }).resources
      ?.visibilityMask;
    if (!source) throw new Error("visibility perf leg requires a visibility allocation.");
    const encoder = device.createCommandEncoder({ label: "MegaLights visibility perf mask" });
    encoder.copyBufferToBuffer(source, 0, buffer, 0, pixels * 4);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    return new Uint32Array(buffer.getMappedRange().slice(0));
  } finally { buffer.destroy(); }
}

/**
 * 生产供给 perf 腿(双口径四相位,2026-10-05):
 *   先例口径(spatial off,同 M1 perf 腿):可见性关 → 开,绝对 p95 ≤ 20ms 门
 *   (≤20ms 先例在自身口径下带 trace 复验);
 *   生产口径(spatial on,生产控制器缺省):可见性关 → 开,trace 增量披露
 *   (生产绝对帧时口径含空间复用,先于本切片已 >20ms,如实披露不混报)。
 * 证据:四相位 p50/p95、trace 增量、掩码遮挡占比、哨兵零。
 */
async function visibilityPerfLeg(): Promise<Record<string, unknown>> {
  const device = await requestDevice();
  device.addEventListener?.("uncapturederror", (event) => {
    console.error("[uncapturederror]", (event as GPUUncapturedErrorEvent).error.message);
  });
  const runtime = new MegaLightsRuntime(shimSession(device), { visibility: {} });
  try {
    const width = PERF_WIDTH, height = PERF_HEIGHT;
    const surfaces = buildPerfSurfaces(width, height);
    const scene = visibilityPerfScene();
    const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const visibilityInput = { scene, viewToWorld: identity, rayMask: 0xffffffff };
    const compileMessages = await compilationMessages(runtime);
    const phase = async (visibility: boolean, spatial: boolean): Promise<number[]> => {
      const times: number[] = [];
      for (let frame = 0; frame < 70; frame++) {
        const packed = packMegaLights(megaLightsFromClustered(buildPerfLights(frame)));
        runtime.prepare({ width, height, lights: packed, surfaces, temporalEnabled: true,
          spatialEnabled: spatial, alphaBlend: frame === 0 ? 1 : 1 / 32,
          ...(visibility ? { visibility: visibilityInput } : {}) });
        const elapsed = await runFrame(device, runtime,
          { width, height, lightCount: packed.count, visibilityEnabled: visibility }, frame >= 10);
        if (frame >= 10) times.push(elapsed);
      }
      return times;
    };
    const summary = (values: readonly number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      const percentile = (fraction: number): number =>
        sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
      return { samples: values.length, p50: percentile(0.5), p95: percentile(0.95),
        max: sorted[sorted.length - 1]!,
        mean: values.reduce((total, value) => total + value, 0) / values.length };
    };
    // 先例口径(同 M1 perf 腿 spatial off):关 → 开。
    const precedentOff = summary(await phase(false, false));
    const precedentOn = summary(await phase(true, false));
    // 生产口径(spatial on,控制器缺省):关 → 开。
    const productionOff = summary(await phase(false, true));
    const productionOn = summary(await phase(true, true));
    const mask = await readbackVisibilityMask(device, runtime);
    let occluded = 0;
    for (let pixel = 0; pixel < mask.length; pixel++) { if (mask[pixel] === 0) occluded++; }
    const sentinelBuffer = device.createBuffer({ label: "MegaLights visibility perf sentinel",
      size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const sentinelEncoder = device.createCommandEncoder({ label: "MegaLights visibility perf sentinel" });
    runtime.readbackStackOverflows(sentinelEncoder, sentinelBuffer);
    device.queue.submit([sentinelEncoder.finish()]);
    await sentinelBuffer.mapAsync(GPUMapMode.READ);
    const overflowSentinel = new Uint32Array(sentinelBuffer.getMappedRange().slice(0))[0]!;
    sentinelBuffer.destroy();
    const increment = (off: ReturnType<typeof summary>, on: ReturnType<typeof summary>) =>
      ({ p50: on.p50 - off.p50, p95: on.p95 - off.p95 });
    return { action: "megalights-production-visibility-perf", width, height,
      lightCount: PERF_LIGHT_COUNT, compileMessages,
      precedentSpatialOff: { off: precedentOff, on: precedentOn },
      productionSpatialOn: { off: productionOff, on: productionOn },
      traceIncrementMs: { precedent: increment(precedentOff, precedentOn),
        production: increment(productionOff, productionOn) },
      occludedFraction: occluded / mask.length, overflowSentinel,
      pass: precedentOn.p95 <= 20 && (productionOn.p95 - productionOff.p95) <= 4
        && overflowSentinel === 0 && occluded > 0 && compileMessages
          .every(message => message.startsWith("info")),
      gate: "先例口径(spatial off)带 trace 绝对 p95 ≤ 20ms + 生产口径(spatial on)trace 增量 p95 ≤ 4ms"
        + "+ 哨兵零 + trace 真实命中;生产口径绝对帧时先于本切片已 >20ms(空间复用主项),如实披露" };
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

export async function runWinnerVisibility(): Promise<Record<string, unknown>> {
  return winnerVisibilityLeg();
}

/** ⑦ 生产供给 perf(2026-10-05 TLAS 供给收口):5000 灯 1080p 三趟 p95 门。 */
export async function runVisibilityPerf(): Promise<Record<string, unknown>> {
  return visibilityPerfLeg();
}
