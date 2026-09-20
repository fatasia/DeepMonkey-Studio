import { describe, expect, it } from "vitest";
import { bakeClusterLodDag } from "./clusterLodBake.js";
import { validateClusterLodDag } from "./clusterLodDag.js";

function gridMesh(cells: number): { vertices: Float32Array; indices: Uint32Array } {
  const stride = cells + 1;
  const vertices = new Float32Array(stride * stride * 3);
  for (let y = 0; y < stride; y++) for (let x = 0; x < stride; x++) {
    vertices.set([x, y, Math.sin(x * 13.7 + y * 7.3)], (y * stride + x) * 3);
  }
  const indices: number[] = [];
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const a = y * stride + x, b = a + 1, c = a + stride, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { vertices, indices: Uint32Array.from(indices) };
}

describe("cluster lod dag cpu reference bake", () => {
  it("produces a contract-valid dag whose levels shrink monotonically", () => {
    const mesh = gridMesh(16);
    const baked = bakeClusterLodDag({ geometryId: "terrain", vertices: mesh.vertices,
      indices: mesh.indices, level0ClusterSize: 8 });
    expect(validateClusterLodDag(baked.dag)).toEqual({ valid: true });
    expect(baked.levelGeometry.length).toBeGreaterThan(1);
    const leaves = baked.levelGeometry[0]!.indices.length / 3;
    const coarsest = baked.levelGeometry.at(-1)!.indices.length / 3;
    expect(coarsest).toBeLessThan(leaves);
  });

  it("is deterministic: identical input yields identical dag and geometry bytes", () => {
    const mesh = gridMesh(12);
    const input = { geometryId: "det", vertices: mesh.vertices, indices: mesh.indices, level0ClusterSize: 4 };
    const first = bakeClusterLodDag(input);
    const second = bakeClusterLodDag(input);
    expect(second.dag).toEqual(first.dag);
    for (let level = 0; level < first.levelGeometry.length; level++) {
      expect(Buffer.from(second.levelGeometry[level]!.vertices.buffer).equals(
        Buffer.from(first.levelGeometry[level]!.vertices.buffer))).toBe(true);
      expect(Buffer.from(second.levelGeometry[level]!.indices.buffer).equals(
        Buffer.from(first.levelGeometry[level]!.indices.buffer))).toBe(true);
    }
  });

  it("rejects out-of-contract inputs fail-closed", () => {
    const mesh = gridMesh(4);
    expect(() => bakeClusterLodDag({ geometryId: "x", vertices: mesh.vertices,
      indices: mesh.indices, level0ClusterSize: 0 })).toThrow(RangeError);
    expect(() => bakeClusterLodDag({ geometryId: "x", vertices: mesh.vertices,
      indices: mesh.indices, level0ClusterSize: 8, levelCount: 9 })).toThrow(RangeError);
    expect(() => bakeClusterLodDag({ geometryId: "x", vertices: new Float32Array(0),
      indices: new Uint32Array(0), level0ClusterSize: 4 })).toThrow(RangeError);
  });

  it("keeps every parent's bounds covering its declared triangles", () => {
    const mesh = gridMesh(10);
    const baked = bakeClusterLodDag({ geometryId: "cover", vertices: mesh.vertices,
      indices: mesh.indices, level0ClusterSize: 6 });
    for (const node of baked.dag.nodes) {
      const geometry = baked.levelGeometry[node.level]!;
      for (let triangle = node.firstTriangle; triangle < node.firstTriangle + node.triangleCount; triangle++) {
        for (let corner = 0; corner < 3; corner++) {
          const v = geometry.indices[triangle * 3 + corner]! * 3;
          for (let axis = 0; axis < 3; axis++) {
            expect(geometry.vertices[v + axis]!).toBeGreaterThanOrEqual(node.boundsMin[axis]! - 1e-4);
            expect(geometry.vertices[v + axis]!).toBeLessThanOrEqual(node.boundsMax[axis]! + 1e-4);
          }
        }
      }
    }
  });
});
