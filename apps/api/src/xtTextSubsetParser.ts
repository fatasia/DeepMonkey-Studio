import {
  probeXtStructure,
  XT_MAX_SAMPLE_BYTES,
  type XtHeaderMetadata,
} from "./xtStructureProbe.js";

export const XT_TEXT_SUBSET_MAX_BYTES = 16 * 1024 * 1024;
export const XT_REVOLVED_SUBSET_SCHEMA = "SCH_2401231_20000_1300";
const NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const METADATA_FIELDS = "(?:\\s+[?+\\-]?\\d+){6}";
const MILLIMETERS_PER_SOURCE_UNIT = 1_000;

export interface XtProfilePoint {
  sourceEntityId: number;
  axialMm: number;
  radiusMm: number;
}

export interface XtTorusProfile {
  sourceEntityId: number;
  axialCenterMm: number;
  majorRadiusMm: number;
  minorRadiusMm: number;
}

export interface XtRevolvedSubset {
  schema: string;
  application?: string;
  header: XtHeaderMetadata;
  bodyCount: 1;
  faceCount: number;
  faceEntityIds: number[];
  profile: XtProfilePoint[];
  torusProfiles: XtTorusProfile[];
  sourceUnits: "meter";
  outputUnits: "millimeter";
  limitations: string[];
}

export class UnsupportedXtTextSubsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedXtTextSubsetError";
  }
}

/**
 * 只解析已经用真实样本签署的 V24.1 共轴旋转体子集。
 * 这里不尝试跳过未知 B-Rep；任何版本、拓扑或曲面签名不匹配都会拒绝。
 */
export function parseXtRevolvedSubset(source: Uint8Array): XtRevolvedSubset {
  if (source.byteLength === 0 || source.byteLength > XT_TEXT_SUBSET_MAX_BYTES) {
    throw new UnsupportedXtTextSubsetError(`X_T 文本大小必须在 1 到 ${XT_TEXT_SUBSET_MAX_BYTES} 字节之间`);
  }
  const probe = probeXtStructure({
    fileSize: source.byteLength,
    sampleBytes: source.subarray(0, XT_MAX_SAMPLE_BYTES),
    expectedFormat: "x_t",
  });
  if (probe.status !== "header-recognized" || probe.encoding !== "text" || probe.issues.length > 0) {
    throw new UnsupportedXtTextSubsetError(`X_T 文本头不可用：${probe.issues[0]?.message ?? "未识别文本传输流"}`);
  }
  if (probe.version?.raw !== XT_REVOLVED_SUBSET_SCHEMA) {
    throw new UnsupportedXtTextSubsetError(`自研转换器仅支持 ${XT_REVOLVED_SUBSET_SCHEMA}，当前为 ${probe.version?.raw ?? "未知 schema"}`);
  }

  const text = new TextDecoder("latin1").decode(source);
  assertAsciiTransmit(text);
  const compact = text.replace(/[\r\n]/g, "");
  if (!compact.includes("T51 : TRANSMIT FILE") || !compact.includes("Z1 ")) {
    throw new UnsupportedXtTextSubsetError("X_T 缺少 V24.1 文本实体流标记");
  }

  const circles = parseCircles(compact);
  const faceIds = parseFaceIds(compact);
  const torusProfiles = parseTori(compact);
  if (circles.length !== 10 || faceIds.length !== 10 || torusProfiles.length !== 1) {
    throw new UnsupportedXtTextSubsetError(
      `当前文件不属于已签署的单体旋转件拓扑：圆边 ${circles.length}、面 ${faceIds.length}、圆环面 ${torusProfiles.length}`,
    );
  }
  if (new Set(faceIds).size !== faceIds.length || new Set(circles.map((item) => item.sourceEntityId)).size !== circles.length) {
    throw new UnsupportedXtTextSubsetError("X_T 实体索引重复，已拒绝损坏或歧义拓扑");
  }

  const profile = orderClosedProfile(circles);
  if (profile.length !== faceIds.length) {
    throw new UnsupportedXtTextSubsetError("旋转轮廓与 face 数不一致，不能安全生成封闭网格");
  }
  assertSimpleClosedProfile(profile);
  assertTorusConnectsProfile(torusProfiles[0]!, profile);
  return {
    schema: XT_REVOLVED_SUBSET_SCHEMA,
    ...(probe.header?.application ? { application: probe.header.application } : {}),
    header: probe.header ?? {},
    bodyCount: 1,
    faceCount: faceIds.length,
    faceEntityIds: faceIds,
    profile,
    torusProfiles,
    sourceUnits: "meter",
    outputUnits: "millimeter",
    limitations: [
      "仅支持一个真实样本签署的单 body 共轴封闭旋转体拓扑",
      "仅支持圆、平面、圆柱、圆锥和单个圆环过渡面",
      "不解码 shell、装配、实体名称、实体颜色或属性绑定",
      "不支持多 body、NURBS、trim、自由曲面、PMI、属性 schema 或 X_B",
    ],
  };
}

