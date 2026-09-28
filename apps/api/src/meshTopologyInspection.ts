import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";
import {
  MESH_SAMPLE_LIMIT,
  aabbDiagonal,
  canonicalEdgeKey,
  canonicalTriangleKey,
  countNonFinite,
  decodeScalarIndices,
  decodeVec3Attribute,
  positionRemap,
  triangleCross,
} from "./meshProcessingShared.js";

/**
 * T12 几何处理切片之拓扑检查:非流形边、孤立顶点、退化/重复三角形、
 * 负缩放节点、翻转/零长法线的**只检测不修补**报告。
 * 机器可读 issue 列表定位到 primitive;任何畸形输入都以 issue 呈现,不抛异常。
 */

export type MeshTopologyIssueSeverity = "error" | "warning" | "info";

export type MeshTopologyIssueCode =
  | "MALFORMED_ACCESSOR"
  | "EMPTY_PRIMITIVE"
  | "INDEX_OUT_OF_RANGE"
  | "DEGENERATE_TRIANGLE"
  | "DUPLICATE_TRIANGLE"
  | "ISOLATED_VERTEX"
  | "NON_MANIFOLD_EDGE"
  | "OPEN_EDGE"
  | "FLIPPED_NORMAL"
  | "ZERO_LENGTH_NORMAL"
  | "NEGATIVE_SCALE"
  | "PRIMITIVE_MODE_UNSUPPORTED"
  | "INSPECTION_FAILED";

export interface MeshTopologyIssueDescriptor {
  severity: MeshTopologyIssueSeverity;
  meaning: string;
  locator: string;
}

/** issue 字典:码 → 严重级 / 含义 / 定位符格式。机器可读,测试与报告共用。 */
export const MESH_TOPOLOGY_ISSUE_DICTIONARY: Readonly<
  Record<MeshTopologyIssueCode, MeshTopologyIssueDescriptor>
> = {
  MALFORMED_ACCESSOR: {
    severity: "error",
    meaning: "属性/索引数组长度非法或含非有限坐标,无法按三角网格解读",
    locator: "primitive:<primitiveId> attribute:<POSITION|NORMAL|indices>",
  },
  EMPTY_PRIMITIVE: {
    severity: "warning",
    meaning: "图元不含任何三角形",
    locator: "primitive:<primitiveId>",
  },
  INDEX_OUT_OF_RANGE: {
    severity: "error",
    meaning: "索引引用超出顶点数,渲染未定义",
    locator: "primitive:<primitiveId> triangle:<i> index:<v> vertexCount:<n>",
  },
  DEGENERATE_TRIANGLE: {
    severity: "error",
    meaning: "零面积、共线或重复顶点的三角形",
    locator: "primitive:<primitiveId> triangle:<i> reason:<repeated-index|repeated-position|zero-area>",
  },
  DUPLICATE_TRIANGLE: {
    severity: "warning",
    meaning: "同一规范顶点三元组出现多次(重复面)",
    locator: "primitive:<primitiveId> triangle:<i> key:<a_b_c>",
  },
  ISOLATED_VERTEX: {
    severity: "warning",
    meaning: "未被任何索引引用的顶点",
    locator: "primitive:<primitiveId> vertex:<i>",
  },
  NON_MANIFOLD_EDGE: {
    severity: "error",
    meaning: "一条边被超过 2 个三角形共享(非流形)",
    locator: "primitive:<primitiveId> edge:<a_b> incident:<n>",
  },
  OPEN_EDGE: {
    severity: "info",
    meaning: "只有 1 个三角形使用的边界边(开放壳合法,仅提示)",
    locator: "primitive:<primitiveId> edge:<a_b>",
  },
  FLIPPED_NORMAL: {
    severity: "error",
    meaning: "存档法线与几何法线相反;过半翻转判 error,少数翻转判 warning",
    locator: "primitive:<primitiveId> triangle:<i> dot:<d>",
  },
  ZERO_LENGTH_NORMAL: {
    severity: "warning",
    meaning: "长度为 0 的存档法线",
    locator: "primitive:<primitiveId> vertex:<i>",
  },
  NEGATIVE_SCALE: {
    severity: "error",
    meaning: "节点世界矩阵行列式为负,三角形环绕方向被翻转",
    locator: "node:<index> name:<name> determinant:<d>",
  },
  PRIMITIVE_MODE_UNSUPPORTED: {
    severity: "info",
    meaning: "非 TRIANGLES(mode 4)图元,本检查跳过其拓扑统计",
    locator: "primitive:<primitiveId> mode:<mode>",
  },
  INSPECTION_FAILED: {
    severity: "error",
    meaning: "检查过程内部异常(不中断其余图元,样本保证不崩溃)",
    locator: "primitive:<primitiveId> message:<message>",
  },
};

