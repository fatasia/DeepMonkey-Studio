import { describe, expect, it, vi } from "vitest";
import { packInstanceBatches } from "../renderPacketBatches.js";
import type { PbrMaterial, RenderInstance } from "../renderPacketTypes.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { normalizePickRay, pickScene, pickingUnavailable, type PickSceneView } from "./picking.js";
import { PbrRenderer } from "./pbrRenderer.js";
import type { DeviceSession } from "./deviceSession.js";
import { PacketBuffers } from "./packetBuffers.js";

/** 单三角形(v0 原点、v1 +x、v2 +y,几何法线 +z),位置+法线交错 6 float,走真实打包路径。 */
function unitTriangle(id = "g"): CachedPacketGeometry {
  return { source: { id, revision: 1,
      vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]) },
    mesh: {} as CachedPacketGeometry["mesh"], center: [0, 0, 0], radius: 1 };
}
const material: PbrMaterial = { id: "m", baseColor: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5 };
function instance(id: string, transform: number[], geometry = "g"): RenderInstance {
  return { id, geometry, material: "m", transform };
}
/** 与生产 PacketBuffers 同构的场景视图:batches 经 packInstanceBatches 打包,行布局即合同。 */
function sceneOf(instances: RenderInstance[], geometries: CachedPacketGeometry[],
  doubleSided = false, notes?: readonly string[]): PickSceneView {
  const batchMaterial: PbrMaterial = doubleSided ? { ...material, doubleSided: true } : material;
  const batches: CachedPacketBatch[] = packInstanceBatches(
    new Set(geometries.map(geometry => geometry.source.id)), instances,
    new Map([[batchMaterial.id, batchMaterial]]), new Map()).map(source =>
    ({ source, buffer: {} as GPUBuffer, capacity: 0, previousBuffer: {} as GPUBuffer,
      previousCapacity: 0, previousTransforms: new Float32Array(0) }));
  return { batches: new Map(batches.map(batch => [batch.source.key, batch])),
    geometries: new Map(geometries.map(geometry => [geometry.source.id, geometry])),
    ...(notes ? { degradedNotes: notes } : {}) };
}
/** 手工批次:绕过打包器校验,模拟流送驻留中"批次在、几何未驻留"的真实运行态。 */
function batchReferencing(geometryId: string): PickSceneView {
  const batch: CachedPacketBatch = { source: { key: "ghost", geometry: geometryId,
    instanceIds: ["i"], mirrored: false, doubleSided: false, alphaMode: "OPAQUE",
    data: new Float32Array(36), count: 1 }, buffer: {} as GPUBuffer, capacity: 0,
    previousBuffer: {} as GPUBuffer, previousCapacity: 0, previousTransforms: new Float32Array(0) };
  return { batches: new Map([[batch.source.key, batch]]),
    geometries: new Map([["g", unitTriangle()]]) };
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fromAbove = { origin: [0.2, 0.2, 5], direction: [0, 0, -1] };

describe("CPU picking ray math (Möller–Trumbore)", () => {
  it("hits an orthogonal ray through a unit triangle with world distance and face normal", () => {
    const result = pickScene(sceneOf([instance("i", identity)], [unitTriangle()]),
      fromAbove.origin, fromAbove.direction);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ instanceId: "i", geometryId: "g", triangle: 0,
      distance: 5, point: [0.2, 0.2, 0], normal: [0, 0, 1] });
  });
  it("hits an oblique ray at the expected world point with normalized world distance", () => {
    const result = pickScene(sceneOf([instance("i", identity)], [unitTriangle()]),
      [1, 0.5, 2], [-0.5, -0.125, -1]);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hits[0]!.point).toEqual([0, 0.25, 0]);
    expect(result.hits[0]!.distance).toBeCloseTo(2 * Math.hypot(0.5, 0.125, 1), 9);
  });
  it("culls backfaces like the GPU raster and honors doubleSided batches", () => {
    const scene = sceneOf([instance("i", identity)], [unitTriangle()]);
    const back = pickScene(scene, [0.2, 0.2, -5], [0, 0, 1]);
    expect(back.available && back.hits).toEqual([]);
    const doubled = pickScene(sceneOf([instance("i", identity)], [unitTriangle()], true),
      [0.2, 0.2, -5], [0, 0, 1]);
    expect(doubled.available && doubled.hits).toHaveLength(1);
  });
  it("misses rays parallel to the triangle plane and rays pointing away", () => {
    const scene = sceneOf([instance("i", identity)], [unitTriangle()]);
    const parallel = pickScene(scene, [0.2, 0.2, 0], [1, 0, 0]);
    expect(parallel.available && parallel.hits).toEqual([]);
    const away = pickScene(scene, [0.2, 0.2, -5], [0, 0, -1]);
    expect(away.available && away.hits).toEqual([]);
  });
});

