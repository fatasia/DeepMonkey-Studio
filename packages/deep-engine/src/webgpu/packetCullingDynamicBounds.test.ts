import { expect, it, vi } from "vitest";
import { PacketCullingResources } from "./packetCulling.js";
import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { Frustum } from "./gpuFrustumCulling.js";
import type { DeformationBoundsEnvelope } from "./deformationBounds.js";

const gpu = vi.hoisted(() => ({ write: vi.fn(), dispose: vi.fn(), encode: vi.fn(), hiZ: vi.fn(), compact: vi.fn() }));
vi.mock("./hiZOcclusionCulling.js", () => ({ HI_Z_OCCLUSION_MIN_INSTANCES: 128,
  HiZOcclusionCuller: class { encode = gpu.hiZ; dispose = vi.fn(); } }));
vi.mock("./hiZInstanceCompactor.js", () => ({
  HiZInstanceCompactor: class { encode = gpu.compact; dispose = vi.fn(); } }));
vi.mock("./gpuFrustumCulling.js", () => ({ createGpuCullingPipelineContext: () => ({
  dispose: vi.fn(), createSharedInputs: (capacity: number) => ({ capacity,
    writeInstances: gpu.write, dispose: gpu.dispose,
    createPhase: (indexCount: number) => ({ indexCount, writeView: vi.fn(), encode: gpu.encode }),
  }),
}) }));

it("uploads changed dynamic bounds with unchanged geometry/instances, and restores static bounds", () => {
  gpu.write.mockClear();
  const owner = new PacketCullingResources({ device: { queue: {} } } as DeviceSession);
  const batches = new Map([["b", { source: { key: "b", geometry: "g", count: 64,
    alphaMode: "OPAQUE", data: new Float32Array(64 * 36) },
    previousTransforms: new Float32Array(64 * 12) } as CachedPacketBatch]]);
  const geometries = new Map([["g", { center: [0, 0, 0], radius: 1,
    source: { revision: 1 }, mesh: { indexCount: 3 } } as CachedPacketGeometry]]);
  const run = (radius?: number, phase: "opaque" | "shadow" = "opaque") => owner.encode(
    {} as GPUCommandEncoder, [] as unknown as Frustum, phase, batches, geometries, undefined, 0,
    radius === undefined ? undefined : new Map([["b", { center: [2, 0, 0] as const, radius, conservative: true }]]));
  run(3);
  expect(gpu.write.mock.calls.at(-1)![1][0].bounds).toEqual([2, 0, 0, 3]);
  run(4);
  expect(gpu.write).toHaveBeenCalledTimes(2);
  expect(gpu.write.mock.calls.at(-1)![1][0].bounds).toEqual([2, 0, 0, 4]);
  run(4, "shadow"); run(4);
  expect(gpu.write).toHaveBeenCalledTimes(2);
  run();
  expect(gpu.write).toHaveBeenCalledTimes(3);
  expect(gpu.write.mock.calls.at(-1)![1][0].bounds).toEqual([0, 0, 0, 1]);
  for (const invalid of [NaN, Infinity, -1, 0, 1e100]) {
    expect(() => run(invalid)).toThrow("Culling bounds");
    expect(owner.phase("b", "opaque")).toBeUndefined();
    expect(gpu.write).toHaveBeenCalledTimes(3);
  }
  run(4);
  expect(gpu.write).toHaveBeenCalledTimes(4);
  owner.dispose();
});

function fixture() {
  gpu.write.mockClear(); gpu.encode.mockReset();
  const owner = new PacketCullingResources({ device: { queue: {} } } as DeviceSession);
  const batch = { source: { key: "b", geometry: "g", count: 64, pose: "pose",
    alphaMode: "OPAQUE", data: new Float32Array(64 * 36) },
    previousTransforms: new Float32Array(64 * 12) } as CachedPacketBatch;
  const batches = new Map([["b", batch]]);
  const geometries = new Map([["g", { center: [0, 0, 0], radius: 1,
    source: { revision: 1 }, mesh: { indexCount: 3 } } as CachedPacketGeometry]]);
  const bounds = new Map<string, DeformationBoundsEnvelope>([["b", { center: [2, 0, 0], radius: 3, conservative: true }]]);
  const run = (phase: "opaque" | "shadow" = "opaque", cascade = 0) => owner.encode({} as GPUCommandEncoder,
    [] as unknown as Frustum, phase, batches, geometries, undefined, cascade, bounds);
  return { owner, batch, batches, geometries, bounds, run };
}

it("rejects missing posed bounds before dispatch and removes the previous phase", () => {
  const f = fixture(); f.run();
  const previous = f.owner.dynamicPhase(f.batch.source, "opaque")!;
  expect(f.owner.isDynamicPhase(previous, f.batch.source, "opaque")).toBe(true);
  f.bounds.clear(); gpu.encode.mockClear(); gpu.write.mockClear();
  expect(() => f.run()).toThrow("Missing deformed");
  expect(gpu.encode).not.toHaveBeenCalled(); expect(gpu.write).not.toHaveBeenCalled();
  expect(f.owner.phase("b", "opaque")).toBeUndefined();
  expect(f.owner.isDynamicPhase(previous, f.batch.source, "opaque")).toBe(false);
  f.owner.dispose();
});