export interface MeshPrimitiveTopologyInput {
  primitiveId: string;
  /** 连续 XYZ;长度必须是 3 的倍数。 */
  positions: ArrayLike<number>;
  /** 三角列表索引;长度必须是 3 的倍数。 */
  indices: ArrayLike<number>;
  /** 连续 XYZ 法线;长度必须等于顶点数 * 3。 */
  normals?: ArrayLike<number> | undefined;
}

export interface GlbNodeTopologyInput {
  nodeIndex: number;
  nodeName?: string | undefined;
  /** 世界矩阵行列式。 */
  determinant: number;
}

export interface MeshTopologyIssue {
  code: MeshTopologyIssueCode;
  severity: MeshTopologyIssueSeverity;
  primitiveId: string;
  count: number;
  samples: string[];
  detail?: string;
}

export interface MeshTopologyInspectionReport {
  primitiveCount: number;
  vertexCount: number;
  triangleCount: number;
  /** 无 error 级 issue 时为 true;只读语义,不代表几何被修补。 */
  ok: boolean;
  issues: MeshTopologyIssue[];
  issueCountsByCode: Partial<Record<MeshTopologyIssueCode, number>>;
}

const SEVERITY_RANK: Record<MeshTopologyIssueSeverity, number> = { error: 0, warning: 1, info: 2 };

/** 退化判定阈值:面积平方 ≤ (1e-7 × 包围盒对角线)² 视为零面积。 */
const DEGENERATE_AREA_FACTOR = 1e-7;

