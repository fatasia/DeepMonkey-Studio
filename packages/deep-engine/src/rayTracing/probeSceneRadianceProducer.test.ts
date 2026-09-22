import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProbeCaptureBeginContext } from "../lighting/probeClipmapCaptureExecutor.js";
import type { ProbeClipmapPlan, ProbeUpdate } from "../lighting/probeClipmapPlan.js";
import type { RenderPacket } from "../renderPacket.js";
import {
  emitProbeRadianceKernelWgsl, packProbeRadianceProbeParams, packProbeRadianceUniform,
  PROBE_RADIANCE_UNIFORM_BYTES,
} from "./probeRadianceKernel.js";
import { probeOcclusionDirection } from "./probeOcclusionRayExtension.js";
import {
  ProbeSceneRadianceProducer, type ProbeRadianceLighting,
} from "./probeSceneRadianceProducer.js";

interface FakeBuffer extends GPUBuffer { readonly destroy: ReturnType<typeof vi.fn> }
interface PassRecord { readonly label: string; readonly dispatch: number[][] }

function fixture() {
  const buffers: FakeBuffer[] = [];
  const encoders: PassRecord[][] = [];
  const writeBufferCalls: { buffer: unknown; offset: number; size?: number }[] = [];
  const lost = new Promise<GPUDeviceLostInfo>(() => {});
  const queue = { writeBuffer: vi.fn((buffer: GPUBuffer, offset: number, _data: BufferSource,
    size?: number) => { writeBufferCalls.push({ buffer, offset, size }); }),
    submit: vi.fn(), onSubmittedWorkDone: vi.fn(() => Promise.resolve()) };
  const device = {
    limits: {}, queue, lost,
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label,
      getBindGroupLayout: vi.fn((index: number) => ({ label: `layout-${index}` })) })),
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) =>
      ({ label, entries })),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { size: descriptor.size, usage: descriptor.usage,
        destroy: vi.fn() } as unknown as FakeBuffer; buffers.push(buffer); return buffer;
    }),
    createCommandEncoder: vi.fn(() => {
      const passes: PassRecord[] = []; encoders.push(passes);
      return { beginComputePass: vi.fn(({ label }: { label: string }) => {
        const pass: PassRecord = { label, dispatch: [] }; passes.push(pass);
        return { setPipeline: vi.fn(), setBindGroup: vi.fn(),
          dispatchWorkgroups: vi.fn((...args: number[]) => pass.dispatch.push(args)), end: vi.fn() };
      }) };
    }),
  };
  return { device: device as unknown as GPUDevice, rawDevice: device, queue, buffers,
    encoders, writeBufferCalls };
}

function planePacket(baseColor: readonly [number, number, number] = [0.5, 0.5, 0.5],
  alphaMode?: "OPAQUE" | "BLEND"): RenderPacket {
  // Ground plane at y=0 with upward normals (position+normal interleaved, 6 floats/vertex).
  const corners: [number, number][] = [[-4, -4], [4, -4], [4, 4], [-4, 4]];
  const vertices = new Float32Array(corners.flatMap(([x, z]) => [x, 0, z, 0, 1, 0]));
  return { geometries: [{ id: "ground", revision: 0, vertices, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }],
    materials: [{ id: "m", baseColor, metallic: 0, roughness: 1,
      ...(alphaMode ? { alphaMode } : {}) }],
    instances: [{ id: "ground-1", geometry: "ground", material: "m",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] };
}

function update(index: number, position: readonly [number, number, number],
  localCell: readonly [number, number, number] = [0, 0, 0], level = 0): ProbeUpdate {
  return Object.freeze({ level, cell: localCell, localCell, linearIndex: index,
    position: Object.freeze([...position]) as unknown as ProbeUpdate["position"], reason: "initial" });
}

function captureContext(device: GPUDevice, generation: number,
  updates: readonly ProbeUpdate[]) {
  const plan = { profile: { gridSize: [4, 2, 4] }, updates } as unknown as ProbeClipmapPlan;
  return {
    encoder: device.createCommandEncoder(),
    update: updates[0]!, updateIndex: 0,
    destination: {} as GPUTexture,
    destinationView: { label: "capture-view" } as unknown as GPUTextureView,
    destinationOrigin: Object.freeze({ x: 0, y: 0, z: 0 }),
    context: { generation, plan, deviceEpoch: "e", signal: new AbortController().signal,
      resource: {} } as unknown as ProbeCaptureBeginContext,
  };
}

const sunlit: ProbeRadianceLighting = {
  primary: { surfaceToLightWorld: [0, 1, 0], color: [1, 1, 1], intensity: 2 },
  ambient: [0.1, 0.1, 0.1] };

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, MAP_READ: 8 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("probe radiance kernel packing", () => {
  const directions = Array.from({ length: 8 }, (_, ordinal) =>
    probeOcclusionDirection(ordinal, 8));

  it("packs the 320-byte uniform with u32 head, tMax bitcast, three vec4 lanes and the CPU direction table", () => {
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
    expect(() => new ProbeSceneRadianceProducer(device, { directionCount: 17 })).toThrow(RangeError);
    expect(() => new ProbeSceneRadianceProducer(device, { maxDistance: 0 })).toThrow(RangeError);
    expect(() => new ProbeSceneRadianceProducer(device, { maxDistance: 1_000_001 })).toThrow(RangeError);
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