it("preflights all batches before any upload or dispatch", () => {
  const f = fixture();
  const second = { ...f.batch, source: { ...f.batch.source, key: "second" } };
  f.batches.set("second", second); f.bounds.set("second", f.bounds.get("b")!); f.run();
  for (const invalid of [undefined, { center: [0, 0, 0] as const, radius: NaN, conservative: true as const },
    { center: [0, 0, 0] as const, radius: 2, conservative: false as never }]) {
    if (invalid) f.bounds.set("second", invalid); else f.bounds.delete("second");
    gpu.encode.mockClear(); gpu.write.mockClear();
    expect(() => f.run()).toThrow();
    expect(gpu.encode).not.toHaveBeenCalled(); expect(gpu.write).not.toHaveBeenCalled();
    expect(f.owner.phase("b", "opaque")).toBeUndefined();
    expect(f.owner.phase("second", "opaque")).toBeUndefined();
  }
  f.owner.dispose();
});

it("does not expose partial phase results after a later dispatch fails", () => {
  const f = fixture();
  f.batches.set("second", { ...f.batch, source: { ...f.batch.source, key: "second" } });
  f.bounds.set("second", f.bounds.get("b")!);
  gpu.encode.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("dispatch"); });
  expect(() => f.run()).toThrow("dispatch");
  expect(f.owner.phase("b", "opaque")).toBeUndefined();
  expect(f.owner.phase("second", "opaque")).toBeUndefined();
  f.owner.dispose();
});

it("clears previous results when a batch becomes small, LOD, skipped shadow or absent", () => {
  for (const reason of ["small", "lod", "blend", "absent"]) {
    const f = fixture(); f.run("shadow"); f.bounds.clear();
    if (reason === "small") Object.assign(f.batch.source, { count: 1 });
    if (reason === "lod") Object.assign(f.batch.source, { lod: {} });
    if (reason === "blend") Object.assign(f.batch.source, { alphaMode: "BLEND" });
    if (reason === "absent") f.batches.clear();
    gpu.encode.mockClear();
    expect(f.run("shadow").frustumBatches).toBe(0);
    expect(f.owner.phase("b", "shadow")).toBeUndefined();
    expect(gpu.encode).not.toHaveBeenCalled();
    f.owner.dispose();
  }
});

it("binds dynamic evidence to owner, batch identity, phase, cascade and latest encode", () => {
  const f = fixture(); f.run();
  const current = f.owner.dynamicPhase(f.batch.source, "opaque")!;
  expect(current.bounds).toBe("deformed");
  expect(f.owner.isDynamicPhase({ ...current }, f.batch.source, "opaque")).toBe(false);
  expect(f.owner.isDynamicPhase(current, { ...f.batch.source }, "opaque")).toBe(false);
  expect(f.owner.isDynamicPhase(current, f.batch.source, "shadow")).toBe(false);
  const other = fixture();
  expect(other.owner.isDynamicPhase(current, f.batch.source, "opaque")).toBe(false);
  f.run("shadow", 1);
  const shadow = f.owner.dynamicPhase(f.batch.source, "shadow", 1)!;
  expect(f.owner.isDynamicPhase(shadow, f.batch.source, "shadow", 0)).toBe(false);
  expect(f.owner.isDynamicPhase(current, f.batch.source, "opaque")).toBe(true);
  f.run();
  expect(f.owner.isDynamicPhase(current, f.batch.source, "opaque")).toBe(false);
  f.owner.dispose(); other.owner.dispose();
  expect(f.owner.dynamicPhase(f.batch.source, "shadow", 1)).toBeUndefined();
});

it("publishes verified HiZ results and preserves its frustum fallback", () => {
  const f = fixture();
  Object.assign(f.batch.source, { count: 128, data: new Float32Array(128 * 36) });
  Object.assign(f.batch, { previousTransforms: new Float32Array(128 * 12) });
  const compacted = { instances: {}, previousTransforms: {}, indirect: {} };
  gpu.compact.mockReturnValue(compacted); gpu.hiZ.mockReturnValue({ mode: "indirect" });
  const run = () => f.owner.encode({} as GPUCommandEncoder, [] as unknown as Frustum, "opaque", f.batches,
    f.geometries, { previousHiZ: {} as never, sceneRevision: 1 }, 0, f.bounds);
  expect(run()).toMatchObject({ occlusionBatches: 1, frustumBatches: 0 });
  const result = f.owner.dynamicPhase(f.batch.source, "opaque")!;
  expect(result.compacted).toBe(compacted.instances);
  expect(f.owner.isDynamicPhase(result, f.batch.source, "opaque")).toBe(true);
  expect(gpu.encode).not.toHaveBeenCalled();
  gpu.hiZ.mockReturnValue({ mode: "direct" });
  expect(run()).toMatchObject({ occlusionBatches: 0, frustumBatches: 1 });
  expect(f.owner.isDynamicPhase(result, f.batch.source, "opaque")).toBe(false);
  expect(f.owner.dynamicPhase(f.batch.source, "opaque")).toBeDefined();
  f.owner.dispose();
});