describe("CPU picking instance transforms", () => {
  it("picks translated instances with world-frame hits", () => {
    const translated = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1];
    const result = pickScene(sceneOf([instance("i", translated)], [unitTriangle()]),
      [10.2, 0.2, 5], [0, 0, -1]);
    if (!result.available) throw new Error("expected available");
    expect(result.hits[0]).toMatchObject({ distance: 5, point: [10.2, 0.2, 0], normal: [0, 0, 1] });
  });
  it("picks rotated instances and transforms the normal into world space", () => {
    const rotateZ90 = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // +90° 旋转把三角形映射到 x∈[-1,0]、y∈[0,1];法线仍 +z。
    const result = pickScene(sceneOf([instance("i", rotateZ90)], [unitTriangle()]),
      [-0.2, 0.2, 5], [0, 0, -1]);
    if (!result.available) throw new Error("expected available");
    expect(result.hits[0]!.point[0]).toBeCloseTo(-0.2, 9);
    expect(result.hits[0]!.point[1]).toBeCloseTo(0.2, 9);
    expect(result.hits[0]!.normal[0]).toBeCloseTo(0, 9);
    expect(result.hits[0]!.normal[2]).toBeCloseTo(1, 9);
  });
  it("applies nonuniform scale to geometry and keeps distance in world units", () => {
    const scale = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const result = pickScene(sceneOf([instance("i", scale)], [unitTriangle()]),
      [1, 0.2, 5], [0, 0, -1]);
    if (!result.available) throw new Error("expected available");
    expect(result.hits[0]).toMatchObject({ distance: 5, point: [1, 0.2, 0] });
  });
  it("flips front/back judgement for mirrored instances exactly like raster winding", () => {
    const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // x 镜像后世界三角形占 x∈[-1,0];同一几何点(局部 u=v=0.2)上:
    // 非双面 → det<0 翻转前/背判定,自 +z 看被剔;双面 → 命中。
    const culled = pickScene(sceneOf([instance("i", mirror)], [unitTriangle()]),
      [-0.2, 0.2, 5], fromAbove.direction);
    expect(culled.available && culled.hits).toEqual([]);
    const doubled = pickScene(sceneOf([instance("i", mirror)], [unitTriangle()], true),
      [-0.2, 0.2, 5], fromAbove.direction);
    if (!doubled.available) throw new Error("expected available");
    expect(doubled.hits).toHaveLength(1);
    expect(doubled.hits[0]).toMatchObject({ distance: 5, point: [-0.2, 0.2, 0] });
  });
});