/** 单图元拓扑检查(核心,数组入参,可脱离 GLB 复用)。返回按严重级排序的 issue 列表。 */
export async function inspectPrimitiveTopology(
  primitive: MeshPrimitiveTopologyInput,
): Promise<MeshTopologyIssue[]> {
  const issues: MeshTopologyIssue[] = [];
  const { primitiveId } = primitive;
  try {
    const positions = primitive.positions;
    const indices = primitive.indices;
    if (positions.length % 3 !== 0) {
      issues.push(issue("MALFORMED_ACCESSOR", primitiveId, 1,
        [`attribute:POSITION length:${positions.length}`], "POSITION 长度不是 3 的倍数"));
      return sortIssues(issues);
    }
    const nonFinite = countNonFinite(positions);
    if (nonFinite > 0) {
      issues.push(issue("MALFORMED_ACCESSOR", primitiveId, nonFinite,
        ["attribute:POSITION non-finite"], "POSITION 含非有限坐标"));
      return sortIssues(issues);
    }
    const vertexCount = positions.length / 3;

    let triangleCount = indices.length / 3;
    if (!Number.isInteger(triangleCount)) {
      issues.push(issue("MALFORMED_ACCESSOR", primitiveId, 1,
        [`attribute:indices length:${indices.length}`], "索引长度不是 3 的倍数,按截断到完整三角形继续检查"));
      triangleCount = Math.floor(triangleCount);
    }
    const completeIndices = Math.min(indices.length, triangleCount * 3);
    if (triangleCount === 0) {
      issues.push(issue("EMPTY_PRIMITIVE", primitiveId, 1, ["triangles:0"]));
      return sortIssues(issues);
    }

    const outOfRange: string[] = [];
    let outOfRangeCount = 0;
    for (let offset = 0; offset < completeIndices; offset += 1) {
      const value = indices[offset]!;
      if (!Number.isInteger(value) || value < 0 || value >= vertexCount) {
        outOfRangeCount += 1;
        if (outOfRange.length < MESH_SAMPLE_LIMIT) {
          outOfRange.push(`triangle:${Math.floor(offset / 3)} index:${value} vertexCount:${vertexCount}`);
        }
      }
    }
    if (outOfRangeCount > 0) {
      issues.push(issue("INDEX_OUT_OF_RANGE", primitiveId, outOfRangeCount, outOfRange));
    }

    const remap = await positionRemap(toFloat32(positions));
    const areaEpsilon = (aabbDiagonal(positions) * DEGENERATE_AREA_FACTOR) ** 2;
    const edgeIncidence = new Map<string, number>();
    const triangleKeys = new Map<string, number>();
    const usedVertices = new Uint8Array(vertexCount);
    const degenerate: string[] = [];
    let degenerateCount = 0;
    const duplicate: string[] = [];
    let duplicateCount = 0;
    let validTriangles = 0;
    let flippedFaces = 0;
    const flippedSamples: string[] = [];
    let openTriangleCount = 0;

    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const a = indices[triangle * 3]!, b = indices[triangle * 3 + 1]!, c = indices[triangle * 3 + 2]!;
      if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)
        || a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) {
        continue;
      }
      openTriangleCount += 1;
      usedVertices[a] = 1; usedVertices[b] = 1; usedVertices[c] = 1;
      const ca = remap[a]!, cb = remap[b]!, cc = remap[c]!;
      let reason: string | undefined;
      if (a === b || b === c || a === c) reason = "repeated-index";
      else if (ca === cb || cb === cc || ca === cc) reason = "repeated-position";
      else {
        const cross = triangleCross(positions, a, b, c);
        if (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2] <= areaEpsilon) reason = "zero-area";
      }
      if (reason !== undefined) {
        degenerateCount += 1;
        if (degenerate.length < MESH_SAMPLE_LIMIT) degenerate.push(`triangle:${triangle} reason:${reason}`);
        continue;
      }
      validTriangles += 1;
      const key = canonicalTriangleKey(ca, cb, cc);
      const seen = triangleKeys.get(key);
      if (seen === undefined) triangleKeys.set(key, triangle);
      else {
        duplicateCount += 1;
        if (duplicate.length < MESH_SAMPLE_LIMIT) duplicate.push(`triangle:${triangle} key:${key}`);
      }
      for (const [from, to] of [[ca, cb], [cb, cc], [cc, ca]] as const) {
        const edgeKey = canonicalEdgeKey(from, to);
        edgeIncidence.set(edgeKey, (edgeIncidence.get(edgeKey) ?? 0) + 1);
      }
    }

    if (degenerateCount > 0) issues.push(issue("DEGENERATE_TRIANGLE", primitiveId, degenerateCount, degenerate));
    if (duplicateCount > 0) issues.push(issue("DUPLICATE_TRIANGLE", primitiveId, duplicateCount, duplicate));

    const nonManifold: string[] = [];
    let nonManifoldCount = 0;
    const openEdges: string[] = [];
    let openEdgeCount = 0;
    for (const [edgeKey, incidence] of edgeIncidence) {
      if (incidence > 2) {
        nonManifoldCount += 1;
        if (nonManifold.length < MESH_SAMPLE_LIMIT) nonManifold.push(`edge:${edgeKey} incident:${incidence}`);
      } else if (incidence === 1) {
        openEdgeCount += 1;
        if (openEdges.length < MESH_SAMPLE_LIMIT) openEdges.push(`edge:${edgeKey}`);
      }
    }
    if (nonManifoldCount > 0) issues.push(issue("NON_MANIFOLD_EDGE", primitiveId, nonManifoldCount, nonManifold));
    if (openEdgeCount > 0) {
      issues.push({ ...issue("OPEN_EDGE", primitiveId, openEdgeCount, openEdges),
        detail: `validTriangles:${validTriangles}` });
    }

    let isolatedCount = 0;
    const isolatedSamples: string[] = [];
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      if (usedVertices[vertex] === 0) {
        isolatedCount += 1;
        if (isolatedSamples.length < MESH_SAMPLE_LIMIT) isolatedSamples.push(`vertex:${vertex}`);
      }
    }
    if (isolatedCount > 0) issues.push(issue("ISOLATED_VERTEX", primitiveId, isolatedCount, isolatedSamples));

    if (openTriangleCount > 0 && primitive.normals !== undefined) {
      const normalIssues = inspectNormals(primitive, openTriangleCount, remap);
      issues.push(...normalIssues);
    }
    return sortIssues(issues);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sortIssues([...issues, issue("INSPECTION_FAILED", primitiveId, 1, [`message:${message}`])]);
  }
}

