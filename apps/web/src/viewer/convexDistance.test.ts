import { describe, expect, it } from "vitest";
import {
  convexDistance,
  convexPenetration,
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

describe("convexPenetration EPA 合同", () => {
  it.each([
    { name: "球-球", a: sphereBody(1, [0, 0, 0]), b: sphereBody(0.5, [1, 0, 0]), depth: 0.5 },
    { name: "盒-盒", a: verticesBody(unitBoxVertices(), translationTransform([0, 0, 0])), b: verticesBody(unitBoxVertices(), translationTransform([1.5, 0.2, 0.1])), depth: 0.5 },
    { name: "盒-球", a: verticesBody(unitBoxVertices(), translationTransform([0, 0, 0])), b: sphereBody(0.5, [1.25, 0.2, 0.1]), depth: 0.25 },
  ])("$name:解析深度、方向与支撑接触点", ({ a, b, depth }) => {
    const result = convexPenetration(a, b, { relativeTolerance: 1e-9 });
    expect(result.converged).toBe(true);
    expect(result.depth).toBeCloseTo(depth, 5);
    expect(result.normal[0]).toBeCloseTo(1, 3);
    expect(result.normal[1]).toBeCloseTo(0, 3);
    expect(result.normal[2]).toBeCloseTo(0, 3);
    expect(Math.hypot(...result.normal)).toBeCloseTo(1, 12);
    for (let axis = 0; axis < 3; axis++) {
      expect(result.pointA[axis]! - result.pointB[axis]!).toBeCloseTo(result.depth * result.normal[axis]!, 6);
    }
  });

  it.each([
    { name: "球切触", a: sphereBody(0.5, [0, 0, 0]), b: sphereBody(0.5, [1, 0, 0]) },
    { name: "盒切触", a: verticesBody(unitBoxVertices(), translationTransform([0, 0, 0])), b: verticesBody(unitBoxVertices(), translationTransform([2, 0, 0])) },
    { name: "球分离", a: sphereBody(0.5, [0, 0, 0]), b: sphereBody(0.5, [2, 0, 0]) },
    { name: "共面退化", a: verticesBody([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], translationTransform([0, 0, 0])), b: verticesBody([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], translationTransform([0.1, 0, 0])) },
  ])("$name:不能作为严格穿透返回", ({ a, b }) => {
    expect(() => convexPenetration(a, b)).toThrow(/touch|degenerate|strict|penetrat/i);
  });

  it("默认公差:球深度误差受支撑间隙界限约束", () => {
    const result = convexPenetration(sphereBody(1, [0, 0, 0]), sphereBody(0.5, [1, 0, 0]));
    expect(result.converged).toBe(true);
    expect(result.depth).toBeGreaterThan(0);
    expect(0.5 - result.depth).toBeLessThanOrEqual(1e-6 * result.depth + 1e-9);
  });

  it.each(["球", "盒"])("%s:交换两体后深度保持、唯一 MTD 方向翻转", (kind) => {
    const a = kind === "球" ? sphereBody(1, [0, 0, 0]) : verticesBody(unitBoxVertices(), translationTransform([0, 0, 0]));
    const b = kind === "球" ? sphereBody(0.5, [0.7, 0.4, -0.2]) : verticesBody(unitBoxVertices(), translationTransform([1.5, 0.2, -0.1]));
    const ab = convexPenetration(a, b, { relativeTolerance: 1e-9 });
    const ba = convexPenetration(b, a, { relativeTolerance: 1e-9 });
    expect(ab.converged && ba.converged).toBe(true);
    expect(ab.depth).toBeCloseTo(ba.depth, 6);
    for (let axis = 0; axis < 3; axis++) expect(ab.normal[axis]).toBeCloseTo(-ba.normal[axis]!, 3);
    expect(convexPenetration(a, b, { relativeTolerance: 1e-9 })).toEqual(ab);
  });

  it("共同刚体旋转/平移:盒深度与世界方向保持合同,MTD 之后分离", () => {
    const angle = 0.7;
    const nx = Math.cos(angle), ny = Math.sin(angle);
    const offset: [number, number, number] = [3.1, -2.2, 0.3];
    const a = verticesBody(unitBoxVertices(), { translation: offset, rotationQuaternion: quatZ(angle) });
    const boxB = (distance: number) => verticesBody(unitBoxVertices(), {
      translation: [offset[0] + nx * distance - ny * 0.2, offset[1] + ny * distance + nx * 0.2, offset[2] + 0.1],
      rotationQuaternion: quatZ(angle),
    });
    const result = convexPenetration(a, boxB(1.5));
    expect(result.converged).toBe(true);
    expect(result.depth).toBeCloseTo(0.5, 9);
    expect(result.normal[0]).toBeCloseTo(nx, 9);
    expect(result.normal[1]).toBeCloseTo(ny, 9);
    for (let axis = 0; axis < 3; axis++) expect(result.pointA[axis]! - result.pointB[axis]!).toBeCloseTo(result.depth * result.normal[axis]!, 9);
    const separated = convexDistance(a, boxB(1.5 + result.depth + 1e-5));
    expect(separated.separated).toBe(true);
    if (separated.separated) expect(separated.distance).toBeCloseTo(1e-5, 9);
    expect(() => convexPenetration(a, boxB(2))).toThrow(/touch|strict/i);
  });

  it("低预算:有限深度下界不能冒充收敛", () => {
    const result = convexPenetration(sphereBody(1, [0, 0, 0]), sphereBody(0.5, [0.7, 0.4, 0.2]), { maxIterations: 1 });
    const exactDepth = 1.5 - Math.hypot(0.7, 0.4, 0.2);
    expect(result.converged).toBe(false);
    expect(Number.isFinite(result.depth)).toBe(true);
    expect(result.depth).toBeGreaterThanOrEqual(0);
    expect(result.depth).toBeLessThanOrEqual(exactDepth);
    expect([...result.normal, ...result.pointA, ...result.pointB].every(Number.isFinite)).toBe(true);
  });

  it("完全重心重合:MTD 非唯一仍返回确定的有限下界", () => {
    const a = sphereBody(1, [0, 0, 0]);
    const b = sphereBody(0.5, [0, 0, 0]);
    const result = convexPenetration(a, b);
    expect(result.depth).toBeGreaterThan(0);
    expect(result.depth).toBeLessThanOrEqual(1.5);
    expect(result.converged).toBe(false);
    expect([...result.normal, ...result.pointA, ...result.pointB].every(Number.isFinite)).toBe(true);
    expect(convexPenetration(a, b)).toEqual(result);
  });

  it("薄盒补维与小尺度球:严格穿透输出有限接触点", () => {
    const thin = convexShapeFromUrdfGeometry({ type: "box", size: { x: 4, y: 2e-4, z: 1 } });
    const a = toWorldBody(thin, { translation: [0, 0, 0], rotationQuaternion: quatZ(0.7) });
    const b = toWorldBody(thin, { translation: [-Math.sin(0.7) * 1e-4, Math.cos(0.7) * 1e-4, 0], rotationQuaternion: quatZ(0.7) });
    const result = convexPenetration(a, b);
    expect(result.converged).toBe(true);
    expect(result.depth).toBeCloseTo(1e-4, 9);
    const small = convexPenetration(sphereBody(1e-5, [0, 0, 0]), sphereBody(1e-5, [1.5e-5, 0, 0]), { absoluteTolerance: 1e-12 });
    expect(small.converged).toBe(true);
    expect(small.depth).toBeCloseTo(5e-6, 10);
    expect([...small.normal, ...small.pointA, ...small.pointB].every(Number.isFinite)).toBe(true);
    for (let axis = 0; axis < 3; axis++) {
      expect(Math.abs(small.pointA[axis]! - small.pointB[axis]! - small.depth * small.normal[axis]!)).toBeLessThan(1e-12);
    }
  });

  it("EPA 选项沿用 GJK 校验合同", () => {
    const a = sphereBody(1, [0, 0, 0]), b = sphereBody(1, [0.5, 0, 0]);
    expect(() => convexPenetration(a, b, { relativeTolerance: 1 })).toThrow();
    expect(() => convexPenetration(a, b, { absoluteTolerance: 0 })).toThrow();
    expect(() => convexPenetration(a, b, { maxIterations: 0 })).toThrow();
  });

  it.each(Array.from({ length: 12 }, (_, index) => index + 1))("球解析方向矩阵 %i:深度、方向与点差", (index) => {
    const radiusA = 0.3 + index * 0.03, radiusB = 0.2 + index * 0.02;
    const raw = [Math.sin(index * 0.7), Math.cos(index * 1.3), Math.sin(index * 0.3)];
    const length = Math.hypot(...raw);
    const normal = raw.map(value => value / length);
    const distance = (radiusA + radiusB) * 0.75;
    const a = sphereBody(radiusA, [0.1, -0.2, 0.3]);
    const b = sphereBody(radiusB, [0.1 + normal[0]! * distance, -0.2 + normal[1]! * distance, 0.3 + normal[2]! * distance]);
    const result = convexPenetration(a, b, { relativeTolerance: 1e-8 });
    const exact = radiusA + radiusB - distance;
    expect(result.converged).toBe(true);
    expect(result.depth).toBeGreaterThan(0);
    expect(Math.abs(exact - result.depth)).toBeLessThanOrEqual(1e-8 * result.depth + 1e-9);
    for (let axis = 0; axis < 3; axis++) {
      expect(result.normal[axis]).toBeCloseTo(normal[axis]!, 3);
      expect(result.pointA[axis]! - result.pointB[axis]!).toBeCloseTo(result.depth * result.normal[axis]!, 8);
    }
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
