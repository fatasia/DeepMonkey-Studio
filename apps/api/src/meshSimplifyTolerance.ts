import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";
import {
  aabbDiagonal,
  canonicalTriangleKey,
  countNonFinite,
  decodeScalarIndices,
  decodeVec3Attribute,
  pointTriangleDistanceSquared,
  positionRemap,
} from "./meshProcessingShared.js";

/**
 * T12 几何处理切片之网格简化:基于 meshoptimizer,误差公差受输入约束——
 * 给定绝对公差 → 实际误差(绝对值)≤ 公差,否则显式标记 tolerance-violated,
 * 绝不静默把超差结果当作合格几何。输出面映射:幸存输出三角形可追溯源面 id
 * (外部 sourceFaceIds 或序号);因边折叠派生的新三角形如实计入 unmapped。
 * 本模块只产出派生几何数据与报告,不写回原文件、不冒充原始精度。
 */

export interface SimplifiablePrimitive {
  primitiveId: string;
  positions: Float32Array | ArrayLike<number>;
  indices: Uint32Array | ArrayLike<number>;
  /** 每个源三角形的外部面 id(如 CAD face id);缺省用三角形序号。 */
  sourceFaceIds?: ArrayLike<number> | undefined;
}

export interface SimplifyToleranceRequest {
  /** 绝对公差(网格单位),必须 > 0。 */
  tolerance: number;
  /** 目标三角形保留比例 (0,1];缺省 = 在公差内尽量简化。 */
  targetTriangleRatio?: number | undefined;
  /** 锁定边界边(开放壳网格建议开启);默认 false。 */
  lockBorder?: boolean | undefined;
  /** 返回幸存面映射明细;默认 true,明细上限见 faceMappingLimit。 */
  keepFaceMapping?: boolean | undefined;
  /** 明细条目上限,默认 64;计数不受影响。 */
  faceMappingLimit?: number | undefined;
}

export type SimplifyToleranceStatus =
  | "ok"
  | "tolerance-violated"
  | "rejected"
  | "failed";

export interface SimplifyToleranceResult {
  primitiveId: string;
  status: SimplifyToleranceStatus;
  reason?: string;
  inputTriangleCount: number;
  outputTriangleCount: number;
  vertexCount: number;
  meshScale: number;
  tolerance: number;
  targetTriangleRatio: number | null;
  /** meshoptimizer 报告的误差换算到绝对单位;它是顶点位移意义上的界。 */
  simplifierErrorAbsolute: number | null;
  withinTolerance: boolean;
  /** 源三角形质心 → 输出表面最小距离的最大值(有界采样,参考值非保证界)。 */
  measuredMaxCentroidDeviation: number | null;
  measuredSampleCount: number;
  /** 幸存输出三角形 → 源面 id;自然顺序,截断到 faceMappingLimit。 */
  faceMapping: Array<{ sourceFaceId: number; outputTriangle: number }>;
  faceMappingLimit: number;
  mappedOutputTriangles: number;
  unmappedOutputTriangles: number;
  mappedSourceFaceCount: number;
  collapsedSourceFaceCount: number;
  /** 输入中被剔除的退化三角形数(不参与简化)。 */
  strippedDegenerateTriangles: number;
  duplicateSourceFaces: number;
  /** 简化后索引(引用原顶点缓冲);仅在产出结果时存在。 */
  outputIndices?: Uint32Array | undefined;
}

export interface SimplifyToleranceCurvePoint {
  tolerance: number;
  toleranceRatioOfExtent: number;
  inputTriangleCount: number;
  outputTriangleCount: number;
  simplifierErrorAbsolute: number | null;
  measuredMaxCentroidDeviation: number | null;
  withinTolerance: boolean;
  status: SimplifyToleranceStatus;
}

const CENTROID_SAMPLE_LIMIT = 256;
/** 质心×输出三角距离求值次数上限,超限按比例收缩质心采样。 */
const DISTANCE_EVALUATION_LIMIT = 4_000_000;