function inspectNormals(
  primitive: MeshPrimitiveTopologyInput,
  triangleCount: number,
  remap: Uint32Array,
): MeshTopologyIssue[] {
  const issues: MeshTopologyIssue[] = [];
  const normals = primitive.normals!;
  const primitiveId = primitive.primitiveId;
  if (normals.length !== primitive.positions.length) {
    issues.push(issue("MALFORMED_ACCESSOR", primitiveId, 1,
      [`attribute:NORMAL length:${normals.length}`], "NORMAL 长度与顶点数 * 3 不一致"));
    return issues;
  }
  const zeroLength: string[] = [];
  let zeroLengthCount = 0;
  for (let vertex = 0; vertex < remap.length; vertex += 1) {
    const offset = vertex * 3;
    const length = Math.hypot(normals[offset]!, normals[offset + 1]!, normals[offset + 2]!);
    if (length === 0) {
      zeroLengthCount += 1;
      if (zeroLength.length < MESH_SAMPLE_LIMIT) zeroLength.push(`vertex:${vertex}`);
    }
  }
  if (zeroLengthCount > 0) issues.push(issue("ZERO_LENGTH_NORMAL", primitiveId, zeroLengthCount, zeroLength));

  const positions = primitive.positions;
  let flippedCount = 0;
  const flippedSamples: string[] = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const a = primitive.indices[triangle * 3]!, b = primitive.indices[triangle * 3 + 1]!, c = primitive.indices[triangle * 3 + 2]!;
    if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)
      || a < 0 || b < 0 || c < 0
      || a * 3 + 2 >= normals.length || b * 3 + 2 >= normals.length || c * 3 + 2 >= normals.length) continue;
    const cross = triangleCross(positions, a, b, c);
    const crossLength = Math.hypot(cross[0], cross[1], cross[2]);
    if (crossLength === 0) continue;
    const storedOffset = a * 3;
    const dot = (cross[0] * normals[storedOffset]!
      + cross[1] * normals[storedOffset + 1]!
      + cross[2] * normals[storedOffset + 2]!) / crossLength;
    if (dot < 0) {
      flippedCount += 1;
      if (flippedSamples.length < MESH_SAMPLE_LIMIT) flippedSamples.push(`triangle:${triangle} dot:${dot.toFixed(6)}`);
    }
  }
  if (flippedCount > 0) {
    const flippedRatio = flippedCount / triangleCount;
    const flipped: MeshTopologyIssue = issue("FLIPPED_NORMAL", primitiveId, flippedCount, flippedSamples);
    if (flippedRatio >= 0.5) flipped.severity = "error";
    else flipped.severity = "warning";
    flipped.detail = `flippedRatio:${flippedRatio.toFixed(4)} of triangles:${triangleCount}`;
    issues.push(flipped);
  }
  return issues;
}

/** 全量检查:聚合图元与节点(负缩放),输出确定性排序的机器可读报告。 */
export async function inspectMeshTopologies(inputs: {
  primitives: MeshPrimitiveTopologyInput[];
  nodes?: GlbNodeTopologyInput[] | undefined;
}): Promise<MeshTopologyInspectionReport> {
  const issues: MeshTopologyIssue[] = [];
  let vertexCount = 0;
  let triangleCount = 0;
  for (const primitive of inputs.primitives) {
    vertexCount += primitive.positions.length / 3;
    triangleCount += Math.floor(primitive.indices.length / 3);
    issues.push(...await inspectPrimitiveTopology(primitive));
  }
  for (const node of inputs.nodes ?? []) {
    if (Number.isFinite(node.determinant) && node.determinant < 0) {
      const negative: MeshTopologyIssue = issue("NEGATIVE_SCALE", `node:${node.nodeIndex}`, 1, [
        `name:${node.nodeName ?? "<unnamed>"} determinant:${node.determinant}`,
      ]);
      issues.push(negative);
    }
  }
  return finalize(issues, { primitiveCount: inputs.primitives.length, vertexCount, triangleCount });
}

