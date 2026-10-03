// Probe scene radiance producer 测试(sourceSizeGate 拆分:夹具/场景包/上下文/光照输入
// 移至 probeSceneRadianceProducer.testUtils.ts,代码逐行同源;describe/it 名零变化,
// 语义零变化——外部证据按测试名引用不受影响)。
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import {
  emitProbeRadianceKernelWgsl, packProbeRadianceProbeParams, packProbeRadianceUniform,
  PROBE_RADIANCE_MOMENT_LANES, PROBE_RADIANCE_UNIFORM_BYTES,
} from "./probeRadianceKernel.js";
import { probeOcclusionDirection } from "./probeOcclusionRayExtension.js";
import {
  ProbeSceneRadianceProducer,
} from "./probeSceneRadianceProducer.js";
import { captureContext, fixture, planePacket, sunlit, update } from "./probeSceneRadianceProducer.testUtils.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, MAP_READ: 8 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("probe radiance kernel packing", () => {
  const directions = Array.from({ length: 8 }, (_, ordinal) =>
    probeOcclusionDirection(ordinal, 8));

  it("packs the 576-byte uniform with u32 head, tMax bitcast, three vec4 lanes and the CPU direction table", () => {
    const data = packProbeRadianceUniform({ updateCount: 3, directionCount: 8, rayMask: 1,
      tMax: 12.5, surfaceToLight: [0, 1, 0], lightColor: [1, 0.9, 0.8], lightIntensity: 2.5,
      ambient: [0.05, 0.06, 0.07], directions });
    expect(data.byteLength).toBe(PROBE_RADIANCE_UNIFORM_BYTES);
    expect(new Uint32Array(data, 0, 3)).toEqual(new Uint32Array([3, 8, 1]));
    const floats = new Float32Array(data);
    expect(floats[3]).toBe(12.5);
    expect([...floats.slice(4, 8)]).toEqual([0, 1, 0, 2.5]);
    expect(floats[8]).toBeCloseTo(1); expect(floats[9]).toBeCloseTo(0.9); expect(floats[10]).toBeCloseTo(0.8);
    expect(floats[11]).toBe(0);
    expect(floats[12]).toBeCloseTo(0.05); expect(floats[13]).toBeCloseTo(0.06);
    expect(floats[14]).toBeCloseTo(0.07); expect(floats[15]).toBe(0);
    // Direction lanes start at float offset 16, one vec4 per ordinal.
    directions.forEach((direction, ordinal) => {
      expect(floats[16 + ordinal * 4]).toBeCloseTo(direction[0]);
      expect(floats[16 + ordinal * 4 + 1]).toBeCloseTo(direction[1]);
      expect(floats[16 + ordinal * 4 + 2]).toBeCloseTo(direction[2]);
      expect(floats[16 + ordinal * 4 + 3]).toBe(0);
    });
  });

  it("packs all 32 production direction lanes without truncation and rejects overflow", () => {
    const dirs = Array.from({ length: 32 }, (_, index) => probeOcclusionDirection(index, 32));
    const input = { updateCount: 1, directionCount: 32, rayMask: 1, tMax: 32,
      surfaceToLight: [0, 1, 0] as const, lightColor: [1, 1, 1] as const,
      lightIntensity: 1, ambient: [0, 0, 0] as const, directions: dirs };
    const packed = new Float32Array(packProbeRadianceUniform(input));
    expect(packed.length).toBe(144);
    expect([...packed.slice(140, 143)]).toEqual(dirs[31]!.map(value => Math.fround(value)));
    expect(() => packProbeRadianceUniform({ ...input, directionCount: 33 })).toThrow(RangeError);
  });

  it("rejects a direction table shorter than the declared direction count", () => {
    expect(() => packProbeRadianceUniform({ updateCount: 1, directionCount: 8, rayMask: 1,
      tMax: 1, surfaceToLight: [0, 1, 0], lightColor: [1, 1, 1], lightIntensity: 1,
      ambient: [0, 0, 0], directions: directions.slice(0, 4) })).toThrow(/one direction per sample/);
  });

  it("packs one 32-byte record per probe with position, layer and texel cell", () => {
    const data = packProbeRadianceProbeParams([
      { position: [1, 2, 3], layer: 5, cellX: 2, cellY: 1 },
      { position: [-1, 0.5, 7], layer: 11, cellX: 3, cellY: 0 }]);
    expect(data.byteLength).toBe(64);
    const floats = new Float32Array(data);
    expect([...floats.slice(0, 8)]).toEqual([1, 2, 3, 5, 2, 1, 0, 0]);
    expect([...floats.slice(8, 16)]).toEqual([-1, 0.5, 7, 11, 3, 0, 0, 0]);
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-probe-radiance.wgsl", "--input-kind", "wgsl"],
      { input: emitProbeRadianceKernelWgsl(), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("Validation successful");
  });
});

