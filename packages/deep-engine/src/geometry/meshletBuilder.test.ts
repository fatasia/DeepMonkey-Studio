import { describe, expect, it } from "vitest";
import {
  MESHLET_BOUNDS_STRIDE,
  MESHLET_DESCRIPTOR_STRIDE,
  MeshletError,
  buildMeshlets,
  hashMeshletBuild,
  packLocalTriangle,
  unpackLocalTriangle,
  validateMeshletBuild,
  type IndexedTriangleGeometry,
  type MeshletBuildResult,
} from "./index.js";

describe("CPU meshlet builder", () => {
  it("builds a deterministic GPU-aligned meshlet and preserves triangle order", () => {
    const geometry = quad();
    const result = buildMeshlets(geometry);
    expect(result.meshletCount).toBe(1);
    expect([...result.descriptors]).toEqual([0, 4, 0, 2]);
    expect([...result.vertexRemap]).toEqual([0, 1, 2, 3]);
    expect([...unpackLocalTriangle(result.localTriangleIndices[0]!)]).toEqual([0, 1, 2]);
    expect([...unpackLocalTriangle(result.localTriangleIndices[1]!)]).toEqual([0, 2, 3]);
    expect(result.descriptors.byteLength).toBe(16);
    expect(result.bounds.byteLength).toBe(64);
    expect(result.bounds[15]).toBeGreaterThan(0.999);
    expect(result.bounds[12]).toBe(0);
    expect(result.bounds[13]).toBe(0);
    expect(result.bounds[14]).toBe(1);
    expect(validateMeshletBuild(result, { sourcePositions: geometry.positions })).toBe(result);
  });

  it("honors both meshlet limits without reordering or dropping geometry", () => {
    const distinct = geometryWithDistinctTriangles(44);
    const byVertices = buildMeshlets(distinct, { maxVertices: 6, maxTriangles: 126 });
    expect(byVertices.meshletCount).toBe(22);
    for (let meshlet = 0; meshlet < byVertices.meshletCount; meshlet += 1) {
      expect(byVertices.descriptors[meshlet * MESHLET_DESCRIPTOR_STRIDE + 1]).toBe(6);
      expect(byVertices.descriptors[meshlet * MESHLET_DESCRIPTOR_STRIDE + 3]).toBe(2);
    }
    expect(reconstructTriangles(byVertices)).toEqual([...distinct.indices]);

    const repeated = repeatTriangle(127);
    const byTriangles = buildMeshlets(repeated);
    expect(byTriangles.meshletCount).toBe(2);
    expect([...byTriangles.descriptors]).toEqual([0, 3, 0, 126, 3, 3, 126, 1]);
    expect(reconstructTriangles(byTriangles)).toEqual([...repeated.indices]);
  });

  it("computes conservative AABB/sphere bounds and disables the cone for a degenerate triangle", () => {
    const geometry: IndexedTriangleGeometry = {
      positions: new Float32Array([-3, 2, -1, 7, 2, -1, 1, 6, 4, 1, 6, 4]),
      indices: new Uint32Array([0, 1, 2, 2, 3, 3]),
    };
    const result = buildMeshlets(geometry);
    const bounds = result.bounds;
    expect([...bounds.slice(4, 7)]).toEqual([-3, 2, -1]);
    expect([...bounds.slice(8, 11)]).toEqual([7, 6, 4]);
    expect(bounds[15]).toBe(-1);
    for (const global of result.vertexRemap) {
      const offset = global * 3;
      const distance = Math.hypot(
        geometry.positions[offset]! - bounds[0]!,
        geometry.positions[offset + 1]! - bounds[1]!,
        geometry.positions[offset + 2]! - bounds[2]!,
      );
      expect(distance).toBeLessThanOrEqual(bounds[3]!);
    }
  });

  it("handles empty and exact default-budget inputs", () => {
    const empty = buildMeshlets({ positions: new Float32Array(), indices: new Uint16Array() });
    expect(empty.meshletCount).toBe(0);
    expect(empty.descriptors.length + empty.vertexRemap.length + empty.localTriangleIndices.length + empty.bounds.length).toBe(0);

    const positions = new Float32Array(64 * 3);
    for (let vertex = 0; vertex < 64; vertex += 1) {
      positions[vertex * 3] = vertex % 8;
      positions[vertex * 3 + 1] = Math.floor(vertex / 8);
    }
    const indices = new Uint16Array(126 * 3);
    for (let triangle = 0; triangle < 126; triangle += 1) {
      indices.set([triangle % 64, (triangle + 1) % 64, (triangle + 8) % 64], triangle * 3);
    }
    const exact = buildMeshlets({ positions, indices });
    expect(exact.meshletCount).toBe(1);
    expect([...exact.descriptors]).toEqual([0, 64, 0, 126]);
  });

  it("rejects malformed, non-finite, out-of-range, and overflowed source geometry", () => {
    const valid = quad();
    const cases: Array<() => unknown> = [
      () => buildMeshlets(undefined as unknown as IndexedTriangleGeometry),
      () => buildMeshlets({ positions: [0, 0, 0] as unknown as Float32Array, indices: new Uint16Array() }),
      () => buildMeshlets({ positions: new Float32Array(4), indices: new Uint16Array() }),
      () => buildMeshlets({ positions: new Float32Array([0, 0, NaN]), indices: new Uint16Array() }),
      () => buildMeshlets({ positions: valid.positions, indices: new Uint16Array([0, 1]) }),
      () => buildMeshlets({ positions: valid.positions, indices: new Uint32Array([0, 1, 99]) }),
      () => buildMeshlets(valid, { maxVertices: 0 }),
      () => buildMeshlets(valid, { maxVertices: 65 }),
      () => buildMeshlets(valid, { maxTriangles: 127 }),
      () => packLocalTriangle(0, 1, 256),
      () => unpackLocalTriangle(0x0100_0000),
      () => buildMeshlets({
        positions: new Float32Array([-3e38, -3e38, -3e38, 3e38, 3e38, 3e38, 3e38, -3e38, 3e38]),
        indices: new Uint16Array([0, 1, 2]),
      }),
    ];
    for (const invoke of cases) expect(invoke).toThrow(MeshletError);
  });

  it("rejects concurrent SharedArrayBuffer inputs when available", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const positions = new Float32Array(new SharedArrayBuffer(9 * 4));
    const indices = new Uint16Array(new SharedArrayBuffer(3 * 2));
    expect(() => buildMeshlets({ positions, indices })).toThrow(/SharedArrayBuffer/);
  });

  it("validates descriptor, remap, local-index, bounds, cone, and containment corruption", () => {
    const geometry = quad(), original = buildMeshlets(geometry);
    const corruptions: Array<(copy: MutableResult) => void> = [
      (copy) => { copy.descriptors[0] = 1; },
      (copy) => { copy.descriptors[1] = 65; },
      (copy) => { copy.vertexRemap[1] = copy.vertexRemap[0]!; },
      (copy) => { copy.localTriangleIndices[0] = packLocalTriangle(0, 1, 4); },
      (copy) => { copy.localTriangleIndices[0] = 0xff00_0000; },
      (copy) => { copy.bounds[3] = -1; },
      (copy) => { copy.bounds[4] = 100; },
      (copy) => { copy.bounds[12] = 2; },
      (copy) => { copy.bounds.set([0, 0, -1, 0.5], 12); },
      (copy) => { copy.bounds[0] = 100; },
      (copy) => { copy.bounds[15] = NaN; },
      (copy) => { copy.bounds[7] = 1; },
    ];
    for (const corrupt of corruptions) {
      const copy = mutableCopy(original);
      corrupt(copy);
      expect(() => validateMeshletBuild(copy, { sourcePositions: geometry.positions })).toThrow(MeshletError);
    }
    const overBudget = mutableCopy(original);
    Object.assign(overBudget, { sourceTriangleCount: 4_000_001 });
    expect(() => validateMeshletBuild(overBudget)).toThrow(MeshletError);

    const degenerate = buildMeshlets({
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      indices: new Uint16Array([0, 1, 1]),
    });
    const unsafeCone = mutableCopy(degenerate);
    unsafeCone.bounds.set([0, 0, 1, 1], 12);
    expect(() => validateMeshletBuild(unsafeCone, { sourcePositions: new Float32Array([0, 0, 0, 1, 0, 0]) })).toThrow(/degenerate/);
  });

  it("builds 12,800 triangles deterministically with a stable ABI hash", () => {
    const geometry = grid(80);
    const first = buildMeshlets(geometry), second = buildMeshlets(geometry);
    expect(first.sourceTriangleCount).toBe(12_800);
    expect(first.meshletCount).toBeGreaterThan(1);
    expect(hashMeshletBuild(first)).toBe(hashMeshletBuild(second));
    expect(hashMeshletBuild(first)).toBe("e24137658d855a8b");
    expect(first.descriptors).toEqual(second.descriptors);
    expect(first.vertexRemap).toEqual(second.vertexRemap);
    expect(first.localTriangleIndices).toEqual(second.localTriangleIndices);
    expect(first.bounds).toEqual(second.bounds);
  });
});

