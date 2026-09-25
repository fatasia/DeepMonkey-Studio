import type { XtCircleCurve, XtConeSurface, XtCylinderSurface, XtPlaneSurface, XtSphereSurface } from "./surfaces.js";
import { crossProduct, type Vec3 } from "./tokens.js";

/** 与 xtRevolvedMesh 相同的离散精度口径：圆周 64 段。 */
export const XT_ANGULAR_SEGMENTS = 64;
export const XT_SPHERE_LATITUDE_SEGMENTS = 32;

export interface XtTriangleMesh {
  positions: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
}

/**
 * 平面片：以 ref 为 u、normal×ref 为 v 的参数网格，尺寸由调用方显式给出。
 * 没有可信 extent 时不得调用——通用解析器不解码 trim 环，禁止虚构面片大小。
 */
export function tessellatePlanePatch(surface: XtPlaneSurface, extent: { u: number; v: number }, grid = 1): XtTriangleMesh {
  const vVector = crossProduct(surface.normal, surface.refDirection);
  const rows = grid + 1;
  const positions = new Float32Array(rows * rows * 3);
  const indices = new Uint32Array(grid * grid * 6);
  let offset = 0;
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      const u = (j / grid - 0.5) * extent.u;
      const v = (i / grid - 0.5) * extent.v;
      positions.set([
        surface.point[0] + surface.refDirection[0] * u + vVector[0] * v,
        surface.point[1] + surface.refDirection[1] * u + vVector[1] * v,
        surface.point[2] + surface.refDirection[2] * u + vVector[2] * v,
      ], offset);
      offset += 3;
    }
  }
  let index = 0;
  for (let i = 0; i < grid; i += 1) {
    for (let j = 0; j < grid; j += 1) {
      const a = i * rows + j;
      indices.set([a, a + rows, a + 1, a + 1, a + rows, a + rows + 1], index);
      index += 6;
    }
  }
  return { positions, indices, triangleCount: indices.length / 3 };
}

export interface AxialSpan {
  start: number;
  end: number;
}

/** 圆柱面片：沿 axis 的完整 360° 柱面，轴向范围由同轴圆边推断。 */
export function tessellateCylinderPatch(surface: XtCylinderSurface, span: AxialSpan): XtTriangleMesh {
  const second = crossProduct(surface.axis, surface.refDirection);
  const ringAt = (t: number, angle: number): Vec3 => radialPoint(surface.point, surface.axis, surface.refDirection, second, angle, surface.radius, t);
  return sweepRings([span.start, span.end], ringAt);
}

/** 圆锥面片：半角由 cosine 反推，沿 axis 线性张成到 t 处的半径。 */
export function tessellateConePatch(surface: XtConeSurface, span: AxialSpan): XtTriangleMesh {
  const tanHalf = Math.sqrt(Math.max(0, 1 - surface.cosineAngle * surface.cosineAngle)) / surface.cosineAngle;
  const second = crossProduct(surface.axis, surface.refDirection);
  const ringAt = (t: number, angle: number): Vec3 =>
    radialPoint(surface.point, surface.axis, surface.refDirection, second, angle, surface.radius + t * tanHalf, t);
  return sweepRings([span.start, span.end], ringAt);
}

/** 完整球面：球的范围由参数内在决定，不需要外部 extent。 */
export function tessellateSphere(surface: XtSphereSurface): XtTriangleMesh {
  const rows = XT_SPHERE_LATITUDE_SEGMENTS + 1;
  const columns = XT_ANGULAR_SEGMENTS + 1;
  const positions = new Float32Array(rows * columns * 3);
  const indices = new Uint32Array((rows - 1) * XT_ANGULAR_SEGMENTS * 6);
  let offset = 0;
  for (let i = 0; i < rows; i += 1) {
    const phi = (i / (rows - 1) - 0.5) * Math.PI;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    for (let j = 0; j < columns; j += 1) {
      const theta = (j / XT_ANGULAR_SEGMENTS) * Math.PI * 2;
      positions.set([
        surface.center[0] + surface.radius * cos * Math.cos(theta),
        surface.center[1] + surface.radius * sin,
        surface.center[2] + surface.radius * cos * Math.sin(theta),
      ], offset);
      offset += 3;
    }
  }
  let index = 0;
  for (let i = 0; i < rows - 1; i += 1) {
    for (let j = 0; j < XT_ANGULAR_SEGMENTS; j += 1) {
      const a = i * columns + j;
      indices.set([a, a + columns, a + 1, a + 1, a + columns, a + columns + 1], index);
      index += 6;
    }
  }
  return { positions, indices, triangleCount: indices.length / 3 };
}