describe("probe scene radiance producer", () => {
  it("validates options fail-fast", () => {
    const { device } = fixture();
    expect(() => new ProbeSceneRadianceProducer(device, { directionCount: 0 })).toThrow(RangeError);
    expect(() => new ProbeSceneRadianceProducer(device, { directionCount: 33 })).toThrow(RangeError);
    expect(() => new ProbeSceneRadianceProducer(device, { maxDistance: 0 })).toThrow(RangeError);
    expect(() => new ProbeSceneRadianceProducer(device, { maxDistance: 1_000_001 })).toThrow(RangeError);
  });

  it("captures real moments with an optional texture while keeping eight compute storage buffers", () => {
    const f = fixture(), producer = new ProbeSceneRadianceProducer(f.device);
    producer.syncScene(planePacket()); producer.syncLighting(sunlit);
    const input = { ...captureContext(f.device, 10, [update(0, [0, 1, 0])]),
      momentsDestinationView: { label: "raw-moments" } as unknown as GPUTextureView };
    producer.encodeSourceRadiance(input as never);
    const bind = f.rawDevice.createBindGroup.mock.calls.at(-1)![0];
    expect(bind.entries.find(entry => entry.binding === 10)!.resource).toBe(input.momentsDestinationView);
    const code = emitProbeRadianceKernelWgsl(true);
    expect(code.match(/var<storage/g)).toHaveLength(8);
    expect(code).toContain("momentM2 += momentDelta * (t - momentMean)");
    expect(code).toContain("f32(misses) / f32(params.directionCount)");
    expect(code).toContain("rgba32float");
    // F5 方案 A：逐方向贡献快照 + 均值扣除 L1 投影 + lane1..3 RGB SH 写出（lane 合同
    // 与 webgpuProbeMoments/probeClipmapTextureSamplingWgsl 单源共享）。
    expect(code).toContain("var shSamples: array<vec3f, 32>;");
    expect(code).toContain("let centered = shSamples[shOrdinal] - mean;");
    expect(code).toContain("shR = vec4f(shR.xyz * shInverseCount, mean.r);");
    expect(code.match(/u32\(layer\) \* 4u \+ 1u/g)).toHaveLength(2);
    expect(code).toContain(`u32(layer) * ${PROBE_RADIANCE_MOMENT_LANES}u`);
    expect(emitProbeRadianceKernelWgsl()).not.toContain("captureMoments");
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates the optional moment capture with Naga", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-moment-capture.wgsl", "--input-kind", "wgsl"],
      { input: emitProbeRadianceKernelWgsl(true), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("uploads the ray scene once per packet and dedupes by packet identity", () => {
    const f = fixture();
    const producer = new ProbeSceneRadianceProducer(f.device);
    const packet = planePacket();
    producer.syncScene(packet);
    const afterFirst = f.buffers.length;
    expect(afterFirst).toBeGreaterThanOrEqual(8); // uniform + overflow + 6 scene buffers
    expect(producer.sceneInstanceCount).toBe(1);
    producer.syncScene(packet);
    expect(f.buffers.length).toBe(afterFirst);
    producer.syncScene(planePacket());
    expect(f.buffers.length).toBeGreaterThan(afterFirst);
  });

  it("fails closed for all-transparent and invalid packets, with the reason on later captures", () => {
    const f = fixture();
    const producer = new ProbeSceneRadianceProducer(f.device);
    const updates = [update(0, [0, 1, 0])];
    producer.syncScene(planePacket([0.5, 0.5, 0.5], "BLEND"));
    expect(producer.sceneInstanceCount).toBe(0);
    expect(() => producer.encodeSourceRadiance(
      captureContext(f.device, 1, updates) as never)).toThrow(/unavailable/);
    const deformed = { ...planePacket(), deformation: { revision: 1 } } as unknown as RenderPacket;
    expect(() => producer.syncScene(deformed)).toThrow(/deform/i);
    expect(producer.sceneUnavailableReason).toMatch(/deform/i);
    producer.syncLighting(sunlit);
    expect(() => producer.encodeSourceRadiance(
      captureContext(f.device, 2, updates) as never)).toThrow(/undeformed geometry snapshot/);
  });

  it("refuses capture without a real radiance source instead of publishing a dark volume", () => {
    const f = fixture();
    const producer = new ProbeSceneRadianceProducer(f.device);
    producer.syncScene(planePacket());
    const updates = [update(0, [0, 1, 0])];
    expect(() => producer.encodeSourceRadiance(
      captureContext(f.device, 1, updates) as never)).toThrow(/real radiance source/);
    producer.syncLighting({ primary: { surfaceToLightWorld: [0, 1, 0], color: [1, 1, 1], intensity: 0 },
      ambient: [0, 0, 0] });
    expect(() => producer.encodeSourceRadiance(
      captureContext(f.device, 2, updates) as never)).toThrow(/real radiance source/);
    producer.syncLighting({ ambient: [0.2, 0.2, 0.2] });
    producer.encodeSourceRadiance(captureContext(f.device, 3, updates) as never);
    expect(f.encoders.at(-1)![0]!.dispatch).toEqual([[1]]);
  });

  it("keeps the F1 slice-2 ambient contract: environment-average ambient alone drives capture", () => {
    // F5-L4 裁定钉子:slice-1 头注释的 [0,0,0] 是过渡起步值;F1 slice-2(d1626b2f,
    // EnvironmentAmbientReader)交付后,宿主馈送的环境立方体 GPU 读回均值即本接口的
    // 文档正确值。禁止以"回到 F1 声明的 [0,0,0]"为由回退——那会让 miss 方向丢天空
    // 辐射(室外探针变暗)。本用例以 studio 环境实测均值 (0.525, 0.563, 0.613) 复现。
    const f = fixture();
    const producer = new ProbeSceneRadianceProducer(f.device);
    producer.syncScene(planePacket());
    const updates = [update(0, [0, 1, 0])];
    producer.syncLighting({ ambient: [0.525, 0.563, 0.613] });
    producer.encodeSourceRadiance(captureContext(f.device, 11, updates) as never);
    const uniformWrite = (f.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls
      .find(([, , data]) => data instanceof ArrayBuffer && data.byteLength === 576);
    expect(uniformWrite).toBeDefined();
    // params 布局(floats):[0..3]=u32 头+ tMax,ambient 在 float 12(字节 48)起的 vec3。
    const floats = new Float32Array(uniformWrite![2] as ArrayBuffer);
    expect(floats[12]).toBeCloseTo(0.525, 6);
    expect(floats[13]).toBeCloseTo(0.563, 6);
    expect(floats[14]).toBeCloseTo(0.613, 6);
    expect(floats[15]).toBe(0);
  });

  it("encodes one dispatch per generation, packs the latest lighting and stays idempotent", () => {
    const f = fixture();
    const producer = new ProbeSceneRadianceProducer(f.device, { directionCount: 4, maxDistance: 16 });
    producer.syncScene(planePacket());
    producer.syncLighting(sunlit);
    const baselineWrites = f.writeBufferCalls.length;
    const updates = [update(0, [0, 1, 0]), update(1, [1, 2, 1], [1, 0, 1])];
    const context = captureContext(f.device, 7, updates);
    producer.encodeSourceRadiance(context as never);
    expect(f.encoders[0]![0]!.label).toMatch(/scene radiance capture/);
    expect(f.encoders[0]![0]!.dispatch).toEqual([[1]]); // ceil(2/64)
    expect(f.writeBufferCalls.length - baselineWrites).toBe(3); // uniform + probe params + overflow
    expect(producer.lastBatchStats).toMatchObject({ generation: 7, updates: 2,
      directionCount: 4, maxDistance: 16, sceneInstances: 1 });
    const bindEntries = (f.rawDevice.createBindGroup as ReturnType<typeof vi.fn>).mock.calls[0]![0]!.entries;
    expect(bindEntries[8]!.resource).toBe(context.destinationView);
    const writesAfterFirst = f.writeBufferCalls.length;
    producer.encodeSourceRadiance(captureContext(f.device, 7, updates) as never);
    expect(f.writeBufferCalls.length).toBe(writesAfterFirst);
    producer.encodeSourceRadiance(captureContext(f.device, 8, updates) as never);
    expect(f.writeBufferCalls.length).toBe(writesAfterFirst + 3);
  });

  it("grows the probe parameter buffer only when the batch exceeds capacity", () => {
    const f = fixture();
    const producer = new ProbeSceneRadianceProducer(f.device);
    producer.syncScene(planePacket());
    producer.syncLighting(sunlit);
    producer.encodeSourceRadiance(captureContext(f.device, 1,
      Array.from({ length: 64 }, (_, index) => update(index, [index, 1, 0]))) as never);
    const afterSmallBatch = f.buffers.length;
    producer.encodeSourceRadiance(captureContext(f.device, 2,
      Array.from({ length: 65 }, (_, index) => update(index, [index, 1, 0]))) as never);
    expect(f.buffers.length).toBe(afterSmallBatch + 1); // reallocated for 65 > 64
    expect(f.encoders.at(-1)![0]!.dispatch).toEqual([[2]]);
  });

  it("rejects non-finite lighting vectors and negative intensities", () => {
    const f = fixture();
    const producer = new ProbeSceneRadianceProducer(f.device);
    expect(() => producer.syncLighting({ ambient: [0.1, NaN, 0.1] })).toThrow(RangeError);
    expect(() => producer.syncLighting({ primary: { surfaceToLightWorld: [0, 1, 0],
      color: [1, 1, 1], intensity: -1 }, ambient: [0, 0, 0] })).toThrow(RangeError);
    producer.syncLighting(sunlit);
    producer.dispose();
    expect(() => producer.syncLighting(sunlit)).toThrow(/disposed/);
    expect(() => producer.syncScene(planePacket())).toThrow(/disposed/);
    const destroyed = f.buffers.filter(buffer => (buffer.destroy as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(destroyed.length).toBe(f.buffers.length);
  });
});