/** 公差约束的确定性网格简化(核心,数组入参)。 */
export async function simplifyPrimitiveWithTolerance(
  primitive: SimplifiablePrimitive,
  request: SimplifyToleranceRequest,
): Promise<SimplifyToleranceResult> {
  const primitiveId = primitive.primitiveId;
  const rejected = (reason: string): SimplifyToleranceResult =>
    emptyResult(primitive, request, { status: "rejected", reason });
  if (!Number.isFinite(request.tolerance) || request.tolerance <= 0) {
    return rejected(`tolerance 必须为正的有限数,收到 ${request.tolerance}`);
  }
  if (request.targetTriangleRatio !== undefined
    && (!Number.isFinite(request.targetTriangleRatio) || request.targetTriangleRatio <= 0 || request.targetTriangleRatio > 1)) {
    return rejected(`targetTriangleRatio 必须在 (0,1],收到 ${request.targetTriangleRatio}`);
  }
  const positions = primitive.positions instanceof Float32Array
    ? primitive.positions
    : Float32Array.from(primitive.positions);
  const rawIndices = primitive.indices instanceof Uint32Array
    ? primitive.indices
    : Uint32Array.from(primitive.indices);
  if (positions.length % 3 !== 0) return rejected("POSITION 长度不是 3 的倍数");
  if (rawIndices.length % 3 !== 0) return rejected("索引长度不是 3 的倍数");
  if (countNonFinite(positions) > 0) return rejected("POSITION 含非有限坐标");
  const inputTriangleCount = rawIndices.length / 3;
  const vertexCount = positions.length / 3;
  if (inputTriangleCount === 0) {
    return emptyResult(primitive, request, { status: "ok", reason: "空图元,无三角形可简化" });
  }

  try {
    await MeshoptSimplifier.ready;
    const scale = MeshoptSimplifier.getScale(positions, 3);
    if (!(scale > 0)) {
      return emptyResult(primitive, request, { status: "failed", reason: "网格包围盒尺度为 0,公差无意义" });
    }
    const remap = await positionRemap(positions);

    // 预剔除退化三角形(重复索引/重复位置/零面积),meshoptimizer 对这类输入行为不可靠。
    const areaEpsilon = (aabbDiagonal(positions) * 1e-7) ** 2;
    const canonicalIndices: number[] = [];
    let strippedDegenerateTriangles = 0;
    for (let triangle = 0; triangle < inputTriangleCount; triangle += 1) {
      const a = rawIndices[triangle * 3]!, b = rawIndices[triangle * 3 + 1]!, c = rawIndices[triangle * 3 + 2]!;
      if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
        return rejected("索引超出顶点范围;请先运行拓扑检查");
      }
      const ca = remap[a]!, cb = remap[b]!, cc = remap[c]!;
      const degenerate = a === b || b === c || a === c || ca === cb || cb === cc || ca === cc
        || isZeroArea(positions, a, b, c, areaEpsilon);
      if (degenerate) strippedDegenerateTriangles += 1;
      else canonicalIndices.push(ca, cb, cc);
    }
    const cleanTriangleCount = canonicalIndices.length / 3;
    if (cleanTriangleCount === 0) {
      return { ...emptyResult(primitive, request, { status: "ok", reason: "全部三角形退化,无有效简化对象" }),
        strippedDegenerateTriangles };
    }

    // meshoptimizer simplify 对「索引最大值远大于实际顶点数」的稀疏编号会静默不简化,
    // 因此先压缩重编号(聚齐顶点),输出时再映射回原顶点缓冲。
    const canonicalToCompact = new Map<number, number>();
    const compactPositions: number[] = [];
    const compactIndices = new Uint32Array(canonicalIndices.length);
    for (let offset = 0; offset < canonicalIndices.length; offset += 1) {
      const canonical = canonicalIndices[offset]!;
      let compact = canonicalToCompact.get(canonical);
      if (compact === undefined) {
        compact = compactPositions.length / 3;
        canonicalToCompact.set(canonical, compact);
        compactPositions.push(positions[canonical * 3]!, positions[canonical * 3 + 1]!, positions[canonical * 3 + 2]!);
      }
      compactIndices[offset] = compact;
    }
    const compactVertexArray = Float32Array.from(compactPositions);
    const compactToCanonical = new Map<number, number>();
    for (const [canonical, compact] of canonicalToCompact) compactToCanonical.set(compact, canonical);

    // 源面键:压缩编号三元组 → 源面 id,供幸存面追溯。
    const faceKeyToId = new Map<string, number>();
    let duplicateSourceFaces = 0;
    for (let triangle = 0; triangle < cleanTriangleCount; triangle += 1) {
      const key = canonicalTriangleKey(
        compactIndices[triangle * 3]!, compactIndices[triangle * 3 + 1]!, compactIndices[triangle * 3 + 2]!);
      const externalId = primitive.sourceFaceIds?.[triangle];
      const faceId = typeof externalId === "number" && Number.isFinite(externalId) ? externalId : triangle;
      if (faceKeyToId.has(key)) duplicateSourceFaces += 1;
      else faceKeyToId.set(key, faceId);
    }

    const targetError = Math.min(1, request.tolerance / scale);
    const ratio = request.targetTriangleRatio;
    const targetIndexCount = ratio === undefined
      ? 3
      : Math.min(compactIndices.length, Math.max(3, Math.ceil(ratio * cleanTriangleCount) * 3));
    const flags = request.lockBorder ? ["LockBorder" as const] : undefined;
    let outputCompactIndices = compactIndices;
    let reportedError = 0;
    if (targetIndexCount < compactIndices.length) {
      const [simplified, error] = MeshoptSimplifier.simplify(
        compactIndices, compactVertexArray, 3, targetIndexCount, targetError, flags);
      // 拷贝脱离 meshopt 内部缓冲,统一为 ArrayBuffer 载体。
      outputCompactIndices = new Uint32Array(simplified);
      reportedError = error;
    }
    // 输出索引映射回原顶点缓冲(压缩 id → 规范 id = 首次出现的原始顶点 id)。
    const outputIndices = new Uint32Array(outputCompactIndices.length);
    for (let offset = 0; offset < outputCompactIndices.length; offset += 1) {
      outputIndices[offset] = compactToCanonical.get(outputCompactIndices[offset]!)!;
    }
    const outputTriangleCount = outputIndices.length / 3;
    const simplifierErrorAbsolute = reportedError * scale;
    const withinTolerance = simplifierErrorAbsolute <= request.tolerance * (1 + 1e-9);

    const deviation = measuredCentroidDeviation(
      compactVertexArray, compactIndices, positions, outputIndices);
    const faceMappingLimit = request.faceMappingLimit ?? 64;
    const faceMapping: Array<{ sourceFaceId: number; outputTriangle: number }> = [];
    let mappedOutputTriangles = 0;
    const mappedSourceFaces = new Set<number>();
    if (request.keepFaceMapping !== false) {
      for (let triangle = 0; triangle < outputTriangleCount; triangle += 1) {
        const key = canonicalTriangleKey(
          outputCompactIndices[triangle * 3]!, outputCompactIndices[triangle * 3 + 1]!, outputCompactIndices[triangle * 3 + 2]!);
        const sourceFaceId = faceKeyToId.get(key);
        if (sourceFaceId === undefined) continue;
        mappedOutputTriangles += 1;
        mappedSourceFaces.add(sourceFaceId);
        if (faceMapping.length < faceMappingLimit) {
          faceMapping.push({ sourceFaceId, outputTriangle: triangle });
        }
      }
    }
    const unmappedOutputTriangles = outputTriangleCount - mappedOutputTriangles;

    const status: SimplifyToleranceStatus = withinTolerance ? "ok" : "tolerance-violated";
    return {
      primitiveId,
      status,
      ...(withinTolerance ? {} : { reason: `实际误差 ${simplifierErrorAbsolute} 超出公差 ${request.tolerance}` }),
      inputTriangleCount,
      outputTriangleCount,
      vertexCount,
      meshScale: scale,
      tolerance: request.tolerance,
      targetTriangleRatio: ratio ?? null,
      simplifierErrorAbsolute,
      withinTolerance,
      measuredMaxCentroidDeviation: deviation.max,
      measuredSampleCount: deviation.samples,
      faceMapping,
      faceMappingLimit,
      mappedOutputTriangles,
      unmappedOutputTriangles,
      mappedSourceFaceCount: mappedSourceFaces.size,
      collapsedSourceFaceCount: faceKeyToId.size - mappedSourceFaces.size,
      strippedDegenerateTriangles,
      duplicateSourceFaces,
      outputIndices,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emptyResult(primitive, request, { status: "failed", reason: `meshoptimizer 简化失败:${message}` });
  }
}

