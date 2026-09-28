import { describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { buildClusterLodAuthorStaging,
  type ClusterLodAuthorBakeInput, type ClusterLodAuthorBakeResult } from "./buildClusterLodAuthorStaging";

/** 单三角形几何（stride=6：位置 xyz + 法线 xyz）。 */
function triangleGeometry(id = "tri", translate = 0): RenderPacket["geometries"][number] {
  return { id, revision: 1, vertices: Float32Array.from([
      0 + translate, 0, 0, 0, 0, 1,
      1 + translate, 0, 0, 0, 0, 1,
      0, 1, 0, 0, 0, 1,
    ]), indices: Uint32Array.from([0, 1, 2]) };
}

function identityBake() {
  const inputs: ClusterLodAuthorBakeInput[] = [];
  const bake = vi.fn((input: ClusterLodAuthorBakeInput): ClusterLodAuthorBakeResult => {
    inputs.push(input);
    return { dag: { geometryId: input.geometryId, leafTriangleTotal: input.indices.length / 3, nodes: Object.freeze([]) },
      levelGeometry: [{ vertices: input.vertices, indices: input.indices }] };
  });
  return { bake, inputs };
}

function packet(overrides: Partial<RenderPacket> = {}): RenderPacket {
  return { geometries: [triangleGeometry()],
    materials: [{ id: "m", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1 }],
    instances: [{ id: "i1", geometry: "tri", material: "m",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1] }],
    ...overrides };
}

const STATIC = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe("buildClusterLodAuthorStaging", () => {
  it("merges one translated instance with world-applied positions and strips normals", () => {
    const { bake, inputs } = identityBake();
    const outcome = buildClusterLodAuthorStaging(packet(), { bake });
    expect(outcome).toMatchObject({ ok: true, value: { skippedDeformedInstances: 0, mergedInstances: 1,
      mergedVertices: 3, mergedTriangles: 1 } });
    expect(inputs[0]!.vertices).toEqual(Float32Array.from([10, 0, 0, 11, 0, 0, 10, 1, 0]));
    expect(inputs[0]!.indices).toEqual(Uint32Array.from([0, 1, 2]));
    expect(inputs[0]!.level0ClusterSize).toBe(128);
  });

  it("merges multiple instances with index offset and per-instance transforms", () => {
    const { bake, inputs } = identityBake();
    const outcome = buildClusterLodAuthorStaging(packet({ instances: [
      { id: "a", geometry: "tri", material: "m", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1] },
      { id: "b", geometry: "tri", material: "m", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 20, 0, 1] },
    ] }), { bake });
    expect(outcome).toMatchObject({ ok: true, value: { mergedInstances: 2, mergedVertices: 6, mergedTriangles: 2 } });
    expect(inputs[0]!.vertices).toEqual(Float32Array.from(
      [10, 0, 0, 11, 0, 0, 10, 1, 0, 0, 20, 0, 1, 20, 0, 0, 21, 0]));
    expect(inputs[0]!.indices).toEqual(Uint32Array.from([0, 1, 2, 3, 4, 5]));
  });

  it("applies scale+rotation exactly like the hand-worked affine example", () => {
    const { bake, inputs } = identityBake();
    // scale 2 再绕 Z 旋转 90°：列主序列 0=(0,2,0)、列 1=(-2,0,0)；顶点 (0,0,0)/(1,0,0)/(0,1,0) → (5,0,0)/(5,2,0)/(3,0,0)。
    const m = [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
    const outcome = buildClusterLodAuthorStaging(packet({ instances: [
      { id: "rot", geometry: "tri", material: "m", transform: m }] }), { bake });
    expect(outcome).toMatchObject({ ok: true, value: { mergedInstances: 1 } });
    expect(inputs[0]!.vertices).toEqual(Float32Array.from([5, 0, 0, 5, 2, 0, 3, 0, 0]));
  });

  it("rejects deformation packets explicitly", () => {
    const { bake } = identityBake();
    const outcome = buildClusterLodAuthorStaging(packet({ deformation: {} as never }), { bake });
    expect(outcome).toMatchObject({ ok: false, failure: { reason: "deformation-packet" } });
    expect(bake).not.toHaveBeenCalled();
  });

  it("skips posed instances and counts them", () => {
    const { bake, inputs } = identityBake();
    const outcome = buildClusterLodAuthorStaging(packet({ instances: [
      { id: "posed", geometry: "tri", material: "m", transform: STATIC, pose: "p1" },
      { id: "static", geometry: "tri", material: "m", transform: STATIC },
    ] }), { bake });
    expect(outcome).toMatchObject({ ok: true, value: { skippedDeformedInstances: 1, mergedInstances: 1 } });
    expect(inputs[0]!.vertices).toHaveLength(9);
  });

  it("returns undefined when nothing is mergeable", () => {
    const { bake } = identityBake();
    expect(buildClusterLodAuthorStaging(packet({ instances: [] }), { bake })).toBeUndefined();
    expect(buildClusterLodAuthorStaging(packet({ instances: [
      { id: "posed", geometry: "tri", material: "m", transform: STATIC, pose: "p" },
    ] }), { bake })).toBeUndefined();
    expect(bake).not.toHaveBeenCalled();
  });

  it("fails closed with the vertex budget instead of truncating", () => {
    const { bake } = identityBake();
    const outcome = buildClusterLodAuthorStaging(packet({ instances: [
      { id: "a", geometry: "tri", material: "m", transform: STATIC },
      { id: "b", geometry: "tri", material: "m", transform: STATIC },
    ] }), { bake, maxVertices: 4 });
    expect(outcome).toMatchObject({ ok: false, failure: { reason: "vertex-budget-exceeded" } });
    expect(outcome && !outcome.ok ? outcome.failure.detail : "").toContain("6 > 4");
    expect(bake).not.toHaveBeenCalled();
  });

  it("forwards levelCount/pixelThreshold and the level0ClusterSize override", () => {
    const { bake, inputs } = identityBake();
    const outcome = buildClusterLodAuthorStaging(packet(), { bake, level0ClusterSize: 32, levelCount: 4, pixelThreshold: 2 });
    expect(outcome).toMatchObject({ ok: true, value: { staging: { pixelThreshold: 2 } } });
    expect(inputs[0]!.level0ClusterSize).toBe(32);
    expect(inputs[0]!.levelCount).toBe(4);
  });

  it("propagates bake failures and validates packet contracts", () => {
    expect(() => buildClusterLodAuthorStaging(packet(), { bake: vi.fn(() => { throw new RangeError("budget"); }) }))
      .toThrow("budget");
    expect(() => buildClusterLodAuthorStaging(packet(), { bake: undefined as never })).toThrow(/bake function/);
    expect(() => buildClusterLodAuthorStaging(packet({ instances: [
      { id: "bad", geometry: "missing", material: "m", transform: STATIC },
    ] }), { bake: identityBake().bake })).toThrow(/resolve geometry missing/);
    expect(() => buildClusterLodAuthorStaging(packet({ instances: [
      { id: "bad", geometry: "tri", material: "m", transform: [1, 0, 0] },
    ] }), { bake: identityBake().bake })).toThrow(/4x4 transform/);
  });
});
