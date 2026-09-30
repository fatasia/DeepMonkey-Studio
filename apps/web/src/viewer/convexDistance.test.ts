import { describe, expect, it } from "vitest";
import {
  convexDistance,
  convexShapeFromUrdfGeometry,
  toWorldBody,
  translationTransform,
  transformFromUrdfOrigin,
  type ConvexShape,
  type RigidTransform,
  type WorldConvexBody,
} from "./convexDistance";

/**
 * N10 窄相位聚焦测试:解析构造用例对拍(球/盒最近点对距离有封闭解)+
 * 与 Rapier castRay(T17 同族物理查询,Web 端)交叉验证。口径见
 * docs/specs/n10-narrow-phase-sweep-20261001.md §3/§5。
 */

function sphereBody(radius: number, center: [number, number, number]): WorldConvexBody {
  return toWorldBody({ kind: "sphere", radius }, translationTransform(center));
}

function verticesBody(vertices: readonly number[], transform: RigidTransform): WorldConvexBody {
  return toWorldBody({ kind: "vertices", vertices }, transform);
}

function unitBoxVertices(half = 1): readonly number[] {
  const shape = convexShapeFromUrdfGeometry({ type: "box", size: { x: half * 2, y: half * 2, z: half * 2 } });
  if (shape.kind !== "vertices") throw new Error("box 几何必须顶点化");
  return shape.vertices;
}

function quatZ(angleRad: number): [number, number, number, number] {
  return [0, 0, Math.sin(angleRad / 2), Math.cos(angleRad / 2)];
}