/**
 * 用同轴圆边推断圆柱轴向范围：同 axis(±1e-6)、同半径(±1e-7) 的圆心在轴上的投影，
 * 相对 surface.point 张成范围（与 tessellateCylinderPatch 的 t 口径一致）。
 * 这是重构而非 B-rep trim 证据，转换器必须把它标成 approximation。
 */
export function inferCylinderSpanFromCircles(surface: XtCylinderSurface, circles: readonly XtCircleCurve[]): AxialSpan | undefined {
  const origin = dotProduct3(surface.point, surface.axis);
  const onAxis = circles
    .filter((circle) => circleMatchesSurface(circle, surface.axis, surface.radius))
    .map((circle) => dotProduct3(circle.point, surface.axis) - origin)
    .sort((a, b) => a - b);
  if (onAxis.length < 2) return undefined;
  const start = onAxis[0]!;
  const end = onAxis.at(-1)!;
  if (Math.abs(start - end) < 1e-9) return undefined;
  return { start, end };
}

export function circleMatchesSurface(circle: XtCircleCurve, axis: Vec3, radius: number): boolean {
  const aligned = Math.abs(dotProduct3(circle.axis, axis)) > 1 - 1e-6;
  return aligned && Math.abs(circle.radius - radius) < 1e-7;
}

/**
 * 用一对同轴等径圆边直接重构圆柱面参数（class 53 记录未验证时的回退路径）。
 * span 是相对 point 的轴向范围；entityId 取第一圆边。
 */
export interface XtReconstructedCylinder extends XtCylinderSurface {
  span: AxialSpan;
}

export function buildCylinderFromCoaxialCircles(first: XtCircleCurve, second: XtCircleCurve): XtReconstructedCylinder | undefined {
  if (Math.abs(dotProduct3(first.axis, second.axis)) < 1 - 1e-6) return undefined;
  if (Math.abs(first.radius - second.radius) > 1e-7) return undefined;
  const tFirst = dotProduct3(first.point, first.axis);
  const tSecond = dotProduct3(second.point, first.axis);
  if (Math.abs(tFirst - tSecond) < 1e-9) return undefined;
  const near = Math.min(tFirst, tSecond);
  const origin: Vec3 = first.axis.map((component) => component * near) as Vec3;
  return {
    family: "cylinder",
    entityId: first.entityId,
    point: origin,
    axis: first.axis,
    refDirection: first.refDirection,
    radius: first.radius,
    span: { start: 0, end: Math.max(tFirst, tSecond) - near },
  };
}

function radialPoint(origin: Vec3, axis: Vec3, ref: Vec3, second: Vec3, angle: number, radius: number, t: number): Vec3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    origin[0] + axis[0] * t + (ref[0] * cos + second[0] * sin) * radius,
    origin[1] + axis[1] * t + (ref[1] * cos + second[1] * sin) * radius,
    origin[2] + axis[2] * t + (ref[2] * cos + second[2] * sin) * radius,
  ];
}

function sweepRings(spans: readonly [number, number], ringAt: (t: number, angle: number) => Vec3): XtTriangleMesh {
  const [start, end] = spans;
  const columns = XT_ANGULAR_SEGMENTS + 1;
  const positions = new Float32Array(2 * columns * 3);
  const indices = new Uint32Array(XT_ANGULAR_SEGMENTS * 6);
  let offset = 0;
  for (const t of [start, end]) {
    for (let j = 0; j < columns; j += 1) {
      const angle = (j / XT_ANGULAR_SEGMENTS) * Math.PI * 2;
      positions.set(ringAt(t, angle), offset);
      offset += 3;
    }
  }
  let index = 0;
  for (let j = 0; j < XT_ANGULAR_SEGMENTS; j += 1) {
    indices.set([j, j + columns, j + 1, j + 1, j + columns, j + columns + 1], index);
    index += 6;
  }
  return { positions, indices, triangleCount: indices.length / 3 };
}

function dotProduct3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
