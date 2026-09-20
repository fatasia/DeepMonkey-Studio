import { describe, expect, it } from "vitest";
import { buildTracedScene, traceClosest, traceOccluded } from "./rayTrace.js";
import type { RayBlasDescriptor } from "./rayBackendTypes.js";

function gridBlas(cells: number): RayBlasDescriptor {
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
  return { id: "terrain", vertices, indices: Uint32Array.from(indices) };
}

describe("cpu reference bvh trace", () => {
  it("matches a brute-force sweep exactly across a ray fan", () => {
    const scene = buildTracedScene(gridBlas(8));
    const rays: TraceQueryLite[] = [];
    for (let step = 0; step < 40; step++) {
      const angle = step / 40 * Math.PI * 2;
      rays.push({ ox: 4, oy: 4, oz: 6, dx: Math.cos(angle), dy: Math.sin(angle), dz: -1, tMax: 64 });
      rays.push({ ox: 0.5, oy: 0.5, oz: 3, dx: Math.cos(angle) * 0.01, dy: Math.sin(angle) * 0.01, dz: -1, tMax: 64 });
    }
    for (const ray of rays) {
      const traced = traceClosest(scene, ray);
      const brute = bruteForce(scene, ray);
      if (brute === undefined) { expect(traced).toBeUndefined(); continue; }
      expect(traced).toBeDefined();
      expect(traced!.primitiveIndex).toBe(brute.primitiveIndex);
      expect(traced!.t).toBeCloseTo(brute.t, 5);
    }
  });

  it("returns undefined on miss and respects tMax", () => {
    const scene = buildTracedScene(gridBlas(4));
    expect(traceClosest(scene, { ox: 2, oy: 2, oz: 5, dx: 0, dy: 0, dz: 1, tMax: 10 })).toBeUndefined();
    expect(traceClosest(scene, { ox: 2, oy: 2, oz: 5, dx: 0, dy: 0, dz: -1, tMax: 1 })).toBeUndefined();
    expect(traceClosest(scene, { ox: 2, oy: 2, oz: 5, dx: 0, dy: 0, dz: -1, tMax: 10 })).toBeDefined();
  });

  it("occlusion early-outs true on any hit and false on clear rays", () => {
    const scene = buildTracedScene(gridBlas(6));
    expect(traceOccluded(scene, { ox: 3, oy: 3, oz: 4, dx: 0, dy: 0, dz: -1, tMax: 32 })).toBe(true);
    expect(traceOccluded(scene, { ox: 3, oy: 3, oz: 4, dx: 0, dy: 0, dz: 1, tMax: 32 })).toBe(false);
  });

  it("rejects an unnamed blas at scene build", () => {
    const mesh = gridBlas(2);
    expect(() => buildTracedScene({ ...mesh, id: "" })).toThrow("BLAS id is required");
  });
});

interface TraceQueryLite { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; tMax: number }

import { intersectTriangle } from "./bvhBuilder.js";

function bruteForce(scene: TracedScene, ray: TraceQueryLite): { t: number; primitiveIndex: number } | undefined {
  let best: { t: number; primitiveIndex: number } | undefined;
  const v = scene.blas.vertices;
  for (let triangle = 0; triangle < scene.blas.indices.length / 3; triangle++) {
    const t = intersectTriangle(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, v,
      scene.blas.indices[triangle * 3]!, scene.blas.indices[triangle * 3 + 1]!, scene.blas.indices[triangle * 3 + 2]!);
    if (t >= 0 && t <= ray.tMax && (best === undefined || t < best.t)) best = { t, primitiveIndex: triangle };
  }
  return best;
}