function isZeroArea(
  positions: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
  areaEpsilon: number,
): boolean {
  const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!;
  const ux = positions[b * 3]! - ax, uy = positions[b * 3 + 1]! - ay, uz = positions[b * 3 + 2]! - az;
  const vx = positions[c * 3]! - ax, vy = positions[c * 3 + 1]! - ay, vz = positions[c * 3 + 2]! - az;
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return cx * cx + cy * cy + cz * cz <= areaEpsilon;
}

/** 有界采样:源三角形质心到输出表面的最小距离;数量上限见常量。 */
function measuredCentroidDeviation(
  sourcePositions: Float32Array,
  sourceIndices: Uint32Array,
  outputPositions: Float32Array,
  outputIndices: Uint32Array,
): { max: number | null; samples: number } {
  const sourceTriangleCount = sourceIndices.length / 3;
  const outputTriangleCount = outputIndices.length / 3;
  if (sourceTriangleCount === 0 || outputTriangleCount === 0) return { max: null, samples: 0 };
  let stride = Math.max(1, Math.ceil(sourceTriangleCount / CENTROID_SAMPLE_LIMIT));
  const maxEvaluations = DISTANCE_EVALUATION_LIMIT / Math.max(1, outputTriangleCount);
  while (Math.ceil(sourceTriangleCount / stride) > Math.max(1, maxEvaluations)) stride *= 2;
  const sampleCount = Math.min(sourceTriangleCount, Math.ceil(sourceTriangleCount / stride));
  let maxDistance = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const triangle = Math.min(sourceTriangleCount - 1, sample * stride);
    const a = sourceIndices[triangle * 3]!, b = sourceIndices[triangle * 3 + 1]!, c = sourceIndices[triangle * 3 + 2]!;
    const centroid: [number, number, number] = [
      (sourcePositions[a * 3]! + sourcePositions[b * 3]! + sourcePositions[c * 3]!) / 3,
      (sourcePositions[a * 3 + 1]! + sourcePositions[b * 3 + 1]! + sourcePositions[c * 3 + 1]!) / 3,
      (sourcePositions[a * 3 + 2]! + sourcePositions[b * 3 + 2]! + sourcePositions[c * 3 + 2]!) / 3,
    ];
    let minDistance = Infinity;
    for (let outputTriangle = 0; outputTriangle < outputTriangleCount; outputTriangle += 1) {
      const oa = outputIndices[outputTriangle * 3]!, ob = outputIndices[outputTriangle * 3 + 1]!, oc = outputIndices[outputTriangle * 3 + 2]!;
      const distance = pointTriangleDistanceSquared(
        centroid,
        [outputPositions[oa * 3]!, outputPositions[oa * 3 + 1]!, outputPositions[oa * 3 + 2]!],
        [outputPositions[ob * 3]!, outputPositions[ob * 3 + 1]!, outputPositions[ob * 3 + 2]!],
        [outputPositions[oc * 3]!, outputPositions[oc * 3 + 1]!, outputPositions[oc * 3 + 2]!],
      );
      if (distance < minDistance) minDistance = distance;
      if (minDistance === 0) break;
    }
    if (Number.isFinite(minDistance) && minDistance > maxDistance) maxDistance = minDistance;
  }
  return { max: Math.sqrt(maxDistance), samples: sampleCount };
}

