import { describe, expect, it } from "vitest";
import { buildTracedScene, traceClosest, traceOccluded, type TraceQuery, type TracedScene } from "./rayTrace.js";
import { intersectTriangle } from "./bvhBuilder.js";
import type { RayBlasDescriptor } from "./rayBackendTypes.js";

/**
 * T10 切片1：软件射线参考（bvhBuilder.intersectTriangle / rayTrace.traceClosest）的
 * 边界语义确定性合同。全部几何用二进制精确可表示值，期望 t 为解析值——
 * 这些测试是软件 WGSL 后端与未来硬件 RT 腿的共同仲裁基准（主计划 §T10：
 * 「软件与硬件射线命中三角形/距离符合容差」）。
 *
 * 语义合同（与 WGSL kernel rayTraceKernel 逐行同构）：
 * - 闭集边界：u∈[0,1]、v≥0、u+v≤1、t∈[0,tMax] 全含（边界切线/顶点/tMax 恰等均命中）；
 * - 双面命中：det 仅按 |det|<1e-20 拒绝，背面命中 t 与正面一致；
 * - 退化/共面射线：零面积三角形与共面射线（det≈0）一律 miss；
 * - 起点在面上：t=0 双向命中（自交不排除；偏置是调用方责任，合同只有 tMax）。
 */

/** 单三角参考场景：T = (0,0,0),(2,0,0),(0,2,0)，平面 z=0，斜边 x+y=2。 */
function unitTriangleScene(): TracedScene {
  return buildTracedScene({
    id: "ref-triangle",
    vertices: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
    indices: Uint32Array.from([0, 1, 2]),
  });
}

/** 双平行三角：prim0 在 z=0、prim1 在 z=-1（测最近命中选择）。 */
function twoPlaneScene(): TracedScene {
  return buildTracedScene({
    id: "ref-two-planes",
    vertices: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, -1, 2, 0, -1, 0, 2, -1]),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
  });
}

/** 斜面三角：平面 z = 1 - x - y（测斜面命中距离解析值 4.75）。 */
function tiltedPlaneScene(): TracedScene {
  return buildTracedScene({
    id: "ref-tilted",
    vertices: new Float32Array([0, 0, 1, 2, 0, -1, 0, 2, -1]),
    indices: Uint32Array.from([0, 1, 2]),
  });
}

const down = (ox: number, oy: number, oz: number, tMax = 10): TraceQuery =>
  ({ ox, oy, oz, dx: 0, dy: 0, dz: -1, tMax });

