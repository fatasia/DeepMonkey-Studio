import { isIntegerToken, isNumberToken, isOrthogonal, isUnitVector, parseXtNumber, readVec3, type Vec3 } from "./tokens.js";

/** 已实现的基础实体族；布局来自公开 Parasolid 文本格式参考与真实样本校准。 */
export type XtSurfaceFamily = "plane" | "cylinder" | "cone" | "sphere";

export interface XtSurfaceBase {
  family: XtSurfaceFamily;
  entityId: number;
}

export interface XtPlaneSurface extends XtSurfaceBase {
  family: "plane";
  point: Vec3;
  normal: Vec3;
  refDirection: Vec3;
}

export interface XtCylinderSurface extends XtSurfaceBase {
  family: "cylinder";
  point: Vec3;
  axis: Vec3;
  refDirection: Vec3;
  radius: number;
}

export interface XtConeSurface extends XtSurfaceBase {
  family: "cone";
  point: Vec3;
  axis: Vec3;
  refDirection: Vec3;
  /** 半角的余弦；Parasolid 用 cosine 限制圆锥角。 */
  cosineAngle: number;
  radius: number;
}

export interface XtSphereSurface extends XtSurfaceBase {
  family: "sphere";
  center: Vec3;
  radius: number;
}

export type XtSurface = XtPlaneSurface | XtCylinderSurface | XtConeSurface | XtSphereSurface;

export interface XtCircleCurve {
  entityId: number;
  point: Vec3;
  axis: Vec3;
  refDirection: Vec3;
  radius: number;
}

export interface XtTorusSurface {
  entityId: number;
  point: Vec3;
  axis: Vec3;
  majorRadius: number;
  minorRadius: number;
  refDirection: Vec3;
}

/**
 * 每个类允许的“类型 token 到载荷”距离。255 标记、属性链长度会随写入口径变化，
 * 因此按候选逐个尝试，用几何合法性收口，而不是相信固定偏移。
 * 轴向族（圆/圆环/平面/圆柱/圆锥）的真实样本帧距是 5–7；球面帧距更短，先试小帧距防 aliasing。
 */
export const AXIAL_OFFSETS: readonly number[] = [6, 5, 7, 4];
export const SPHERE_OFFSETS: readonly number[] = [4, 3, 5, 6];

/** 圆边（class 31）：pnt[3] axis[3] ref[3] radius，与已签署旋转体子集的布局一致。 */
export function parseCircleRecord(tokens: readonly string[], payloadAt: number, entityId: number): XtCircleCurve | undefined {
  const point = readVec3(tokens, payloadAt);
  const axis = readVec3(tokens, payloadAt + 3);
  const ref = readVec3(tokens, payloadAt + 6);
  const radius = parseXtNumber(tokens[payloadAt + 9] ?? "");
  if (!point || !axis || !ref) return undefined;
  if (!isUnitVector(axis) || !isUnitVector(ref) || !isOrthogonal(axis, ref)) return undefined;
  if (!Number.isFinite(radius) || radius <= 1e-9 || radius > 1e6) return undefined;
  return { entityId, point, axis, refDirection: ref, radius };
}

/** 圆环面（class 54）：pnt[3] axis[3] major minor ref[3]，与真实样本布局一致。 */
export function parseTorusRecord(tokens: readonly string[], payloadAt: number, entityId: number): XtTorusSurface | undefined {
  const point = readVec3(tokens, payloadAt);
  const axis = readVec3(tokens, payloadAt + 3);
  const major = parseXtNumber(tokens[payloadAt + 6] ?? "");
  const minor = parseXtNumber(tokens[payloadAt + 7] ?? "");
  const ref = readVec3(tokens, payloadAt + 8);
  if (!point || !axis || !ref) return undefined;
  if (!isUnitVector(axis) || !isUnitVector(ref) || !isOrthogonal(axis, ref)) return undefined;
  if (![major, minor].every((value) => Number.isFinite(value) && value > 1e-9 && value < 1e6)) return undefined;
  return { entityId, point, axis, majorRadius: major, minorRadius: minor, refDirection: ref };
}

/** 平面（class 52，PL）：12 数布局 pnt[3] normal[3] 辅助向量[3] ref[3]；辅助向量语义未定，只取两组正交单位向量。 */
export function parsePlaneRecord(tokens: readonly string[], payloadAt: number, entityId: number): XtPlaneSurface | undefined {
  const layouts: Array<{ normal: number; ref: number }> = [{ normal: 3, ref: 9 }, { normal: 3, ref: 6 }];
  for (const layout of layouts) {
    const point = readVec3(tokens, payloadAt);
    const normal = readVec3(tokens, payloadAt + layout.normal);
    const ref = readVec3(tokens, payloadAt + layout.ref);
    if (!point || !normal || !ref) continue;
    if (!isUnitVector(normal) || !isUnitVector(ref) || !isOrthogonal(normal, ref)) continue;
    return { family: "plane", entityId, point, normal, refDirection: ref };
  }
  return undefined;
}

