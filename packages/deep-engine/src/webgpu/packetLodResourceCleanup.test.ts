import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRenderPacket, type RenderPacket } from "../renderPacket.js";
import { planCascadedShadows } from "../shadows/cascadedShadowPlanner.js";
import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { PacketLodResources } from "./packetLodResources.js";
import { PacketLodSceneCache } from "./packetLodSceneCache.js";
import { PacketShadowLodResources } from "./packetShadowLodResources.js";

interface FakeBuffer extends GPUBuffer {
  readonly label: string;
  readonly destroy: ReturnType<typeof vi.fn>;
}

function gpuFixture() {
  const owned = new Set<FakeBuffer>(), allocated: FakeBuffer[] = [];
  let createFailure: string | undefined, destroyFailure: string | undefined;
  let destroyFailureUsed = false, writeFailure: string | undefined;
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxUniformBufferBindingSize: 65_536, maxComputeWorkgroupsPerDimension: 65_535 },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      if (descriptor.label === createFailure) throw new Error(`create failed: ${descriptor.label}`);
      const value = { ...descriptor, mapState: "unmapped", destroy: vi.fn(() => {
        if (value.label === destroyFailure && !destroyFailureUsed) {
          destroyFailureUsed = true; throw new Error(`destroy failed: ${value.label}`);
        }
      }) } as unknown as FakeBuffer;
      allocated.push(value); return value;
    }),
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    queue: { writeBuffer: vi.fn((buffer: FakeBuffer) => {
      if (buffer.label === writeFailure) { writeFailure = undefined; throw new Error(`write failed: ${buffer.label}`); }
    }) },
  };
  const session = { state: "ready", device,
    own<T extends FakeBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: FakeBuffer): void { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
  const encoder = { beginComputePass: vi.fn(() => pass) } as unknown as GPUCommandEncoder;
  return { session, encoder, owned, allocated,
    byLabel: (label: string) => allocated.filter(value => value.label === label),
    failCreate: (label: string) => { createFailure = label; },
    failDestroy: (label: string) => { destroyFailure = label; destroyFailureUsed = false; },
    failWrite: (label: string) => { writeFailure = label; },
  };
}

