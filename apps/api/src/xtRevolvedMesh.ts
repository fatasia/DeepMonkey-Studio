import type { XtProfilePoint, XtRevolvedSubset, XtTorusProfile } from "./xtTextSubsetParser.js";

const ANGULAR_SEGMENTS = 64;
const TORUS_SEGMENTS_PER_RADIAN = 16;
const TORUS_TOLERANCE_MM = 0.02;

export interface XtFaceMesh {
  id: string;
  sourceEntityIds: [number, number];
  surfaceType: "plane" | "cylinder" | "cone" | "torus";
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
}

export interface XtRevolvedMeshResult {
  faces: XtFaceMesh[];
  triangleCount: number;
  vertexCount: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

interface ProfileSample {
  axialMm: number;
  radiusMm: number;
}

/**
 * 将已验证的封闭母线绕 X 轴离散化。每个母线段独立成面，便于浏览器选择和读取元数据。
 */
export function buildXtRevolvedMesh(subset: XtRevolvedSubset): XtRevolvedMeshResult {
  const faces = subset.profile.map((start, index) => {
    const end = subset.profile[(index + 1) % subset.profile.length]!;
    const torus = subset.torusProfiles.find((item) => liesOnTorus(start, item) && liesOnTorus(end, item));
    const samples = torus ? sampleTorusArc(start, end, torus) : [toSample(start), toSample(end)];
    return buildFace(index, start, end, samples, torus !== undefined);
  });
  const bounds = boundsOf(faces);
  return {
    faces,
    triangleCount: faces.reduce((total, face) => total + face.triangleCount, 0),
    vertexCount: faces.reduce((total, face) => total + face.positions.length / 3, 0),
    bounds,
  };
}

function buildFace(
  index: number,
  start: XtProfilePoint,
  end: XtProfilePoint,
  samples: ProfileSample[],
  isTorus: boolean,
): XtFaceMesh {
  const ringSize = ANGULAR_SEGMENTS + 1;
  const positions = new Float32Array(samples.length * ringSize * 3);
  const normals = new Float32Array(positions.length);
  const indices = new Uint32Array((samples.length - 1) * ANGULAR_SEGMENTS * 6);

  samples.forEach((sample, sampleIndex) => {
    const tangent = profileTangent(samples, sampleIndex);
    for (let angleIndex = 0; angleIndex <= ANGULAR_SEGMENTS; angleIndex += 1) {
      const angle = angleIndex / ANGULAR_SEGMENTS * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const offset = (sampleIndex * ringSize + angleIndex) * 3;
      positions.set([sample.axialMm, sample.radiusMm * cos, sample.radiusMm * sin], offset);
      const normal = normalize3(tangent.radius, -tangent.axial * cos, -tangent.axial * sin);
      normals.set(normal, offset);
    }
  });

  let indexOffset = 0;
  for (let sampleIndex = 0; sampleIndex < samples.length - 1; sampleIndex += 1) {
    for (let angleIndex = 0; angleIndex < ANGULAR_SEGMENTS; angleIndex += 1) {
      const a = sampleIndex * ringSize + angleIndex;
      const b = a + ringSize;
      indices.set([a, b, a + 1, a + 1, b, b + 1], indexOffset);
      indexOffset += 6;
    }
  }

  return {
    id: `x_t-face:${index + 1}`,
    sourceEntityIds: [start.sourceEntityId, end.sourceEntityId],
    surfaceType: surfaceType(start, end, isTorus),
    positions,
    normals,
    indices,
    triangleCount: indices.length / 3,
  };
}

function sampleTorusArc(start: XtProfilePoint, end: XtProfilePoint, torus: XtTorusProfile): ProfileSample[] {
  const startAngle = Math.atan2(start.radiusMm - torus.majorRadiusMm, start.axialMm - torus.axialCenterMm);
  const endAngle = Math.atan2(end.radiusMm - torus.majorRadiusMm, end.axialMm - torus.axialCenterMm);
  const delta = shortestAngle(endAngle - startAngle);
  const segments = Math.max(2, Math.ceil(Math.abs(delta) * TORUS_SEGMENTS_PER_RADIAN));
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = startAngle + delta * index / segments;
    return {
      axialMm: torus.axialCenterMm + Math.cos(angle) * torus.minorRadiusMm,
      radiusMm: torus.majorRadiusMm + Math.sin(angle) * torus.minorRadiusMm,
    };
  });
}

function profileTangent(samples: ProfileSample[], index: number): { axial: number; radius: number } {
  const previous = samples[Math.max(0, index - 1)]!;
  const next = samples[Math.min(samples.length - 1, index + 1)]!;
  return { axial: next.axialMm - previous.axialMm, radius: next.radiusMm - previous.radiusMm };
}

function surfaceType(start: XtProfilePoint, end: XtProfilePoint, isTorus: boolean): XtFaceMesh["surfaceType"] {
  if (isTorus) return "torus";
  if (near(start.axialMm, end.axialMm)) return "plane";
  if (near(start.radiusMm, end.radiusMm)) return "cylinder";
  return "cone";
}

function liesOnTorus(point: XtProfilePoint, torus: XtTorusProfile): boolean {
  return Math.abs(Math.hypot(
    point.axialMm - torus.axialCenterMm,
    point.radiusMm - torus.majorRadiusMm,
  ) - torus.minorRadiusMm) < TORUS_TOLERANCE_MM;
}

function boundsOf(faces: XtFaceMesh[]): XtRevolvedMeshResult["bounds"] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const face of faces) {
    for (let index = 0; index < face.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis]!, face.positions[index + axis]!);
        max[axis] = Math.max(max[axis]!, face.positions[index + axis]!);
      }
    }
  }
  return { min, max };
}

function toSample(point: XtProfilePoint): ProfileSample {
  return { axialMm: point.axialMm, radiusMm: point.radiusMm };
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z);
  if (length < Number.EPSILON) throw new Error("X_T 旋转面存在退化切线");
  return [x / length, y / length, z / length];
}

function shortestAngle(value: number): number {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-5;
}