/** 圆柱面（class 53，CL）：pnt[3] axis[3] ref[3] radius。 */
export function parseCylinderRecord(tokens: readonly string[], payloadAt: number, entityId: number): XtCylinderSurface | undefined {
  const point = readVec3(tokens, payloadAt);
  const axis = readVec3(tokens, payloadAt + 3);
  const ref = readVec3(tokens, payloadAt + 6);
  const radius = parseXtNumber(tokens[payloadAt + 9] ?? "");
  if (!point || !axis || !ref) return undefined;
  if (!isUnitVector(axis) || !isUnitVector(ref) || !isOrthogonal(axis, ref)) return undefined;
  if (!Number.isFinite(radius) || radius <= 1e-9 || radius > 1e6) return undefined;
  return { family: "cylinder", entityId, point, axis, refDirection: ref, radius };
}

/** 圆锥面（class 55，KH）：pnt[3] axis[3] ref[3] cosine radius。 */
export function parseConeRecord(tokens: readonly string[], payloadAt: number, entityId: number): XtConeSurface | undefined {
  const point = readVec3(tokens, payloadAt);
  const axis = readVec3(tokens, payloadAt + 3);
  const ref = readVec3(tokens, payloadAt + 6);
  const cosine = parseXtNumber(tokens[payloadAt + 9] ?? "");
  const radius = parseXtNumber(tokens[payloadAt + 10] ?? "");
  if (!point || !axis || !ref) return undefined;
  if (!isUnitVector(axis) || !isUnitVector(ref) || !isOrthogonal(axis, ref)) return undefined;
  if (!Number.isFinite(cosine) || cosine <= 1e-6 || cosine > 1) return undefined;
  if (!Number.isFinite(radius) || radius <= 1e-9 || radius > 1e6) return undefined;
  return { family: "cone", entityId, point, axis, refDirection: ref, cosineAngle: cosine, radius };
}

/** 球面（class 57，SPH）：center[3] radius。半径约束较弱，命中率统计时单列低置信。 */
export function parseSphereRecord(tokens: readonly string[], payloadAt: number, entityId: number): XtSphereSurface | undefined {
  const center = readVec3(tokens, payloadAt);
  const radius = parseXtNumber(tokens[payloadAt + 3] ?? "");
  if (!center) return undefined;
  if (!Number.isFinite(radius) || radius <= 1e-9 || radius > 1e6) return undefined;
  return { family: "sphere", entityId, center, radius };
}

/**
 * 变换记录（class 100）：rotation[9] + translation[3]。
 * 旋转必须逐行单位正交；元数据长度随写入口径变化，按候选距离尝试。
 */
export interface XtTransformRecord {
  entityId: number;
  ownerEntityId: number;
  rotation: [Vec3, Vec3, Vec3];
  translation: Vec3;
}

export function parseTransformRecord(tokens: readonly string[], payloadAt: number, entityId: number, ownerEntityId: number): XtTransformRecord | undefined {
  const rotation: [Vec3, Vec3, Vec3] = [
    readVec3(tokens, payloadAt) ?? [Number.NaN, 0, 0],
    readVec3(tokens, payloadAt + 3) ?? [Number.NaN, 0, 0],
    readVec3(tokens, payloadAt + 6) ?? [Number.NaN, 0, 0],
  ];
  const translation = readVec3(tokens, payloadAt + 9);
  if (!translation || rotation.some((row) => !row.every(Number.isFinite))) return undefined;
  if (rotation.some((row) => !isUnitVector(row, 1e-3))) return undefined;
  if (!isOrthogonal(rotation[0], rotation[1], 1e-3) || !isOrthogonal(rotation[0], rotation[2], 1e-3) || !isOrthogonal(rotation[1], rotation[2], 1e-3)) return undefined;
  return { entityId, ownerEntityId, rotation, translation };
}

export const XT_CLASS = {
  circle: 31,
  face: 14,
  plane: 52,
  cylinder: 53,
  torus: 54,
  cone: 55,
  sphere: 57,
  transform: 100,
} as const;

/** 锚点判定：类号 + 后随整数即候选记录头；实体号必须像 id，不是坐标。 */
export function isRecordAnchor(tokens: readonly string[], index: number, classNumber: number): number | undefined {
  const classToken = tokens[index];
  const attrToken = tokens[index + 1];
  const idToken = tokens[index + 2];
  if (classToken === undefined || !isIntegerToken(classToken) || Number(classToken) !== classNumber) return undefined;
  if (!isIntegerToken(attrToken ?? "") || !isIntegerToken(idToken ?? "")) return undefined;
  const id = Number(idToken);
  return id >= 1 && id <= 1e7 ? id : undefined;
}

function vectorMagnitude(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}
