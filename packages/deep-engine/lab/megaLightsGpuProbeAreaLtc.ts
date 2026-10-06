// megaLightsGpuProbe ④ 面积光 GPU 腿(体量门拆分;条目逐字未改):
// 既有 LTC 交付核(DEEP_AREA_LIGHTING_WGSL)compute 复用 ↔ evaluateAreaLightCpu 网格 RMS。
import { AREA_LIGHT_DATA_VEC4S, AREA_LIGHT_DATA_VEC4_TOTAL, packAreaLights, type AreaLight } from "../src/lighting/areaLights.js";
import { evaluateAreaLightCpu } from "../src/lighting/ltc.js";
import { DEEP_AREA_LIGHTING_WGSL } from "../src/lighting/ltcAreaLightingWgsl.js";
import { decodeLtcLut } from "../src/lighting/ltcTables.js";
import type { MegaLight } from "../src/lighting/megaLights.js";
import type { LightVector3 } from "../src/lighting/types.js";
import { requestDevice } from "./megaLightsGpuProbeShared.js";

export async function areaLightLtcLeg(): Promise<Record<string, unknown>> {
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