const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1];
function packet(count: number): RenderPacket {
  const geometry = (id: string, scale: number) => ({ id, revision: 0, vertices: new Float32Array([
    -scale, 0, 0, 0, 0, 1, scale, 0, 0, 0, 0, 1, 0, scale, 0, 0, 0, 1,
  ]), indices: new Uint32Array(id === "fine" ? [0, 1, 2, 0, 2, 1] : [0, 1, 2]) });
  const lod = { levels: [
    { geometry: "fine", minProjectedDiameterPixels: 80, geometricError: 0, resident: true },
    { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 1, resident: true },
  ] } as const;
  return { geometries: [geometry("fine", 1), geometry("coarse", 0.5)],
    materials: [{ id: "surface", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
    instances: Array.from({ length: count }, (_, index) => ({ id: `part-${index}`,
      geometry: "fine", material: "surface", transform: matrix, lod })) };
}

function packetInputs(count: number) {
  const prepared = prepareRenderPacket(packet(count)), source = prepared.batches[0]!;
  const batch = { source, buffer: {} as GPUBuffer, capacity: count, previousBuffer: {} as GPUBuffer,
    previousCapacity: count, previousTransforms: new Float32Array(count * 12) } satisfies CachedPacketBatch;
  const geometries = new Map<string, CachedPacketGeometry>();
  for (const [id, value] of prepared.geometries) geometries.set(id, {
    source: value, mesh: {} as CachedPacketGeometry["mesh"], center: [0, 0, 0], radius: 1,
  });
  return { batches: new Map([[source.key, batch]]), geometries };
}

const view = { camera: { projection: "perspective" as const, position: [0, 0, 0] as const,
  forward: [0, 0, 1] as const, verticalFovRadians: Math.PI / 2, near: 0.1, far: 100 },
  viewport: { width: 640, height: 480 }, frustum: { planes: [[1, 0, 0, 100], [-1, 0, 0, 100],
    [0, 1, 0, 100], [0, -1, 0, 100], [0, 0, 1, 100], [0, 0, -1, 100]] as const } };
const shadowPlan = () => planCascadedShadows({ eye: [0, 0, 0], target: [0, 0, 1], near: 0.1, far: 100,
  verticalFovRadians: Math.PI / 2, aspect: 1 }, [0, -1, 0], { cascadeCount: 3, shadowMapSize: 64 });

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 });
  vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 4, COPY_DST: 8, VERTEX: 32,
    UNIFORM: 64, STORAGE: 128, INDIRECT: 256 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("packet LOD resource cleanup", () => {
  it("detaches a shared scene and releases both buffers when the first destroy throws", () => {
    const f = gpuFixture(), cache = new PacketLodSceneCache(f.session), input = packetInputs(1);
    cache.prepare([...input.batches.values()], input.geometries, input.geometries, 1);
    f.failDestroy("Deep packet LOD objects");
    expect(() => cache.clear()).toThrow(AggregateError);
    expect(f.byLabel("Deep packet LOD objects")[0]!.destroy).toHaveBeenCalledOnce();
    expect(f.byLabel("Deep packet LOD levels")[0]!.destroy).toHaveBeenCalledOnce();
    expect(f.owned.size).toBe(0); expect(() => cache.clear()).not.toThrow();
  });

  it("publishes a replacement scene before reporting complete old-scene retirement", () => {
    const f = gpuFixture(), cache = new PacketLodSceneCache(f.session), small = packetInputs(1), large = packetInputs(8);
    cache.prepare([...small.batches.values()], small.geometries, small.geometries, 1);
    f.failDestroy("Deep packet LOD objects");
    expect(() => cache.prepare([...large.batches.values()], large.geometries, large.geometries, 2)).toThrow(AggregateError);
    const installed = cache.prepare([...large.batches.values()], large.geometries, large.geometries, 2);
    expect(installed.count).toBe(8); expect(f.byLabel("Deep packet LOD objects")).toHaveLength(2);
    expect(f.byLabel("Deep packet LOD levels")[0]!.destroy).toHaveBeenCalledOnce();
    expect(f.owned.size).toBe(2); cache.clear(); expect(f.owned.size).toBe(0);
  });

  it("invalidates a partially overwritten reusable scene and preserves both failures", () => {
    const f = gpuFixture(), cache = new PacketLodSceneCache(f.session), input = packetInputs(1);
    cache.prepare([...input.batches.values()], input.geometries, input.geometries, 1);
    f.failWrite("Deep packet LOD levels"); f.failDestroy("Deep packet LOD objects");
    expect(() => cache.prepare([...input.batches.values()], input.geometries, input.geometries, 2))
      .toThrow("Packet LOD scene preparation failed");
    expect(f.byLabel("Deep packet LOD levels")[0]!.destroy).toHaveBeenCalledOnce();
    expect(f.owned.size).toBe(0);
    cache.prepare([...input.batches.values()], input.geometries, input.geometries, 2);
    expect(f.byLabel("Deep packet LOD objects")).toHaveLength(2); cache.clear();
  });

  it("rolls back every allocated draw buffer while preserving the create failure", () => {
    const f = gpuFixture(), resources = new PacketLodResources(f.session), input = packetInputs(1);
    f.failCreate("Deep packet LOD draw parameters"); f.failDestroy("Deep packet LOD compacted instances");
    expect(() => resources.encode(f.encoder, input.batches, input.geometries, 1, view, input.geometries))
      .toThrow("Packet LOD draw allocation failed");
    for (const label of ["Deep packet LOD compacted instances", "Deep packet LOD compacted previous transforms",
      "Deep packet LOD level local prefix", "Deep packet LOD level block offsets", "Deep packet LOD indirect draws"]) {
      expect(f.byLabel(label)[0]!.destroy, label).toHaveBeenCalledOnce();
    }
    expect(f.owned.size).toBe(2); resources.dispose(); expect(f.owned.size).toBe(0);
  });

  it("installs new draw resources before a superseded buffer destroy failure", () => {
    const f = gpuFixture(), resources = new PacketLodResources(f.session), small = packetInputs(1), large = packetInputs(8);
    resources.encode(f.encoder, small.batches, small.geometries, 1, view, small.geometries); resources.commitFrame();
    f.failDestroy("Deep packet LOD compacted instances");
    expect(() => resources.encode(f.encoder, large.batches, large.geometries, 2, view, large.geometries))
      .toThrow("Packet LOD draw disposal failed");
    const allocatedAfterFailure = f.byLabel("Deep packet LOD compacted instances").length;
    resources.encode(f.encoder, large.batches, large.geometries, 2, view, large.geometries); resources.commitFrame();
    expect(f.byLabel("Deep packet LOD compacted instances")).toHaveLength(allocatedAfterFailure);
    expect(f.byLabel("Deep packet LOD compacted previous transforms")[0]!.destroy).toHaveBeenCalledOnce();
    resources.dispose(); expect(f.owned.size).toBe(0);
  });

  it("commits new selector and scene state before old selector retirement reports failure", () => {
    const f = gpuFixture(), resources = new PacketLodResources(f.session), small = packetInputs(1), large = packetInputs(8);
    resources.encode(f.encoder, small.batches, small.geometries, 1, view, small.geometries); resources.commitFrame();
    resources.encode(f.encoder, large.batches, large.geometries, 2, view, large.geometries);
    f.failDestroy("Deep GPU LOD persistent history");
    expect(() => resources.commitFrame()).toThrow(AggregateError);
    expect(f.byLabel("Deep GPU LOD persistent history")[0]!.destroy).toHaveBeenCalledOnce();
    expect(f.byLabel("Deep GPU LOD selection records")[0]!.destroy).toHaveBeenCalledOnce();
    expect(f.byLabel("Deep GPU LOD view")[0]!.destroy).toHaveBeenCalledOnce();
    expect(resources.encode(f.encoder, large.batches, large.geometries, 2, view, large.geometries).historyReset).toBe(false);
    resources.commitFrame(); resources.dispose(); expect(f.owned.size).toBe(0);
  });

  it("disposes every selector, scene, draw, and input buffer after one destroy fails", () => {
    const f = gpuFixture(), resources = new PacketLodResources(f.session), input = packetInputs(2);
    resources.encode(f.encoder, input.batches, input.geometries, 1, view, input.geometries); resources.commitFrame();
    f.failDestroy("Deep GPU LOD persistent history");
    expect(() => resources.dispose()).toThrow(AggregateError);
    expect(f.owned.size).toBe(0); expect(() => resources.dispose()).not.toThrow();
    expect(f.allocated.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });

  it("cancels all shadow cascades after a release failure in the first cascade", () => {
    const f = gpuFixture(), inputs = new PacketLodSceneCache(f.session);
    const shadows = new PacketShadowLodResources(f.session, inputs), input = packetInputs(2);
    shadows.encode(f.encoder, input.batches, input.geometries, 1, shadowPlan(), input.geometries);
    f.failDestroy("Deep GPU LOD persistent history");
    expect(() => shadows.cancelFrame()).toThrow(AggregateError);
    expect(f.byLabel("Deep GPU LOD persistent history")).toHaveLength(3);
    expect(f.byLabel("Deep GPU LOD persistent history").every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    expect(f.byLabel("Deep packet LOD budget records").every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    expect(() => shadows.cancelFrame()).not.toThrow();
    shadows.dispose(); inputs.clear(); expect(f.owned.size).toBe(0);
  });

  it("detaches every shadow cascade before disposal reports a nested cleanup failure", () => {
    const f = gpuFixture(), inputs = new PacketLodSceneCache(f.session);
    const shadows = new PacketShadowLodResources(f.session, inputs), input = packetInputs(2);
    shadows.encode(f.encoder, input.batches, input.geometries, 1, shadowPlan(), input.geometries);
    shadows.commitFrame(); f.failDestroy("Deep GPU LOD persistent history");
    expect(() => shadows.dispose()).toThrow(AggregateError);
    expect([0, 1, 2].every(index => shadows.cascade(index) === undefined)).toBe(true);
    expect(f.byLabel("Deep GPU LOD persistent history").every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    expect(f.byLabel("Deep packet LOD compacted instances").every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    expect(() => shadows.dispose()).not.toThrow(); inputs.clear(); expect(f.owned.size).toBe(0);
  });

  it("retires all removed shadow cascades even when the first cascade cleanup fails", () => {
    const f = gpuFixture(), inputs = new PacketLodSceneCache(f.session);
    const shadows = new PacketShadowLodResources(f.session, inputs), input = packetInputs(2), full = shadowPlan();
    shadows.encode(f.encoder, input.batches, input.geometries, 1, full, input.geometries); shadows.commitFrame();
    f.failDestroy("Deep GPU LOD persistent history");
    expect(() => shadows.encode(f.encoder, input.batches, input.geometries, 1,
      { ...full, cascades: full.cascades.slice(0, 1) }, input.geometries)).toThrow(AggregateError);
    expect(shadows.cascade(0)).toBeDefined(); expect(shadows.cascade(1)).toBeUndefined();
    expect(shadows.cascade(2)).toBeUndefined();
    expect(f.byLabel("Deep GPU LOD persistent history").map(value => value.destroy.mock.calls.length)).toEqual([0, 1, 1]);
    shadows.dispose(); inputs.clear(); expect(f.owned.size).toBe(0);
  });
});