describe("convexDistance 解析对拍", () => {
  it("球-球已知距离:距离与最近点对均在连心线上", () => {
    const a = sphereBody(0.5, [0, 0, 0]);
    const b = sphereBody(0.5, [2, 0, 0]);
    const result = convexDistance(a, b);
    expect(result.separated).toBe(true);
    if (!result.separated) return;
    expect(result.distance).toBeCloseTo(1, 9);
    expect(result.pointA[0]).toBeCloseTo(0.5, 9);
    expect(result.pointB[0]).toBeCloseTo(1.5, 9);
    expect(result.pointA[1]).toBeCloseTo(0, 9);
    expect(result.pointB[2]).toBeCloseTo(0, 9);
  });

  it("交换律:distance(A,B) 与 distance(B,A) 一致,且 |pointA−pointB| = distance", () => {
    const a = sphereBody(0.3, [0.1, -0.2, 0.3]);
    const b = verticesBody(unitBoxVertices(0.4), { translation: [1.2, 0.4, -0.5], rotationQuaternion: quatZ(0.7) });
    const ab = convexDistance(a, b);
    const ba = convexDistance(b, a);
    expect(ab.separated && ba.separated).toBe(true);
    if (!ab.separated || !ba.separated) return;
    expect(ab.distance).toBe(ba.distance);
    const gap = Math.hypot(ab.pointA[0] - ab.pointB[0], ab.pointA[1] - ab.pointB[1], ab.pointA[2] - ab.pointB[2]);
    expect(gap).toBeCloseTo(ab.distance, 9);
  });

  it("球-球恰接触:距离 ≈ 0 按规格记碰撞(d=0);渗透:报碰撞且无接触点", () => {
    // 规格口径:touch/渗透(d ≤ absTol)一律记碰撞;分离态要求 d > absTol。
    const tangent = convexDistance(sphereBody(0.5, [0, 0, 0]), sphereBody(0.5, [1, 0, 0]));
    const tangentColliding = !tangent.separated || tangent.distance <= 1e-9;
    expect(tangentColliding).toBe(true);
    const penetrating = convexDistance(sphereBody(0.5, [0, 0, 0]), sphereBody(0.5, [0.5, 0, 0]));
    expect(penetrating).toEqual({ separated: false, distance: 0 });
  });

  it("盒-盒(半边 1,一个绕 z 旋转 45°):距离 = D − 1 − √2,最近点解析一致", () => {
    const d = 4;
    const a = verticesBody(unitBoxVertices(1), translationTransform([0, 0, 0]));
    const b = verticesBody(unitBoxVertices(1), { translation: [d, 0, 0], rotationQuaternion: quatZ(Math.PI / 4) });
    const result = convexDistance(a, b);
    expect(result.separated).toBe(true);
    if (!result.separated) return;
    const expected = d - 1 - Math.SQRT2;
    // GJK 相对收敛容差 1e-6 → 绝对误差 ≤ 1e-6·distance + 1e-9。
    expect(Math.abs(result.distance - expected)).toBeLessThanOrEqual(1e-6 * expected + 1e-9);
    expect(result.pointA[0]).toBeCloseTo(1, 6);
    expect(result.pointA[1]).toBeCloseTo(0, 6);
    expect(result.pointB[0]).toBeCloseTo(d - Math.SQRT2, 6);
    expect(result.pointB[1]).toBeCloseTo(0, 6);
  });

  it("单点体 vs 球:距离与点位置精确", () => {
    const point = verticesBody([0, 0, 0], translationTransform([0, 0, 0]));
    const ball = sphereBody(0.5, [2, 0, 0]);
    const result = convexDistance(point, ball);
    expect(result.separated).toBe(true);
    if (!result.separated) return;
    expect(result.distance).toBeCloseTo(1.5, 9);
    expect(result.pointA[0]).toBeCloseTo(0, 9);
    expect(result.pointB[0]).toBeCloseTo(1.5, 9);
  });

  it("圆柱顶点化(同轴对齐):沿 x 间隙解析精确(支撑方向恰命中圆周顶点)", () => {
    // 24 段圆周顶点在 ±x 方向恰有顶点(角度 0),支撑精确;间隙 0.5。
    const cylinder = convexShapeFromUrdfGeometry({ type: "cylinder", radius: 0.1, length: 0.4 });
    const a = toWorldBody(cylinder, translationTransform([0, 0, 0]));
    const b = toWorldBody(cylinder, translationTransform([0.7, 0, 0]));
    const result = convexDistance(a, b);
    expect(result.separated).toBe(true);
    if (!result.separated) return;
    expect(result.distance).toBeCloseTo(0.5, 6);
  });

  it("确定性:同输入两次查询逐位相等", () => {
    const a = verticesBody(unitBoxVertices(0.5), { translation: [0, 0, 0], rotationQuaternion: quatZ(0.3) });
    const b = verticesBody(unitBoxVertices(0.5), { translation: [1.3, 0.2, -0.1], rotationQuaternion: quatZ(-0.9) });
    const first = convexDistance(a, b);
    const second = convexDistance(a, b);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("convexDistance 输入校验", () => {
  it("空顶点集 / 非法球半径 / 零四元数 / NaN 顶点显式报错", () => {
    expect(() => toWorldBody({ kind: "vertices", vertices: [] }, translationTransform([0, 0, 0]))).toThrow();
    expect(() => toWorldBody({ kind: "sphere", radius: 0 }, translationTransform([0, 0, 0]))).toThrow();
    expect(() => toWorldBody({ kind: "sphere", radius: -1 }, translationTransform([0, 0, 0]))).toThrow();
    expect(() => toWorldBody({ kind: "vertices", vertices: [1, 2, 3] }, { translation: [0, 0, 0], rotationQuaternion: [0, 0, 0, 0] })).toThrow();
    expect(() => toWorldBody({ kind: "vertices", vertices: [1, 2, Number.NaN] }, translationTransform([0, 0, 0]))).toThrow();
  });

  it("GJK 选项越界显式报错", () => {
    const a = sphereBody(0.5, [0, 0, 0]);
    const b = sphereBody(0.5, [2, 0, 0]);
    expect(() => convexDistance(a, b, { relativeTolerance: 1 })).toThrow();
    expect(() => convexDistance(a, b, { absoluteTolerance: 0 })).toThrow();
    expect(() => convexDistance(a, b, { maxIterations: 0 })).toThrow();
  });
});

describe("URDF 几何顶点化", () => {
  it("box 8 顶点 / sphere 解析 / cylinder 48 顶点 / mesh 显式拒绝", () => {
    const box = convexShapeFromUrdfGeometry({ type: "box", size: { x: 2, y: 2, z: 2 } });
    if (box.kind !== "vertices") throw new Error("box 几何必须顶点化");
    expect(box.vertices.length).toBe(24);
    const sphere: ConvexShape = convexShapeFromUrdfGeometry({ type: "sphere", radius: 0.2 });
    expect(sphere).toEqual({ kind: "sphere", radius: 0.2 });
    const cylinder = convexShapeFromUrdfGeometry({ type: "cylinder", radius: 0.1, length: 1 });
    if (cylinder.kind !== "vertices") throw new Error("cylinder 几何必须顶点化");
    expect(cylinder.vertices.length).toBe(144);
    expect(() => convexShapeFromUrdfGeometry({ type: "mesh", filename: "a.stl", resolvedPath: "p", scale: { x: 1, y: 1, z: 1 } })).toThrow(/T17 凸包管线/);
    expect(() => convexShapeFromUrdfGeometry({ type: "box", size: { x: 0, y: 1, z: 1 } })).toThrow();
  });

  it("URDF origin(xyz+rpy)变换:rpy 恒等时与 translationTransform 逐位一致", () => {
    const viaOrigin = transformFromUrdfOrigin([1, 2, 3], [0, 0, 0]);
    expect(viaOrigin).toEqual(translationTransform([1, 2, 3]));
    // 90° yaw:局部 +X → 世界 +Y。
    const rotated = transformFromUrdfOrigin([0, 0, 0], [0, 0, Math.PI / 2]);
    const body = toWorldBody({ kind: "vertices", vertices: [1, 0, 0] }, rotated);
    expect(body.vertices[0]).toBeCloseTo(0, 12);
    expect(body.vertices[1]).toBeCloseTo(1, 12);
  });
});

describe("与 Rapier castRay 交叉验证(T17 同族物理查询)", () => {
  it("球:GJK 距离 = castRay toi(连心线);凸包盒:两者一致", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    // ① 球 r=0.5 @ (2,0,0),射线从原点沿 +x:toi = 1.5 = 单点体 GJK 距离。
    const ballWorld = new rapier.World({ x: 0, y: 0, z: 0 });
    const ballBody = ballWorld.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(2, 0, 0));
    ballWorld.createCollider(rapier.ColliderDesc.ball(0.5), ballBody);
    ballWorld.step();
    const ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    const ballHit = ballWorld.castRay(ray, 100, true);
    expect(ballHit).not.toBeNull();
    const pointVsBall = convexDistance(
      verticesBody([0, 0, 0], translationTransform([0, 0, 0])),
      sphereBody(0.5, [2, 0, 0]),
    );
    expect(pointVsBall.separated).toBe(true);
    if (ballHit && pointVsBall.separated) {
      expect(Math.abs(ballHit.timeOfImpact - pointVsBall.distance)).toBeLessThan(1e-6);
    }
    ballWorld.free();

    // ② 凸包盒 @ (4,0,0)(无旋转, Rapier hull 与顶点集同源):射线从 (1,0,0) 起,toi = 2;
    //    GJK 盒-盒距离 = 4 − 1 − 1 = 2。独立 world,避免与球场景互相命中。
    const boxVertices = unitBoxVertices(1);
    const hull = rapier.ColliderDesc.convexHull(new Float32Array(boxVertices));
    expect(hull).not.toBeNull();
    const boxWorld = new rapier.World({ x: 0, y: 0, z: 0 });
    const boxBody = boxWorld.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(4, 0, 0));
    if (hull) boxWorld.createCollider(hull, boxBody);
    boxWorld.step();
    const boxRay = new rapier.Ray({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    const boxHit = boxWorld.castRay(boxRay, 100, true);
    const boxA = verticesBody(boxVertices, translationTransform([0, 0, 0]));
    const boxB = verticesBody(boxVertices, translationTransform([4, 0, 0]));
    const boxDistance = convexDistance(boxA, boxB);
    expect(boxDistance.separated).toBe(true);
    if (boxHit && boxDistance.separated) {
      expect(Math.abs(boxHit.timeOfImpact - boxDistance.distance)).toBeLessThan(1e-6);
    }
    boxWorld.free();
  });
});
