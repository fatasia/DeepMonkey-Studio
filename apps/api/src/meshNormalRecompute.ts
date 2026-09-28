import {
  aabbDiagonal,
  angleAtCorner,
  countNonFinite,
  positionRemap,
  triangleCross,
} from "./meshProcessingShared.js";

/**
 * T12 几何处理切片之法线重算:角度/面积加权可选,平滑簇按
 * 「同位置且同源法线」从现有顶点/索引结构推断(保硬边),
 * 输出与源法线的最大/平均偏差;只产出数据,不写回 GLB,不静默替换原始精度。
 */

export type NormalWeighting = "area" | "angle";

export interface NormalRecomputeOptions {
  /** 面积加权(cross 求和,默认)或角加权(角 × 单位法线)。 */
  weighting?: NormalWeighting;
  /** 源法线聚簇量化步长;默认 1e-4(约 0.006°,远小于任何真实硬边角差)。 */
  smoothNormalQuantum?: number;
}

export interface NormalRecomputeInput {
  primitiveId: string;
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** 存档法线;存在时参与平滑簇推断并用于偏差统计。 */
  normals?: ArrayLike<number> | undefined;
}

export interface NormalRecomputeResult {
  primitiveId: string;
  vertexCount: number;
  triangleCount: number;
  validTriangleCount: number;
  /** 重算后的法线,长度 = vertexCount * 3;确定性输出。 */
  normals: Float32Array;
  hadSourceNormals: boolean;
  /** 推断出的平滑簇数量;簇内法线一致,簇间(硬边)互不混叠。 */
  smoothClusters: number;
  /** 与源法线最大夹角(度);无源法线时为 null。 */
  maxDeviationDegrees: number | null;
  meanDeviationDegrees: number | null;
  /** 仅邻接退化三角形、无法归一化的顶点数。 */
  degenerateOnlyVertices: number;
  /** 源法线长度为 0 被忽略的顶点数。 */
  invalidSourceNormals: number;
}

/** 重算法线。输入畸形时显式抛错(调用方契约是已通过拓扑检查的几何)。 */
export async function recomputeVertexNormals(
  input: NormalRecomputeInput,
  options: NormalRecomputeOptions = {},
): Promise<NormalRecomputeResult> {
  const weighting = options.weighting ?? "area";
  const quantum = options.smoothNormalQuantum ?? 1e-4;
  const primitiveId = input.primitiveId;
  if (input.positions.length % 3 !== 0) throw new Error(`[${primitiveId}] POSITION 长度不是 3 的倍数`);
  if (countNonFinite(input.positions) > 0) throw new Error(`[${primitiveId}] POSITION 含非有限坐标`);
  if (input.indices.length % 3 !== 0) throw new Error(`[${primitiveId}] 索引长度不是 3 的倍数`);
  const vertexCount = input.positions.length / 3;
  const triangleCount = input.indices.length / 3;
  const normalsOut = new Float32Array(vertexCount * 3);
  if (triangleCount === 0) {
    return baseResult(input, normalsOut, { hadSourceNormals: false, smoothClusters: 0 });
  }

  const remap = await positionRemap(toFloat32(input.positions));
  const sourceNormals = input.normals;
  const hadSourceNormals = sourceNormals !== undefined && sourceNormals.length === input.positions.length;

  // 平滑簇:同位置(canonical)且同源法线(量化键)归一簇;无源法线时仅按位置。
  const clusterKeyToIndex = new Map<string, number>();
  const vertexCluster = new Int32Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const key = clusterKey(input.positions, sourceNormals, remap, vertex, hadSourceNormals, quantum);
    let cluster = clusterKeyToIndex.get(key);
    if (cluster === undefined) {
      cluster = clusterKeyToIndex.size;
      clusterKeyToIndex.set(key, cluster);
    }
    vertexCluster[vertex] = cluster;
  }
  const clusterCount = clusterKeyToIndex.size;
  const accumulators = new Float64Array(clusterCount * 3);

  const areaEpsilon = (aabbDiagonal(input.positions) * 1e-7) ** 2;
  let validTriangleCount = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const a = input.indices[triangle * 3]!, b = input.indices[triangle * 3 + 1]!, c = input.indices[triangle * 3 + 2]!;
    if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)
      || a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    const cross = triangleCross(input.positions, a, b, c);
    const crossLengthSq = cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2];
    if (crossLengthSq <= areaEpsilon) continue;
    validTriangleCount += 1;
    const crossLength = Math.sqrt(crossLengthSq);
    const unit: [number, number, number] = [cross[0] / crossLength, cross[1] / crossLength, cross[2] / crossLength];
    const corners = [a, b, c] as const;
    for (let corner = 0; corner < 3; corner += 1) {
      const cornerVertex = corners[corner]!;
      const nextVertex = corners[(corner + 1) % 3]!;
      const previousVertex = corners[(corner + 2) % 3]!;
      const weight = weighting === "area"
        ? 1
        : angleAtCorner(input.positions, cornerVertex, nextVertex, previousVertex);
      const cluster = vertexCluster[cornerVertex]! * 3;
      accumulators[cluster] = accumulators[cluster]! + unit[0] * weight;
      accumulators[cluster + 1] = accumulators[cluster + 1]! + unit[1] * weight;
      accumulators[cluster + 2] = accumulators[cluster + 2]! + unit[2] * weight;
    }
  }

  let degenerateOnlyVertices = 0;
  let invalidSourceNormals = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const cluster = vertexCluster[vertex]! * 3;
    const length = Math.hypot(accumulators[cluster]!, accumulators[cluster + 1]!, accumulators[cluster + 2]!);
    const outOffset = vertex * 3;
    if (length > 0) {
      normalsOut[outOffset] = accumulators[cluster]! / length;
      normalsOut[outOffset + 1] = accumulators[cluster + 1]! / length;
      normalsOut[outOffset + 2] = accumulators[cluster + 2]! / length;
      continue;
    }
    const sourceOffset = outOffset;
    const sourceLength = hadSourceNormals
      ? Math.hypot(sourceNormals![sourceOffset]!, sourceNormals![sourceOffset + 1]!, sourceNormals![sourceOffset + 2]!)
      : 0;
    if (hadSourceNormals && sourceLength === 0) invalidSourceNormals += 1;
    if (hadSourceNormals && sourceLength > 0) {
      normalsOut[outOffset] = sourceNormals![sourceOffset]! / sourceLength;
      normalsOut[outOffset + 1] = sourceNormals![sourceOffset + 1]! / sourceLength;
      normalsOut[outOffset + 2] = sourceNormals![sourceOffset + 2]! / sourceLength;
    } else {
      degenerateOnlyVertices += 1;
    }
  }

  const deviations = hadSourceNormals
    ? collectDeviations(input, sourceNormals!, normalsOut)
    : null;
  return {
    ...baseResult(input, normalsOut, {
      hadSourceNormals,
      smoothClusters: clusterCount,
      validTriangleCount,
      degenerateOnlyVertices,
      invalidSourceNormals,
    }),
    maxDeviationDegrees: deviations?.max ?? null,
    meanDeviationDegrees: deviations?.mean ?? null,
  };
}

