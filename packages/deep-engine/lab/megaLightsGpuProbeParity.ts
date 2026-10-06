// megaLightsGpuProbe ⑤ parity 腿(体量门拆分;条目逐字未改):
// 8 灯场景穷举模式(GPU ↔ CPU 精确和,退化一致性;容差吸收 GPU FMA)
// + RIS 单帧无偏性烟雾(严格无偏性由 CPU vitest 门守)。
import { DEEP_IES_SAMPLING_WGSL } from "../src/lighting/iesSamplingWgsl.js";
import { evaluateMegaLightCpu, packMegaLights, resolveDirectLightingPath } from "../src/lighting/megaLights.js";
import { megaLightsExhaustiveReferenceCpu, megaSurfaceDecodeCpu } from "../src/lighting/megaLightsRisCpu.js";
import { MEGA_LIGHTS_RIS_WGSL } from "../src/lighting/megaLightsRisWgsl.js";
import { MegaLightsRuntime } from "../src/lighting/megaLightsRuntime.js";
import type { LightVector3 } from "../src/lighting/types.js";
import { compilationMessages, readbackColor, requestDevice, runFrame, shimSession } from "./megaLightsGpuProbeShared.js";

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

export async function parityLeg(): Promise<Record<string, unknown>> {
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