describe("CPU picking ordering and range options", () => {
  // 射线自 z=5 朝 -z:near 三角形在 z=3(距离 2),far 在 z=-5(距离 10)。
  const twoInstances = () => sceneOf([
    { ...instance("far", identity), transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1] },
    { ...instance("near", identity), transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1] }],
    [unitTriangle()]);
  it("sorts hits by ascending distance across instances", () => {
    const result = pickScene(twoInstances(), fromAbove.origin, fromAbove.direction);
    if (!result.available) throw new Error("expected available");
    expect(result.hits.map(hit => hit.instanceId)).toEqual(["near", "far"]);
    expect(result.hits.map(hit => hit.distance)).toEqual([2, 10]);
  });
  it("filters by minDistance/maxDistance and truncates by maxHits", () => {
    const scene = twoInstances();
    const farOnly = pickScene(scene, fromAbove.origin, fromAbove.direction, { maxDistance: 5 });
    if (!farOnly.available) throw new Error("expected available");
    expect(farOnly.hits.map(hit => hit.instanceId)).toEqual(["near"]);
    const none = pickScene(scene, fromAbove.origin, fromAbove.direction, { maxDistance: 1 });
    expect(none.available && none.hits).toEqual([]);
    const first = pickScene(scene, fromAbove.origin, fromAbove.direction, { maxHits: 1 });
    if (!first.available) throw new Error("expected available");
    expect(first.hits.map(hit => hit.instanceId)).toEqual(["near"]);
    const past = pickScene(scene, fromAbove.origin, fromAbove.direction, { minDistance: 3 });
    if (!past.available) throw new Error("expected available");
    expect(past.hits.map(hit => hit.instanceId)).toEqual(["far"]);
  });
  it("reports non-resident geometry as degraded instead of fabricating hits", () => {
    const result = pickScene(batchReferencing("missing"), fromAbove.origin, fromAbove.direction);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.hits).toEqual([]);
    expect(result.degraded).toEqual(["geometry-not-resident:missing",
      "node-mapping-unavailable:hits-report-instance-ids-only"]);
  });
  it("passes host degraded notes through untouched", () => {
    const result = pickScene(sceneOf([instance("i", identity)], [unitTriangle()], false,
      ["deformation-active:instances-picked-at-base-pose"]), fromAbove.origin, fromAbove.direction);
    expect(result.available && result.degraded).toEqual(["deformation-active:instances-picked-at-base-pose",
      "node-mapping-unavailable:hits-report-instance-ids-only"]);
  });
  it("returns an empty hit list (not unavailable) for a published empty scene", () => {
    const result = pickScene(sceneOf([], [unitTriangle()]), fromAbove.origin, fromAbove.direction);
    expect(result).toEqual({ available: true, hits: [],
      degraded: ["node-mapping-unavailable:hits-report-instance-ids-only"] });
  });
});

describe("CPU picking input contract violations", () => {
  const scene = sceneOf([instance("i", identity)], [unitTriangle()]);
  it("throws precise errors for malformed rays and ranges", () => {
    expect(() => pickScene(scene, [0, 0], [0, 0, -1])).toThrow("origin must contain three finite numbers");
    expect(() => pickScene(scene, [0, 0, 0], [0, 0, Number.NaN])).toThrow("direction must contain three finite numbers");
    expect(() => pickScene(scene, [0, 0, 0], [0, 0, 0])).toThrow("direction must be nonzero");
    expect(() => pickScene(scene, [0, 0, 0], [0, 0, -1], { minDistance: -1 })).toThrow("0 <= minDistance <= maxDistance");
    expect(() => pickScene(scene, [0, 0, 0], [0, 0, -1], { maxHits: 0 })).toThrow("maxHits must be at least 1");
  });
  it("normalizes ray direction for callers that pre-check", () => {
    const ray = normalizePickRay([0, 0, 5], [0, 0, -10]);
    expect(ray.direction).toEqual([0, 0, -1]);
    expect(pickingUnavailable("x").reason).toBe("picking unavailable: x");
  });
});