interface MutableResult extends MeshletBuildResult {
  descriptors: Uint32Array;
  vertexRemap: Uint32Array;
  localTriangleIndices: Uint32Array;
  bounds: Float32Array;
}

function mutableCopy(value: MeshletBuildResult): MutableResult {
  return { ...value, descriptors: value.descriptors.slice(), vertexRemap: value.vertexRemap.slice(),
    localTriangleIndices: value.localTriangleIndices.slice(), bounds: value.bounds.slice() };
}

function quad(): IndexedTriangleGeometry {
  return {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

function repeatTriangle(count: number): IndexedTriangleGeometry {
  const indices = new Uint16Array(count * 3);
  for (let triangle = 0; triangle < count; triangle += 1) indices.set([0, 1, 2], triangle * 3);
  return { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices };
}

function geometryWithDistinctTriangles(count: number): IndexedTriangleGeometry {
  const positions = new Float32Array(count * 9), indices = new Uint32Array(count * 3);
  for (let triangle = 0; triangle < count; triangle += 1) {
    const x = triangle * 2, vertex = triangle * 3;
    positions.set([x, 0, 0, x + 1, 0, 0, x, 1, 0], vertex * 3);
    indices.set([vertex, vertex + 1, vertex + 2], vertex);
  }
  return { positions, indices };
}

function grid(size: number): IndexedTriangleGeometry {
  const positions = new Float32Array((size + 1) * (size + 1) * 3);
  for (let y = 0; y <= size; y += 1) for (let x = 0; x <= size; x += 1) {
    const offset = (y * (size + 1) + x) * 3;
    positions.set([x, y, ((x * 17 + y * 31) % 13) / 100], offset);
  }
  const indices = new Uint32Array(size * size * 6);
  let target = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const a = y * (size + 1) + x, b = a + 1, d = a + size + 1, c = d + 1;
    indices.set([a, b, c, a, c, d], target);
    target += 6;
  }
  return { positions, indices };
}

function reconstructTriangles(value: MeshletBuildResult): number[] {
  const result: number[] = [];
  for (let meshlet = 0; meshlet < value.meshletCount; meshlet += 1) {
    const d = meshlet * MESHLET_DESCRIPTOR_STRIDE;
    const vertexOffset = value.descriptors[d]!, triangleOffset = value.descriptors[d + 2]!, triangleCount = value.descriptors[d + 3]!;
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      for (const local of unpackLocalTriangle(value.localTriangleIndices[triangleOffset + triangle]!)) {
        result.push(value.vertexRemap[vertexOffset + local]!);
      }
    }
    expect(value.bounds.length).toBe(value.meshletCount * MESHLET_BOUNDS_STRIDE);
  }
  return result;
}