function clusterKey(
  positions: ArrayLike<number>,
  sourceNormals: ArrayLike<number> | undefined,
  remap: Uint32Array,
  vertex: number,
  hadSourceNormals: boolean,
  quantum: number,
): string {
  const canonical = remap[vertex]!;
  if (!hadSourceNormals) return `p${canonical}`;
  const offset = vertex * 3;
  const qx = Math.round(sourceNormals![offset]! / quantum);
  const qy = Math.round(sourceNormals![offset + 1]! / quantum);
  const qz = Math.round(sourceNormals![offset + 2]! / quantum);
  return `p${canonical}n${qx}_${qy}_${qz}`;
}

function collectDeviations(
  input: NormalRecomputeInput,
  sourceNormals: ArrayLike<number>,
  recomputed: Float32Array,
): { max: number; mean: number } {
  const vertexCount = input.positions.length / 3;
  let maxDeviation = 0;
  let sumDeviation = 0;
  let counted = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3;
    const sourceLength = Math.hypot(sourceNormals[offset]!, sourceNormals[offset + 1]!, sourceNormals[offset + 2]!);
    if (sourceLength === 0) continue;
    const dot = sourceNormals[offset]! / sourceLength * recomputed[offset]!
      + sourceNormals[offset + 1]! / sourceLength * recomputed[offset + 1]!
      + sourceNormals[offset + 2]! / sourceLength * recomputed[offset + 2]!;
    const radians = Math.acos(Math.min(1, Math.max(-1, dot)));
    const degrees = radians * (180 / Math.PI);
    if (degrees > maxDeviation) maxDeviation = degrees;
    sumDeviation += degrees;
    counted += 1;
  }
  if (counted === 0) return { max: 0, mean: 0 };
  return { max: maxDeviation, mean: sumDeviation / counted };
}

function baseResult(
  input: NormalRecomputeInput,
  normals: Float32Array,
  fields: {
    hadSourceNormals: boolean;
    smoothClusters: number;
    validTriangleCount?: number;
    degenerateOnlyVertices?: number;
    invalidSourceNormals?: number;
  },
): NormalRecomputeResult {
  return {
    primitiveId: input.primitiveId,
    vertexCount: normals.length / 3,
    triangleCount: input.indices.length / 3,
    validTriangleCount: fields.validTriangleCount ?? 0,
    normals,
    hadSourceNormals: fields.hadSourceNormals,
    smoothClusters: fields.smoothClusters,
    maxDeviationDegrees: null,
    meanDeviationDegrees: null,
    degenerateOnlyVertices: fields.degenerateOnlyVertices ?? 0,
    invalidSourceNormals: fields.invalidSourceNormals ?? 0,
  };
}

function toFloat32(values: ArrayLike<number>): Float32Array {
  return values instanceof Float32Array ? values : Float32Array.from(values);
}