function parseCircles(text: string): XtProfilePoint[] {
  const pattern = recordPattern(31, 10);
  const result: XtProfilePoint[] = [];
  for (const match of text.matchAll(pattern)) {
    const values = match.slice(2).map(Number);
    const center = values.slice(0, 3);
    const normal = values.slice(3, 6);
    const reference = values.slice(6, 9);
    const radius = values[9]!;
    if (!orthonormal(normal, reference) || radius <= 0 || offAxisLength(center, normal) > 1e-7) continue;
    result.push({
      sourceEntityId: Number(match[1]),
      // 反向 curve basis 会给出负的轴向有向距离；旋转轮廓只使用到原点的轴向距离。
      axialMm: Math.abs(dot(center, canonicalAxis(normal))) * MILLIMETERS_PER_SOURCE_UNIT,
      radiusMm: radius * MILLIMETERS_PER_SOURCE_UNIT,
    });
  }
  return deduplicateProfile(result);
}

function parseTori(text: string): XtTorusProfile[] {
  const pattern = recordPattern(54, 11);
  const result: XtTorusProfile[] = [];
  for (const match of text.matchAll(pattern)) {
    const values = match.slice(2).map(Number);
    const center = values.slice(0, 3);
    const axis = values.slice(3, 6);
    const majorRadius = values[6]!;
    const minorRadius = values[7]!;
    const reference = values.slice(8, 11);
    if (!orthonormal(axis, reference) || majorRadius <= 0 || minorRadius <= 0 || offAxisLength(center, axis) > 1e-7) continue;
    result.push({
      sourceEntityId: Number(match[1]),
      axialCenterMm: Math.abs(dot(center, canonicalAxis(axis))) * MILLIMETERS_PER_SOURCE_UNIT,
      majorRadiusMm: majorRadius * MILLIMETERS_PER_SOURCE_UNIT,
      minorRadiusMm: minorRadius * MILLIMETERS_PER_SOURCE_UNIT,
    });
  }
  return result;
}

function parseFaceIds(text: string): number[] {
  const pattern = /(?=(?:^|\s)14(?:\s+255)?\s+(\d+)\s+\d+\s+\d+\s+\?\d+\s+\d+\s+\d+\s+5\s+\d+\s+[+-]0\s+0)/g;
  return [...text.matchAll(pattern)].map((match) => Number(match[1]));
}

function recordPattern(typeId: number, valueCount: number): RegExp {
  const values = Array.from({ length: valueCount }, () => `\\s+(${NUMBER})`).join("");
  return new RegExp(`(?=(?:^|\\s)${typeId}(?:\\s+255)?\\s+(\\d+)${METADATA_FIELDS}${values})`, "g");
}

function orderClosedProfile(points: XtProfilePoint[]): XtProfilePoint[] {
  const xMin = Math.min(...points.map((item) => item.axialMm));
  const xMax = Math.max(...points.map((item) => item.axialMm));
  const atMin = points.filter((item) => near(item.axialMm, xMin)).sort(byRadius);
  const atMax = points.filter((item) => near(item.axialMm, xMax)).sort(byRadius);
  if (atMin.length !== 2 || atMax.length !== 2 || xMax - xMin < 1e-3) {
    throw new UnsupportedXtTextSubsetError("旋转体必须在轴向两端各有一个内外圆环");
  }
  const innerCeiling = Math.max(atMin[0]!.radiusMm, atMax[0]!.radiusMm) + 1e-5;
  const inner = points.filter((item) => item.radiusMm <= innerCeiling).sort(byAxialThenRadius);
  const outer = points.filter((item) => item.radiusMm > innerCeiling).sort((a, b) => byAxialThenRadius(b, a));
  if (
    inner.length < 2
    || outer.length < 2
    || !near(inner[0]!.axialMm, xMin)
    || !near(inner.at(-1)!.axialMm, xMax)
    || !near(outer[0]!.axialMm, xMax)
    || !near(outer.at(-1)!.axialMm, xMin)
  ) {
    throw new UnsupportedXtTextSubsetError("无法把圆边稳定划分为内外旋转轮廓");
  }
  return [...inner, ...outer];
}