/** GLB 适配器:读取文件,枚举 mesh/primitive 与节点世界矩阵后走核心检查。 */
export async function inspectGlbTopology(filePath: string): Promise<MeshTopologyInspectionReport> {
  const io = await glbIo();
  const document = await io.read(filePath);
  const primitives: MeshPrimitiveTopologyInput[] = [];
  const nodes: GlbNodeTopologyInput[] = [];
  const modes: MeshTopologyIssue[] = [];
  document.getRoot().listMeshes().forEach((mesh, meshIndex) => {
    mesh.listPrimitives().forEach((primitive, primitiveIndex) => {
      const primitiveId = `mesh:${meshIndex}/primitive:${primitiveIndex}`;
      const positionAccessor = primitive.getAttribute("POSITION");
      const normalAccessor = primitive.getAttribute("NORMAL");
      if (!positionAccessor) {
        modes.push(issue("MALFORMED_ACCESSOR", primitiveId, 1, ["attribute:POSITION missing"]));
        return;
      }
      if (primitive.getMode() !== 4) {
        modes.push(issue("PRIMITIVE_MODE_UNSUPPORTED", primitiveId, 1, [`mode:${primitive.getMode()}`]));
        return;
      }
      primitives.push({
        primitiveId,
        positions: decodeVec3Attribute(positionAccessor),
        indices: primitive.getIndices() ? decodeScalarIndices(primitive.getIndices()!) : sequence(positionAccessor.getCount()),
        normals: normalAccessor ? decodeVec3Attribute(normalAccessor) : undefined,
      });
    });
  });
  document.getRoot().listNodes().forEach((node, nodeIndex) => {
    const world = node.getWorldMatrix();
    nodes.push({
      nodeIndex,
      nodeName: node.getName() || undefined,
      determinant: matrixDeterminant(world),
    });
  });
  const report = await inspectMeshTopologies({ primitives, nodes });
  report.issues = sortIssues([...report.issues, ...modes]);
  report.issueCountsByCode = countByCode(report.issues);
  report.ok = !report.issues.some((entry) => entry.severity === "error");
  return report;
}

function sequence(count: number): Uint32Array {
  const out = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) out[index] = index;
  return out;
}

function matrixDeterminant(matrix: ArrayLike<number>): number {
  const m = matrix;
  return m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!)
    - m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!)
    + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!);
}

function issue(
  code: MeshTopologyIssueCode,
  primitiveId: string,
  count: number,
  samples: string[],
  detail?: string,
): MeshTopologyIssue {
  const descriptor = MESH_TOPOLOGY_ISSUE_DICTIONARY[code];
  return { code, severity: descriptor.severity, primitiveId, count, samples, ...(detail ? { detail } : {}) };
}

function finalize(
  issues: MeshTopologyIssue[],
  extra?: { primitiveCount: number; vertexCount: number; triangleCount: number },
): MeshTopologyInspectionReport {
  const sorted = sortIssues(issues);
  return {
    primitiveCount: extra?.primitiveCount ?? 0,
    vertexCount: extra?.vertexCount ?? 0,
    triangleCount: extra?.triangleCount ?? 0,
    ok: !sorted.some((entry) => entry.severity === "error"),
    issues: sorted,
    issueCountsByCode: countByCode(sorted),
  };
}

function sortIssues(issues: MeshTopologyIssue[]): MeshTopologyIssue[] {
  return [...issues].sort((left, right) =>
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    || left.code.localeCompare(right.code)
    || left.primitiveId.localeCompare(right.primitiveId));
}

function countByCode(issues: MeshTopologyIssue[]): Partial<Record<MeshTopologyIssueCode, number>> {
  const counts: Partial<Record<MeshTopologyIssueCode, number>> = {};
  for (const entry of issues) counts[entry.code] = (counts[entry.code] ?? 0) + entry.count;
  return counts;
}

function toFloat32(values: ArrayLike<number>): Float32Array {
  return values instanceof Float32Array ? values : Float32Array.from(values);
}

let glbIoPromise: Promise<NodeIO> | undefined;

async function glbIo(): Promise<NodeIO> {
  glbIoPromise ??= draco3d.createDecoderModule().then((decoder) => new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.decoder": decoder, "meshopt.decoder": MeshoptDecoder }));
  return glbIoPromise;
}