function emptyResult(
  primitive: SimplifiablePrimitive,
  request: SimplifyToleranceRequest,
  fields: { status: SimplifyToleranceStatus; reason?: string },
): SimplifyToleranceResult {
  const inputTriangleCount = Math.floor(primitive.indices.length / 3);
  return {
    primitiveId: primitive.primitiveId,
    status: fields.status,
    ...(fields.reason ? { reason: fields.reason } : {}),
    inputTriangleCount,
    outputTriangleCount: 0,
    vertexCount: Math.floor(primitive.positions.length / 3),
    meshScale: 0,
    tolerance: Number.isFinite(request.tolerance) ? request.tolerance : 0,
    targetTriangleRatio: request.targetTriangleRatio ?? null,
    simplifierErrorAbsolute: null,
    withinTolerance: false,
    measuredMaxCentroidDeviation: null,
    measuredSampleCount: 0,
    faceMapping: [],
    faceMappingLimit: request.faceMappingLimit ?? 64,
    mappedOutputTriangles: 0,
    unmappedOutputTriangles: 0,
    mappedSourceFaceCount: 0,
    collapsedSourceFaceCount: 0,
    strippedDegenerateTriangles: 0,
    duplicateSourceFaces: 0,
  };
}

/**
 * GLB 适配器:对文件中全部 TRIANGLES 图元逐个执行公差简化。
 * 只读输入文件,不写任何输出;primitiveId 与拓扑检查一致(mesh:i/primitive:j)。
 */