function assertSimpleClosedProfile(profile: XtProfilePoint[]): void {
  const signedArea = profile.reduce((area, point, index) => {
    const next = profile[(index + 1) % profile.length]!;
    return area + point.axialMm * next.radiusMm - next.axialMm * point.radiusMm;
  }, 0) / 2;
  if (!Number.isFinite(signedArea) || Math.abs(signedArea) < 1e-3) {
    throw new UnsupportedXtTextSubsetError("旋转轮廓退化，不能生成实体表面");
  }
  for (let first = 0; first < profile.length; first += 1) {
    for (let second = first + 1; second < profile.length; second += 1) {
      if (second === first + 1 || (first === 0 && second === profile.length - 1)) continue;
      const a = profile[first]!;
      const b = profile[(first + 1) % profile.length]!;
      const c = profile[second]!;
      const d = profile[(second + 1) % profile.length]!;
      if (segmentsCross(a, b, c, d)) {
        throw new UnsupportedXtTextSubsetError("旋转轮廓自相交，已拒绝歧义几何");
      }
    }
  }
}

function segmentsCross(a: XtProfilePoint, b: XtProfilePoint, c: XtProfilePoint, d: XtProfilePoint): boolean {
  const orientation = (p: XtProfilePoint, q: XtProfilePoint, r: XtProfilePoint) =>
    (q.axialMm - p.axialMm) * (r.radiusMm - p.radiusMm)
    - (q.radiusMm - p.radiusMm) * (r.axialMm - p.axialMm);
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  return first * second < -1e-8 && third * fourth < -1e-8;
}

function assertTorusConnectsProfile(torus: XtTorusProfile, profile: XtProfilePoint[]): void {
  const onTorus = profile.filter((point) => {
    const dx = point.axialMm - torus.axialCenterMm;
    const dr = point.radiusMm - torus.majorRadiusMm;
    return Math.abs(Math.hypot(dx, dr) - torus.minorRadiusMm) < 0.02;
  });
  if (onTorus.length !== 2 || !adjacent(profile, onTorus[0]!, onTorus[1]!)) {
    throw new UnsupportedXtTextSubsetError("圆环过渡面不能唯一连接相邻轮廓边");
  }
}

function deduplicateProfile(points: XtProfilePoint[]): XtProfilePoint[] {
  const seen = new Set<string>();
  return points.filter((item) => {
    const key = `${item.axialMm.toFixed(7)}:${item.radiusMm.toFixed(7)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertAsciiTransmit(text: string): void {
  if ([...text].some((character) => !"\r\n\t".includes(character) && (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) > 0x7e))) {
    throw new UnsupportedXtTextSubsetError("X_T 文本包含非 ASCII 传输字符");
  }
}

function canonicalAxis(vector: number[]): number[] {
  const axis = normalize(vector);
  const dominant = axis.reduce((best, value, index) => Math.abs(value) > Math.abs(axis[best]!) ? index : best, 0);
  return axis[dominant]! < 0 ? axis.map((value) => -value) : axis;
}

function orthonormal(a: number[], b: number[]): boolean {
  return Math.abs(length(a) - 1) < 1e-6 && Math.abs(length(b) - 1) < 1e-6 && Math.abs(dot(a, b)) < 1e-6;
}

function offAxisLength(point: number[], axis: number[]): number {
  const unit = normalize(axis);
  const projection = dot(point, unit);
  return Math.hypot(...point.map((value, index) => value - projection * unit[index]!));
}

function normalize(vector: number[]): number[] {
  const magnitude = length(vector);
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index]!, 0);
}

function length(vector: number[]): number { return Math.hypot(...vector); }
function near(a: number, b: number): boolean { return Math.abs(a - b) < 1e-4; }
function byRadius(a: XtProfilePoint, b: XtProfilePoint): number { return a.radiusMm - b.radiusMm; }
function byAxialThenRadius(a: XtProfilePoint, b: XtProfilePoint): number { return a.axialMm - b.axialMm || a.radiusMm - b.radiusMm; }
function adjacent(profile: XtProfilePoint[], a: XtProfilePoint, b: XtProfilePoint): boolean {
  const first = profile.indexOf(a);
  const second = profile.indexOf(b);
  return Math.abs(first - second) === 1 || Math.abs(first - second) === profile.length - 1;
}
