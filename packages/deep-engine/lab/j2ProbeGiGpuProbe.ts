/// <reference types="@webgpu/types" />
import { PROBE_CLIPMAP_SAMPLING_WGSL } from "../src/lighting/probeClipmapSamplingWgsl.js";
import { packIrradianceProbeRecord, sampleIrradianceProbeClipmap,
  type IrradianceProbeRecord } from "../src/lighting/probeClipmapSampling.js";
import { packProbeLevels } from "../src/lighting/probeClipmapResourceData.js";
import type { ProbeClipmapLevel, ProbeVector3 } from "../src/lighting/probeClipmapPlan.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";

interface ProbeCase { id: string; worldPosition: ProbeVector3; worldNormal: ProbeVector3;
  fineValidity?: number; meanDistance?: number; positionOffset?: ProbeVector3 }
interface Fixture { schema: string; tolerance: number; levels: ProbeClipmapLevel[];
  records: IrradianceProbeRecord[]; cases: ProbeCase[] }

export function recordsForCase(fixture: Fixture, test: ProbeCase): IrradianceProbeRecord[] {
  return fixture.records.map((record, index) => ({ ...record,
    validity: index < fixture.levels[0]!.probeCount ? test.fineValidity ?? record.validity : record.validity,
    meanDistance: test.meanDistance ?? record.meanDistance,
    positionOffset: test.positionOffset ?? record.positionOffset ?? [0, 0, 0] }));
}

// Test adapter for the existing Native header-stream ABI; Native leg uses its formal encoder.
function nativeRecords(fixture: Fixture, records: IrradianceProbeRecord[]): ArrayBuffer {
  const data = new Float32Array((1 + fixture.levels.length + records.length) * 24);
  data.set([2, fixture.levels.length, 1, 0], 12);
  let cursor = 1, base = 0;
  for (const level of fixture.levels) {
    data.set([...level.origin, level.spacing, ...level.gridSize, cursor + 1,
      ...level.origin.map((value, axis) => value + level.gridSize[axis]! * level.spacing), level.probeCount], cursor * 24);
    cursor++;
    for (const record of records.slice(base, base + level.probeCount)) {
      data.set(new Float32Array(packIrradianceProbeRecord(record)), cursor++ * 24);
    }
    base += level.probeCount;
  }
  return data.buffer;
}

export async function runJ2ProbeGiGpuProbe(fixture: Fixture, nativeSource: string, fixtureRaw: string) {
  const boundary = nativeSource.indexOf("fn section_rejected(");
  if (boundary < 0) throw Error("Native production GI source boundary changed");
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw Error("WebGPU hardware adapter unavailable");
  const device = await adapter.requestDevice(), errors: string[] = [];
  device.addEventListener("uncapturederror", event => errors.push(event.error.message));
  const variants = [
    { id: "shared-storage", source: PROBE_CLIPMAP_SAMPLING_WGSL, group: 3,
      call: "deepGiSample(receiver[0].xyz, receiver[1].xyz, vec3f(0))" },
    { id: "native-production-storage", source: nativeSource.slice(0, boundary), group: 0,
      call: "probe_gi_grid_trilinear(receiver[0].xyz, receiver[1].xyz)" },
  ];
  const results = [];
  try {
    for (const variant of variants) {
      const code = `${variant.source}
@group(1) @binding(0) var<storage,read> receiver: array<vec4f>;
@group(1) @binding(1) var<storage,read_write> result: array<vec4f>;
@compute @workgroup_size(1) fn probeMain() { result[0] = vec4f(${variant.call},1); }`;
      const pipeline = await device.createComputePipelineAsync({ layout: "auto",
        compute: { module: device.createShaderModule({ code }), entryPoint: "probeMain" } });
      for (const test of fixture.cases) {
        const owned: GPUBuffer[] = [];
        device.pushErrorScope("validation");
        try {
          const buffer = (data: ArrayBuffer, usage: number) => {
            const item = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
            device.queue.writeBuffer(item, 0, data); owned.push(item); return item;
          };
          const records = recordsForCase(fixture, test);
          const packed = new Float32Array(records.length * 24);
          records.forEach((record, index) => packed.set(new Float32Array(packIrradianceProbeRecord(record)), index * 24));
          const samplingEntries = variant.group === 3 ? [
            { binding: 9, resource: { buffer: buffer(packed.buffer, GPUBufferUsage.STORAGE) } },
            { binding: 10, resource: { buffer: buffer(packProbeLevels(fixture.levels), GPUBufferUsage.STORAGE) } },
          ] : [{ binding: 11, resource: { buffer: buffer(nativeRecords(fixture, records), GPUBufferUsage.STORAGE) } }];
          const input = buffer(new Float32Array([...test.worldPosition, 0, ...test.worldNormal, 0]).buffer, GPUBufferUsage.STORAGE);
          const output = buffer(new ArrayBuffer(16), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
          const readback = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); owned.push(readback);
          const io = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [
            { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }] });
          const sampling = device.createBindGroup({ layout: pipeline.getBindGroupLayout(variant.group), entries: samplingEntries });
          const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
          pass.setPipeline(pipeline); pass.setBindGroup(1, io); pass.setBindGroup(variant.group, sampling); pass.dispatchWorkgroups(1); pass.end();
          encoder.copyBufferToBuffer(output, 0, readback, 0, 16); device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const value = Array.from(new Float32Array(readback.getMappedRange()).slice(0, 3)); readback.unmap();
          const expected = sampleIrradianceProbeClipmap({ ...test, levels: fixture.levels, records }).irradiance;
          const maxError = Math.max(...value.map((channel, index) => Math.abs(channel - expected[index]!)));
          results.push({ leg: variant.id, id: test.id, sourceHash: sha256Utf8(code), value, expected, maxError,
            passed: value.every(Number.isFinite) && maxError <= fixture.tolerance });
        } finally {
          const scoped = await device.popErrorScope(); if (scoped) errors.push(scoped.message);
          for (const resource of owned.reverse()) resource.destroy();
        }
      }
    }
    return { fixtureHash: sha256Utf8(fixtureRaw), adapter: { vendor: adapter.info.vendor,
      architecture: adapter.info.architecture }, results, errors,
      passed: errors.length === 0 && results.every(row => row.passed),
      scope: "Chrome production-native-GI-functions + existing shared storage kernel; finite common input",
      excluded: ["Native wgpu host", "TS production texture semantics", "full frame parity", "GPU timing"] };
  } finally { device.destroy(); }
}