export async function simplifyGlbWithTolerance(
  filePath: string,
  request: SimplifyToleranceRequest,
): Promise<SimplifyToleranceResult[]> {
  const io = await glbIo();
  const document = await io.read(filePath);
  const results: SimplifyToleranceResult[] = [];
  const meshes = document.getRoot().listMeshes();
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
    const primitives = meshes[meshIndex]!.listPrimitives();
    for (let primitiveIndex = 0; primitiveIndex < primitives.length; primitiveIndex += 1) {
      const primitiveId = `mesh:${meshIndex}/primitive:${primitiveIndex}`;
      const primitive = primitives[primitiveIndex]!;
      const positionAccessor = primitive.getAttribute("POSITION");
      if (!positionAccessor || primitive.getMode() !== 4) {
        results.push(emptyResult(
          { primitiveId, positions: new Float32Array(0), indices: new Uint32Array(0) },
          request,
          { status: "rejected", reason: "缺少 POSITION 或非 TRIANGLES 图元" },
        ));
        continue;
      }
      results.push(await simplifyPrimitiveWithTolerance(
        {
          primitiveId,
          positions: decodeVec3Attribute(positionAccessor),
          indices: primitive.getIndices()
            ? decodeScalarIndices(primitive.getIndices()!)
            : sequence(positionAccessor.getCount()),
        },
        request,
      ));
    }
  }
  return results;
}

function sequence(count: number): Uint32Array {
  const out = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) out[index] = index;
  return out;
}

let glbIoPromise: Promise<NodeIO> | undefined;

async function glbIo(): Promise<NodeIO> {
  glbIoPromise ??= draco3d.createDecoderModule().then((decoder) => new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.decoder": decoder, "meshopt.decoder": MeshoptDecoder }));
  return glbIoPromise;
}
