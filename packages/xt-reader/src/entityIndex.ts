import { readXtTextSegments, type XtSegmentHeader } from "./segments.js";
import {
  AXIAL_OFFSETS,
  isRecordAnchor,
  parseCircleRecord,
  parseConeRecord,
  parseCylinderRecord,
  parsePlaneRecord,
  parseSphereRecord,
  parseTorusRecord,
  parseTransformRecord,
  SPHERE_OFFSETS,
  XT_CLASS,
  type XtCircleCurve,
  type XtConeSurface,
  type XtCylinderSurface,
  type XtPlaneSurface,
  type XtSphereSurface,
  type XtTorusSurface,
  type XtTransformRecord,
} from "./surfaces.js";import { isIntegerToken, tokenizePayload } from "./tokens.js";

/**
 * 通用 X_T 文本实体索引。分段与 schema 只记录不拒绝；实体记录按类逐一做几何校验，
 * 校验不过的记入锚点统计而不是几何结果——宁可少报，不猜布局。
 */
export interface XtGenericDocument {
  header: XtSegmentHeader;
  tokenCount: number;
  circles: XtCircleCurve[];
  planes: XtPlaneSurface[];
  cylinders: XtCylinderSurface[];
  cones: XtConeSurface[];
  spheres: XtSphereSurface[];
  tori: XtTorusSurface[];
  transforms: XtTransformRecord[];
  /** 尽力而为的记录头候选计数（可能含误报），只用于回归矩阵观察，不作为能力证据。 */
  census: Record<string, number>;
}

export function parseXtTextDocument(source: Uint8Array, maxBytes?: number): XtGenericDocument {
  const segments = readXtTextSegments(source, maxBytes);
  const tokens = tokenizePayload(segments.text.slice(segments.header.payloadTokenOffset));
  const document: XtGenericDocument = {
    header: segments.header,
    tokenCount: tokens.length,
    circles: [],
    planes: [],
    cylinders: [],
    cones: [],
    spheres: [],
    tori: [],
    transforms: [],
    census: {},
  };
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    censusAnchor(document.census, tokens, index);
    if (segments.header.encodingClass !== "format-text") continue;
    dispatchRecord(document, tokens, index);
  }
  return document;
}

function dispatchRecord(document: XtGenericDocument, tokens: readonly string[], index: number): void {
  const classToken = tokens[index]!;
  switch (classToken) {
    case String(XT_CLASS.circle): {
      const entityId = isRecordAnchor(tokens, index, XT_CLASS.circle);
      if (entityId === undefined) return;
      const existing = document.circles.some((circle) => circle.entityId === entityId);
      if (!existing) for (const offset of AXIAL_OFFSETS) {
        const circle = parseCircleRecord(tokens, index + 2 + offset, entityId);
        if (circle) { document.circles.push(circle); return; }
      }
      return;
    }
    case String(XT_CLASS.torus): {
      const entityId = isRecordAnchor(tokens, index, XT_CLASS.torus);
      if (entityId === undefined) return;
      if (document.tori.some((torus) => torus.entityId === entityId)) return;
      for (const offset of AXIAL_OFFSETS) {
        const torus = parseTorusRecord(tokens, index + 2 + offset, entityId);
        if (torus) { document.tori.push(torus); return; }
      }
      return;
    }
    case String(XT_CLASS.plane):
    case String(XT_CLASS.cylinder):
    case String(XT_CLASS.cone):
    case String(XT_CLASS.sphere):
      dispatchSurface(document, tokens, index, Number(classToken));
      return;
    case String(XT_CLASS.transform): {
      const entityId = isRecordAnchor(tokens, index, XT_CLASS.transform);
      if (entityId === undefined) return;
      if (document.transforms.some((transform) => transform.entityId === entityId)) return;
      const ownerToken = tokens[index + 3];
      const ownerEntityId = ownerToken !== undefined && isIntegerToken(ownerToken) ? Math.abs(Number(ownerToken)) : 0;
      for (const offset of [2, 1, 0, 3, 4]) {
        const transform = parseTransformRecord(tokens, index + 2 + offset, entityId, ownerEntityId);
        if (transform) { document.transforms.push(transform); return; }
      }
      return;
    }
    default:
      return;
  }
}

function dispatchSurface(document: XtGenericDocument, tokens: readonly string[], index: number, classNumber: number): void {
  const entityId = isRecordAnchor(tokens, index, classNumber);
  if (entityId === undefined) return;
  const offsets = classNumber === XT_CLASS.sphere ? SPHERE_OFFSETS : AXIAL_OFFSETS;
  for (const offset of offsets) {
    const payloadAt = index + 2 + offset;
    if (classNumber === XT_CLASS.plane) {
      if (document.planes.some((plane) => plane.entityId === entityId)) return;
      const plane = parsePlaneRecord(tokens, payloadAt, entityId);
      if (plane) { document.planes.push(plane); return; }
    } else if (classNumber === XT_CLASS.cylinder) {
      if (document.cylinders.some((cylinder) => cylinder.entityId === entityId)) return;
      const cylinder = parseCylinderRecord(tokens, payloadAt, entityId);
      if (cylinder) { document.cylinders.push(cylinder); return; }
    } else if (classNumber === XT_CLASS.cone) {
      if (document.cones.some((cone) => cone.entityId === entityId)) return;
      const cone = parseConeRecord(tokens, payloadAt, entityId);
      if (cone) { document.cones.push(cone); return; }
    } else if (classNumber === XT_CLASS.sphere) {
      if (document.spheres.some((sphere) => sphere.entityId === entityId)) return;
      const sphere = parseSphereRecord(tokens, payloadAt, entityId);
      if (sphere) { document.spheres.push(sphere); return; }
    }
  }
}

function censusAnchor(census: Record<string, number>, tokens: readonly string[], index: number): void {
  const classToken = tokens[index]!;
  if (!isIntegerToken(classToken)) return;
  const classNumber = Number(classToken);
  if (classNumber < 0 || classNumber > 400) return;
  const attrToken = tokens[index + 1]!;
  const idToken = tokens[index + 2]!;
  if (!isIntegerToken(attrToken) || !isIntegerToken(idToken)) return;
  const id = Number(idToken);
  if (id < 1 || id > 1e7) return;
  census[classToken] = (census[classToken] ?? 0) + 1;
}
