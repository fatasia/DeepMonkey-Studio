import { describe, expect, it } from "vitest";
import { buildBvh, intersectTriangle, type BvhBuildResult } from "./bvhBuilder.js";
import { RAY_BACKEND_LIMITS, validateRayBlas, type RayBlasDescriptor } from "./rayBackendTypes.js";

function quadBlas(): RayBlasDescriptor {
  const vertices = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  return { id: "quad", vertices, indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
}

describe("ray backend contracts", () => {
  it("validates blas descriptors fail-closed", () => {
    expect(validateRayBlas(quadBlas())).toBeUndefined();
    expect(validateRayBlas({ ...quadBlas(), id: "" })).toBe("BLAS id is required.");
    expect(validateRayBlas({ id: "bad", vertices: new Float32Array(6), indices: new Uint32Array(4) }))
      .toBe("BLAS vertex/index streams must be whole float3 / whole triangles.");
    const outOfRange = quadBlas();
    (outOfRange.indices as Uint32Array)[0] = 999;
    expect(validateRayBlas(outOfRange)).toBe("BLAS index out of vertex range.");
  });

  it("keeps the contract limits frozen and sane", () => {
    expect(RAY_BACKEND_LIMITS.maxBatchRays).toBeGreaterThan(0);
    expect(RAY_BACKEND_LIMITS.maxBlasBytes).toBeGreaterThan(RAY_BACKEND_LIMITS.maxBlasTriangles * 16);
  });
});

describe("cpu reference bvh", () => {
  it("builds a hierarchy whose leaves partition every triangle", () => {
    const grid = gridBlas(4);
    const built = buildBvh({ vertices: grid.vertices, indices: grid.indices });
    expect(built.nodes.length).toBeGreaterThan(1);
    const root = built.nodes[0]!;
    expect(root.minX).toBeLessThanOrEqual(0);
    expect(root.maxX).toBeGreaterThanOrEqual(1);
    let leafTriangles = 0;
    for (const node of built.nodes) if (node.count > 0) leafTriangles += node.count;
    expect(leafTriangles).toBe(grid.indices.length / 3);
  });

  it("orders triangles as a permutation", () => {
    const grid = gridBlas(4);
    const built = buildBvh({ vertices: grid.vertices, indices: grid.indices });
    expect(new Set(built.order).size).toBe(built.order.length);
    expect([...built.order].sort((a, b) => a - b)).toEqual(Array.from({ length: built.order.length }, (_, i) => i));
  });

  it("traces the canonical ray to the expected triangle with a deterministic hit", () => {
    const blas = quadBlas();
    const built = buildBvh({ vertices: blas.vertices, indices: blas.indices });
    const hit = traceReference(blas, built, 0, 0, 5, 0, 0, -1);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(5, 6);
    expect([0, 1]).toContain(hit!.primitiveIndex);
    const miss = traceReference(blas, built, 0, 0, 5, 0, 0, 1);
    expect(miss).toBeNull();
  });

  it("intersectTriangle rejects parallel rays deterministically", () => {
    const v = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(intersectTriangle(0, 0, 1, 0, 0, -1, v, 0, 1, 2)).toBeCloseTo(1, 6);
    expect(intersectTriangle(0, 0, 1, 1, 0, 0, v, 0, 1, 2)).toBe(-1);
  });
});

function gridBlas(cells: number): RayBlasDescriptor {
  const stride = cells + 1;
  const vertices = new Float32Array(stride * stride * 3);
  for (let y = 0; y < stride; y++) for (let x = 0; x < stride; x++) {
    vertices.set([x / cells, y / cells, 0], (y * stride + x) * 3);
  }
  const indices: number[] = [];
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const a = y * stride + x, b = a + 1, c = a + stride, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { id: "grid", vertices, indices: Uint32Array.from(indices) };
}

function traceReference(blas: RayBlasDescriptor, _built: BvhBuildResult,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number):
  { t: number; primitiveIndex: number } | null {
  let best: { t: number; primitiveIndex: number } | null = null;
  const v = blas.vertices;
  for (let triangle = 0; triangle < blas.indices.length / 3; triangle++) {
    const t = intersectTriangle(ox, oy, oz, dx, dy, dz, v,
      blas.indices[triangle * 3]!, blas.indices[triangle * 3 + 1]!, blas.indices[triangle * 3 + 2]!);
    if (t >= 0 && (best === null || t < best.t)) best = { t, primitiveIndex: triangle };
  }
  return best;
}