describe("software ray reference semantics (T10 slice 1)", () => {
  it("hits the interior with the exact analytic distance and primitive index", () => {
    const scene = unitTriangleScene();
    const hit = traceClosest(scene, down(0.5, 0.5, 3));
    expect(hit).toBeDefined();
    expect(hit!.primitiveIndex).toBe(0);
    expect(hit!.t).toBe(3); // 3.0 在二进制下精确。
    // 重心合同：命中 t 处的重心坐标恒 0（见 rayTraceLayout 头注释，距离语义不受影响）。
    expect(hit!.barycentricU).toBe(0);
    expect(hit!.barycentricV).toBe(0);
  });

  it("hits the slanted plane at the exact analytic distance through the full bvh path", () => {
    // 平面 z = 1 - x - y；x=0.25,y=0.5 → z=0.25 → 从 z=5 出发 t = 5 - 0.25 = 4.75。
    const hit = traceClosest(tiltedPlaneScene(), down(0.25, 0.5, 5));
    expect(hit).toBeDefined();
    expect(hit!.t).toBe(4.75);
  });

  it("misses on back-facing direction, side offsets beyond the slanted edge, and short tMax", () => {
    const scene = unitTriangleScene();
    expect(traceClosest(scene, down(0.5, 0.5, 3, 2.5))).toBeUndefined(); // tMax < t → miss
    expect(traceClosest(scene, down(3, 3, 3))).toBeUndefined(); // (3,3,0) 在斜边外
    expect(traceClosest(scene, down(-0.25, 0.5, 3))).toBeUndefined(); // x<0 边外
    expect(traceClosest(scene, { ox: 0.5, oy: 0.5, oz: 3, dx: 0, dy: 0, dz: 1, tMax: 10 })).toBeUndefined();
    // 斜边外一点（u+v=1.125>1）与斜边内一点（u+v=0.9375）严格分界。
    expect(traceClosest(scene, down(1.5, 1, 3))).toBeUndefined();
    expect(traceClosest(scene, down(1.25, 0.625, 3))).toBeDefined();
  });

  it("accepts edge tangent, vertex, and tMax-boundary hits as closed-set semantics", () => {
    const scene = unitTriangleScene();
    // 三条边切线：u=0（v0-v2 边）、v=0（v0-v1 边）、u+v=1（斜边）。
    expect(traceClosest(scene, down(0, 1, 3))!.t).toBe(3);
    expect(traceClosest(scene, down(1, 0, 3))!.t).toBe(3);
    expect(traceClosest(scene, down(1, 1, 3))!.t).toBe(3);
    // 顶点角 u=v=0 与 tMax 恰等（t <= tMax 闭集）。
    expect(traceClosest(scene, down(0, 0, 3))!.t).toBe(3);
    expect(traceClosest(scene, down(0.5, 0.5, 3, 3))!.t).toBe(3);
  });

  it("hits back faces with the identical distance (double-sided, det sign accepted)", () => {
    const scene = unitTriangleScene();
    const front = traceClosest(scene, down(0.5, 0.5, 3));
    const back = traceClosest(scene, { ox: 0.5, oy: 0.5, oz: -3, dx: 0, dy: 0, dz: 1, tMax: 10 });
    expect(back).toBeDefined();
    expect(back!.primitiveIndex).toBe(front!.primitiveIndex);
    expect(back!.t).toBe(front!.t);
    // det<0 不被拒绝的语义级证据：intersectTriangle 对反绕序同样命中同一 t。
    const flipped = new Float32Array([0, 0, 0, 0, 2, 0, 2, 0, 0]);
    expect(intersectTriangle(0.5, 0.5, 3, 0, 0, -1, flipped, 0, 1, 2)).toBe(3);
  });

  it("rejects degenerate triangles and coplanar rays deterministically", () => {
    const degenerate = new Float32Array([0, 0, 0, 1, 1, 0, 2, 2, 0]);
    expect(intersectTriangle(0.5, 0.5, 3, 0, 0, -1, degenerate, 0, 1, 2)).toBe(-1);
    // 共面射线（几何上穿过三角形内部）det=0 → 合同一律 miss，不产生假命中。
    const scene = unitTriangleScene();
    expect(traceClosest(scene, { ox: 0.5, oy: 0.5, oz: 0, dx: 1, dy: 0, dz: 0, tMax: 10 })).toBeUndefined();
  });

  it("hits t=0 from an origin lying on the triangle plane in both directions", () => {
    const scene = unitTriangleScene();
    expect(traceClosest(scene, down(0.5, 0.5, 0))!.t).toBe(0);
    // 反向命中的 t 是 -0：t = (e2·q)*inv 的末次乘法在零积上保留符号。
    // 这是参考合同的一部分——WGSL 内核逐行同构（f32 同样产生 -0），数值比较（t>=0、
    // t<best.t）下 -0 与 +0 行为一致；钉住它以保证 CPU/WGSL/未来硬件腿逐位可对拍。
    const reversed = traceClosest(scene, { ox: 0.5, oy: 0.5, oz: 0, dx: 0, dy: 0, dz: 1, tMax: 10 })!;
    expect(Object.is(reversed.t, -0)).toBe(true);
  });

  it("selects the nearest of two parallel planes and keeps occlusion agreement over a fan", () => {
    const scene = twoPlaneScene();
    const hit = traceClosest(scene, down(0.5, 0.5, 3));
    expect(hit!.primitiveIndex).toBe(0);
    expect(hit!.t).toBe(3);
    // 扇形射线：occluded 与 closest 逐射线一致（阴影/可见性合同）。
    for (let step = 0; step < 24; step++) {
      const angle = (step / 24) * Math.PI * 2;
      const query: TraceQuery = { ox: 0.5, oy: 0.5, oz: 3, dx: Math.cos(angle) * 0.5,
        dy: Math.sin(angle) * 0.5, dz: -1, tMax: 8 };
      expect(traceOccluded(scene, query)).toBe(traceClosest(scene, query) !== undefined);
    }
  });

  it("is bitwise deterministic across repeated identical queries", () => {
    const scenes = [unitTriangleScene(), twoPlaneScene(), tiltedPlaneScene()];
    for (const scene of scenes) {
      const reference = traceClosest(scene, down(0.5, 0.5, 3));
      for (let repeat = 0; repeat < 64; repeat++) {
        const hit = traceClosest(scene, down(0.5, 0.5, 3));
        expect(hit === undefined).toBe(reference === undefined);
        if (reference !== undefined) {
          expect(hit!.t === reference.t).toBe(true); // 逐位相等（非 closeTo）。
          expect(hit!.primitiveIndex === reference.primitiveIndex).toBe(true);
        }
      }
    }
  });

  it("reconstructs in-triangle hit points for every fan ray (distance/plane agreement)", () => {
    const blas: RayBlasDescriptor = tiltedPlaneScene().blas;
    const scene = tiltedPlaneScene();
    // 1/8 二进制精确网格：全部中间量 dyadic，恒等式逐位成立（不做容差近似）。
    for (let step = 0; step < 12; step++) {
      const ox = 0.125 * (1 + step), oy = 0.125 * (1 + ((step * 5) % 12));
      const hit = traceClosest(scene, down(ox, oy, 5));
      if (ox + oy >= 2) { expect(hit).toBeUndefined(); continue; } // 斜边外的起点不命中。
      expect(hit).toBeDefined();
      // 命中点必须落在三角形平面上：z = 1 - x - y（解析恒等式，dyadic 域内逐位精确）。
      const hz = 5 - hit!.t;
      expect(hz).toBe(1 - ox - oy);
      // 与直接 Möller–Trumbore（绕过 BVH）同值。
      expect(hit!.t).toBe(intersectTriangle(ox, oy, 5, 0, 0, -1, blas.vertices, 0, 1, 2));
    }
  });
});