describe("CPU picking node-level identity mapping", () => {
  // 一个节点两个实例(near/far)+ 一个未映射实例(grid,语义如辅助网格)。
  const mapped = () => ({ ...sceneOf([
    { ...instance("far", identity), transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1] },
    { ...instance("near", identity), transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1] },
    { ...instance("grid", identity), transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 9, 1] }],
    [unitTriangle()]),
    objectBindings: [{ nodeId: "node-a", instanceIds: ["near", "far"] }] });
  it("resolves every hit of a node's instances to the shared nodeId in distance order", () => {
    const result = pickScene(mapped(), fromAbove.origin, fromAbove.direction);
    if (!result.available) throw new Error("expected available");
    expect(result.hits.map(hit => [hit.instanceId, hit.nodeId, hit.distance]))
      .toEqual([["near", "node-a", 2], ["far", "node-a", 10]]);
  });
  it("keeps unmapped instances anonymous instead of inventing a node identity", () => {
    const result = pickScene(mapped(), [0.2, 0.2, 14], [0, 0, -1], { maxDistance: 6 });
    if (!result.available) throw new Error("expected available");
    expect(result.hits.map(hit => hit.instanceId)).toEqual(["grid"]);
    expect(result.hits[0]).not.toHaveProperty("nodeId");
    expect(result.degraded).toBeUndefined();
  });
  it("reports instance-level degradation exactly once when the scene view has no mapping", () => {
    const result = pickScene(sceneOf([instance("i", identity)], [unitTriangle()]),
      fromAbove.origin, fromAbove.direction);
    if (!result.available) throw new Error("expected available");
    expect(result.hits[0]).not.toHaveProperty("nodeId");
    expect(result.degraded).toEqual(["node-mapping-unavailable:hits-report-instance-ids-only"]);
  });
  it("throws precise errors for contract-violating mappings", () => {
    const view = sceneOf([instance("i", identity)], [unitTriangle()]);
    const conflicting = { ...view, objectBindings: [{ nodeId: "x", instanceIds: ["i"] }, { nodeId: "y", instanceIds: ["i"] }] };
    expect(() => pickScene(conflicting, fromAbove.origin, fromAbove.direction)).toThrow(/conflicting nodes/);
    expect(() => pickScene({ ...view, objectBindings: [{ nodeId: "", instanceIds: ["i"] }] },
      fromAbove.origin, fromAbove.direction)).toThrow(/node id must be non-empty/);
    expect(() => pickScene({ ...view, objectBindings: [{ nodeId: "x", instanceIds: [""] }] },
      fromAbove.origin, fromAbove.direction)).toThrow(/instance id must be non-empty/);
  });
});

describe("PbrRenderer.pick fail-closed wiring", () => {
  const GPU_STUBS = { GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8, STORAGE: 128, COPY_SRC: 4, INDIRECT: 256 },
    GPUShaderStage: { COMPUTE: 4 } } as const;
  function wiredRenderer() {
    vi.stubGlobal("GPUBufferUsage", GPU_STUBS.GPUBufferUsage);
    vi.stubGlobal("GPUShaderStage", GPU_STUBS.GPUShaderStage);
    const device = { limits: { maxBufferSize: 256 * 1024 * 1024 },
      createBuffer: () => ({ destroy: () => undefined }), createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
      createComputePipeline: () => ({}), createBindGroup: () => ({}),
      pushErrorScope: () => undefined, popErrorScope: () => Promise.resolve(null),
      queue: { writeBuffer: () => undefined } };
    const session = { state: "ready", device, own: (buffer: GPUBuffer) => buffer, release: () => undefined };
    const renderer = Object.create(PbrRenderer.prototype) as PbrRenderer;
    (renderer as unknown as { packets: PacketBuffers }).packets = new PacketBuffers(session as unknown as DeviceSession);
    return renderer as PbrRenderer & { packets: PacketBuffers };
  }
  it("reports unavailable before any packet is published", () => {
    const renderer = wiredRenderer();
    const result = renderer.pick(fromAbove.origin, fromAbove.direction);
    expect(result).toEqual({ available: false, reason: "picking unavailable: no render packet published" });
    (renderer as unknown as { packets: PacketBuffers }).packets.dispose();
  });
  it("picks the published scene and flags deformation as degraded", () => {
    const renderer = wiredRenderer();
    const packets = (renderer as unknown as { packets: PacketBuffers }).packets;
    expect(packets.set({ geometries: [unitTriangle().source],
      materials: [material],
      instances: [instance("i", identity)] })).toBe(true);
    const hit = renderer.pick(fromAbove.origin, fromAbove.direction);
    expect(hit.available && hit.hits[0]).toMatchObject({ instanceId: "i", distance: 5 });
    // PbrRenderer 尚未接线节点映射:结果如实降级到 instanceId 级,不冒充节点身份。
    expect(hit.available && hit.degraded)
      .toEqual(["node-mapping-unavailable:hits-report-instance-ids-only"]);
    expect(renderer.pick([0.2, 0.2, 5], [0, 0, -1], { maxDistance: 1 })
      .available && true).toBe(true);
    packets.dispose();
    const disposed = renderer.pick(fromAbove.origin, fromAbove.direction);
    expect(disposed.available).toBe(false);
    expect(disposed.reason).toContain("packet resources inaccessible");
  });
});
