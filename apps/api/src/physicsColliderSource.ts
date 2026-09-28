import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";
import { decodeScalarIndices, decodeVec3Attribute } from "./meshProcessingShared.js";
import { inspectPrimitiveTopology, type MeshTopologyIssue } from "./meshTopologyInspection.js";
import { simplifyPrimitiveWithTolerance } from "./meshSimplifyTolerance.js";

/**
 * T17 CAD→collider 来源规范之生成管线:网格图元 → 拓扑检查(T12) →
 * 按策略产出 collider(convex-hull / simplified-mesh)→ 精度标记。
 * 纪律与 T12 一致:只产出派生几何与标记,不修补、不冒充精确——
 * 拓扑 error 级缺陷或简化公差超限时 collider 必须 approximate=true + 机器可读原因。
 * 输出几何位于输入网格所在空间;调用方以「刚体局部空间」作为输入空间
 * (把实例世界变换 × 逆刚体位姿应用到 positions / 每图元 transform)。
 * 凸分解(凹体多凸)不在本切片:凹体先给凸包并标记 concaveSource。
 */

export type PhysicsColliderStrategy = "convex-hull" | "simplified-mesh";

export interface ColliderMeshPrimitive {
  primitiveId: string;
  /** 连续 XYZ。 */
  positions: ArrayLike<number>;
  /** 三角列表索引。 */
  indices: ArrayLike<number>;
  /** 可选:该图元 → collider 输出空间的 4x4 列主序变换(GLB/渲染包约定)。 */
  transform?: readonly number[] | undefined;
}

export interface PhysicsColliderSourceRequest {
  strategy: PhysicsColliderStrategy;
  /** simplified-mesh 必填:绝对公差(米/网格单位)。 */
  simplifyTolerance?: number | undefined;
  /** simplified-mesh 可选:目标三角形保留比例 (0,1]。 */
  simplifyTargetTriangleRatio?: number | undefined;
}

export interface PhysicsColliderSourceResult {
  strategy: PhysicsColliderStrategy;
  /** ok=名义精度;approximate=带已知偏差(见 reasons);failed=无法产出 collider。 */
  status: "ok" | "approximate" | "failed";
  /** true 时消费方只能把 collider 当近似体,不得冒充精确。 */
  approximate: boolean;
  /** approximate/failed 的机器可读原因码。 */
  reasons: string[];
  /** 拓扑检查结论(T12 字典):true = 无 error 级 issue。 */
  topologyOk: boolean;
  /** 出现过的 issue 码(含 warning/info)。 */
  topologyIssueCodes: string[];
  sourceTriangleCount: number;
  sourceVertexCount: number;
  /** 非 TRIANGLES 图元跳过数(GLB 适配器口径,对应拓扑检查 PRIMITIVE_MODE_UNSUPPORTED)。 */
  skippedNonTrianglePrimitives: number;
  /** convex-hull 产物:顶点(米/网格单位)与外向 CCW 三角面(索引引用 points)。 */
  points?: Array<[number, number, number]>;
  hullFaces?: Array<[number, number, number]>;
  hullVertexCount?: number;
  hullTriangleCount?: number;
  /** 源网格为凹体:凸包名义上就会过度包裹,属来源性质而非精度失败。 */
  concaveSource?: boolean;
  /** simplified-mesh 产物。 */
  positions?: Array<[number, number, number]>;
  indices?: number[];
  triangleCount?: number;
  /** simplified-mesh:目标公差与 meshoptimizer 实测绝对误差(顶点位移意义的界)。 */
  tolerance?: number | null;
  simplifierErrorAbsolute?: number | null;
}

const MAX_SOURCE_VERTICES = 2_000_000;
const MAX_HULL_POINTS = 65_536;
/** 冲突点/共面判定阈值:包围盒对角线 × 1e-6(米级网格 ≈ 微米)。 */
const HULL_EPSILON_FACTOR = 1e-6;

/** 生成 collider 的核心入口(数组入参,可脱离 GLB 复用)。 */
export async function generatePhysicsCollider(
  primitives: readonly ColliderMeshPrimitive[],
  request: PhysicsColliderSourceRequest,
): Promise<PhysicsColliderSourceResult> {
  const base = (fields: Partial<PhysicsColliderSourceResult> & { status: "ok" | "approximate" | "failed"; reasons: string[] }):
    PhysicsColliderSourceResult => ({
    strategy: request.strategy, approximate: fields.status !== "ok",
    topologyOk: true, topologyIssueCodes: [], sourceTriangleCount: 0, sourceVertexCount: 0,
    skippedNonTrianglePrimitives: 0, ...fields,
  });
  if (!primitives.length) return base({ status: "failed", reasons: ["no-primitives"] });
  if (request.strategy === "simplified-mesh"
    && (!Number.isFinite(request.simplifyTolerance) || (request.simplifyTolerance ?? 0) <= 0)) {
    return base({ status: "failed", reasons: ["simplified-mesh requires a positive simplifyTolerance"] });
  }

  // 阶段 1:拓扑检查(只读,T12 字典码;单图元异常不中断其余图元)。
  const issues: MeshTopologyIssue[] = [];
  for (const primitive of primitives) {
    issues.push(...await inspectPrimitiveTopology({
      primitiveId: primitive.primitiveId, positions: primitive.positions, indices: primitive.indices,
    }));
  }
  const codes = [...new Set(issues.map(issue => issue.code))];
  const errorCodes = codes.filter(code => issues.some(issue => issue.code === code && issue.severity === "error"));
  const topologyOk = errorCodes.length === 0;

  // 阶段 2:合并图元(应用可选变换、位置去重);数据性缺陷 fail-closed,不产出半成品。
  const merged = mergePrimitives(primitives);
  const context = {
    topologyOk, topologyIssueCodes: codes, topologyErrorCodes: errorCodes,
    sourceTriangleCount: merged.sourceTriangleCount, sourceVertexCount: merged.sourceVertexCount,
  };
  if (merged.error) {
    return base({ status: "failed", reasons: [merged.error], ...context });
  }
  if (merged.pointCount < 4) {
    // convex-hull 由 quickhull 给出具体原因;simplified-mesh 无三角形时自然失败。
    return base({ status: "failed", reasons: ["hull requires at least 4 points"], ...context });
  }

  if (request.strategy === "convex-hull") {
    return { ...base({ status: "ok", reasons: [], ...context }), ...convexHullCollider(merged.points, context) };
  }
  return { ...base({ status: "ok", reasons: [], ...context }), ...(await simplifiedMeshCollider(primitives, request, context)) };
}

interface MergeContext {
  topologyOk: boolean;
  topologyIssueCodes: string[];
  topologyErrorCodes: string[];
  sourceTriangleCount: number;
  sourceVertexCount: number;
}

interface MergedPoints {
  points: Float64Array;
  pointCount: number;
  sourceTriangleCount: number;
  sourceVertexCount: number;
  error?: string;
}

function mergePrimitives(primitives: readonly ColliderMeshPrimitive[]): MergedPoints {
  const unique = new Set<string>();
  const coordinates: number[] = [];
  let sourceTriangleCount = 0;
  let sourceVertexCount = 0;
  for (const primitive of primitives) {
    const { positions, indices } = primitive;
    if (positions.length % 3 !== 0 || indices.length % 3 !== 0) {
      return failure(`MALFORMED_ACCESSOR:${primitive.primitiveId}`);
    }
    sourceVertexCount += positions.length / 3;
    sourceTriangleCount += indices.length / 3;
    if (coordinates.length / 3 + positions.length / 3 > MAX_SOURCE_VERTICES) {
      return failure("source mesh exceeds MAX_SOURCE_VERTICES");
    }
    const matrix = primitive.transform;
    for (let offset = 0; offset < positions.length; offset += 3) {
      const raw: [number, number, number] = [positions[offset]!, positions[offset + 1]!, positions[offset + 2]!];
      const point = matrix ? applyTransform(matrix, raw) : raw;
      if (point.some(value => !Number.isFinite(value))) {
        return failure(`NON_FINITE_POSITION:${primitive.primitiveId}`);
      }
      const key = `${point[0]},${point[1]},${point[2]}`;
      if (!unique.has(key)) {
        unique.add(key);
        coordinates.push(point[0], point[1], point[2]);
      }
    }
    for (let offset = 0; offset < indices.length; offset += 1) {
      const index = indices[offset]!;
      if (!Number.isInteger(index) || index < 0 || index * 3 >= positions.length) {
        return failure(`INDEX_OUT_OF_RANGE:${primitive.primitiveId}`);
      }
    }
  }
  return { points: Float64Array.from(coordinates), pointCount: unique.size, sourceTriangleCount, sourceVertexCount };

  function failure(error: string): MergedPoints {
    return { points: new Float64Array(0), pointCount: 0, sourceTriangleCount, sourceVertexCount, error };
  }
}

function applyTransform(matrix: readonly number[], point: readonly number[]): [number, number, number] {
  if (matrix.length !== 16) throw new Error(`collider transform must be 16 floats, got ${matrix.length}`);
  // 列主序 4x4:GLB/渲染包约定。
  return [
    matrix[0]! * point[0]! + matrix[4]! * point[1]! + matrix[8]! * point[2]! + matrix[12]!,
    matrix[1]! * point[0]! + matrix[5]! * point[1]! + matrix[9]! * point[2]! + matrix[13]!,
    matrix[2]! * point[0]! + matrix[6]! * point[1]! + matrix[10]! * point[2]! + matrix[14]!,
  ];
}

// ---------------------------------------------------------------------------
// 确定性 3D quickhull:输入为去重顶点;输出外向 CCW 三角面。
// 朝向不靠分情况推导:初始单纯形质心作为内点,每个面(初始/新增)都按
// 「内点在负侧」重定向,内点在整个构包过程中始终位于凸包内部(单纯形顶点
// 都是极值点,凸包只会在其外侧生长)。退化(全共线/全共面/<4 点)显式失败。
// ---------------------------------------------------------------------------

interface HullFace { a: number; b: number; c: number; nx: number; ny: number; nz: number; offset: number }

interface HullBuildResult {
  status: "ok" | "failed";
  reason?: string;
  vertices: Array<[number, number, number]>;
  faces: Array<[number, number, number]>;
}

function convexHullCollider(
  points: Float64Array,
  context: MergeContext,
): Partial<PhysicsColliderSourceResult> {
  const topologyReasons = context.topologyOk ? [] : [`topology-error:${context.topologyErrorCodes.join("|")}`];
  const hull = quickhull(points);
  if (hull.status === "failed") {
    return { status: "failed", approximate: true, reasons: [hull.reason ?? "hull-failed"] };
  }
  if (hull.vertices.length > MAX_HULL_POINTS) {
    return { status: "failed", approximate: true, reasons: ["hull vertex count exceeds MAX_HULL_POINTS"] };
  }
  return {
    status: topologyReasons.length ? "approximate" : "ok",
    approximate: topologyReasons.length > 0,
    reasons: topologyReasons,
    points: hull.vertices,
    hullFaces: hull.faces,
    hullVertexCount: hull.vertices.length,
    hullTriangleCount: hull.faces.length,
    concaveSource: context.sourceTriangleCount > hull.faces.length,
  };
}

function quickhull(points: Float64Array): HullBuildResult {
  const count = points.length / 3;
  const fail = (reason: string): HullBuildResult => ({ status: "failed", reason, vertices: [], faces: [] });
  if (count < 4) return fail("hull requires at least 4 points");
  let maxAbs = 0;
  for (let index = 0; index < points.length; index += 1) maxAbs = Math.max(maxAbs, Math.abs(points[index]!));
  const diagonal = maxAbs * 2;
  if (!(diagonal > 0)) return fail("hull points are degenerate (zero extent)");
  const epsilon = diagonal * HULL_EPSILON_FACTOR;

  // 初始单纯形:x 极小/极大点 → 距线最远点 → 距面最远点。
  let i0 = 0, i1 = 0;
  for (let index = 1; index < count; index += 1) {
    if (points[index * 3]! < points[i0 * 3]!) i0 = index;
    if (points[index * 3]! > points[i1 * 3]!) i1 = index;
  }
  if (distance(points, i0, i1) <= epsilon) return fail("hull points are collinear along x (degenerate)");
  let i2 = -1, lineDistance = -1;
  for (let index = 0; index < count; index += 1) {
    const value = pointLineDistance(points, index, i0, i1);
    if (value > lineDistance) { lineDistance = value; i2 = index; }
  }
  if (lineDistance <= epsilon) return fail("hull points are collinear (degenerate)");
  let i3 = -1, planeDistance = -1;
  for (let index = 0; index < count; index += 1) {
    const value = Math.abs(signedPlaneDistance(points, index, i0, i1, i2));
    if (value > planeDistance) { planeDistance = value; i3 = index; }
  }
  if (planeDistance <= epsilon) return fail("hull points are coplanar (degenerate)");

  const inner: [number, number, number] = [
    (points[i0 * 3]! + points[i1 * 3]! + points[i2 * 3]! + points[i3 * 3]!) / 4,
    (points[i0 * 3 + 1]! + points[i1 * 3 + 1]! + points[i2 * 3 + 1]! + points[i3 * 3 + 1]!) / 4,
    (points[i0 * 3 + 2]! + points[i1 * 3 + 2]! + points[i2 * 3 + 2]! + points[i3 * 3 + 2]!) / 4,
  ];
  const makeFace = (a: number, b: number, c: number): HullFace => {
    const candidate = planeOf(points, a, b, c);
    // 内点在负侧 = 外向;否则翻转环绕序。
    return candidate.nx * inner[0] + candidate.ny * inner[1] + candidate.nz * inner[2] + candidate.offset > 0
      ? planeOf(points, a, c, b)
      : candidate;
  };
  let faces: HullFace[] = [makeFace(i0, i1, i2), makeFace(i0, i1, i3), makeFace(i1, i2, i3), makeFace(i2, i0, i3)];

  // 冲突集:点 → 距其最远可见面的有符号距离(> epsilon 才入集)。
  let conflicts = new Map<number, { face: number; dist: number }>();
  const assignAll = (target: Map<number, { face: number; dist: number }>, candidates: Iterable<number>) => {
    for (const point of candidates) {
      let best = -1, bestDist = 0;
      for (let index = 0; index < faces.length; index += 1) {
        const dist = distanceToFace(faces[index]!, points, point);
        if (dist > epsilon && dist > bestDist) { best = index; bestDist = dist; }
      }
      if (best >= 0) target.set(point, { face: best, dist: bestDist });
    }
  };
  const initialPoints: number[] = [];
  for (let point = 0; point < count; point += 1) {
    if (point !== i0 && point !== i1 && point !== i2 && point !== i3) initialPoints.push(point);
  }
  assignAll(conflicts, initialPoints);

  while (true) {
    // 最远冲突点(确定性:距离严格更大才替换,同距取首见)。
    let farPoint = -1, farDist = 0;
    for (const [point, entry] of conflicts) {
      if (entry.dist > farDist) { farDist = entry.dist; farPoint = point; }
    }
    if (farPoint < 0) break;

    // 可见面集合 + 地平线边(恰好属于一个可见面的边)。
    const visible = new Set<number>();
    for (let index = 0; index < faces.length; index += 1) {
      if (distanceToFace(faces[index]!, points, farPoint) > epsilon) visible.add(index);
    }
    const edgeUse = new Map<string, number>();
    for (const index of visible) {
      for (const [u, v] of faceEdges(faces[index]!)) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
      }
    }
    const horizon: Array<[number, number]> = [];
    for (const index of visible) {
      for (const [u, v] of faceEdges(faces[index]!)) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        if (edgeUse.get(key) === 1) horizon.push([u, v]);
      }
    }

    // 保留不可见面(记录重映射),为每条地平线边新建外向面。
    const kept: HullFace[] = [];
    const remap = new Array<number>(faces.length).fill(-1);
    faces.forEach((candidate, index) => {
      if (!visible.has(index)) { remap[index] = kept.length; kept.push(candidate); }
    });
    for (const [u, v] of horizon) kept.push(makeFace(u, v, farPoint));
    faces = kept;

    // 冲突集迁移:面仍存活的点直接重映射;面被移除的点对新面全集重扫。
    const migrated = new Map<number, { face: number; dist: number }>();
    const orphans: number[] = [];
    for (const [point, entry] of conflicts) {
      if (point === farPoint) continue;
      const remapped = remap[entry.face]!;
      if (remapped >= 0) migrated.set(point, { face: remapped, dist: entry.dist });
      else orphans.push(point);
    }
    assignAll(migrated, orphans);
    conflicts = migrated;
  }

  // 输出:压缩顶点编号 + 外向 CCW 面。
  const used = new Map<number, number>();
  const vertices: Array<[number, number, number]> = [];
  const compact = (index: number): number => {
    let value = used.get(index);
    if (value === undefined) {
      value = vertices.length;
      used.set(index, value);
      vertices.push([points[index * 3]!, points[index * 3 + 1]!, points[index * 3 + 2]!]);
    }
    return value;
  };
  const outFaces: Array<[number, number, number]> = faces.map(({ a, b, c }) => [compact(a), compact(b), compact(c)]);
  if (outFaces.length < 4 || vertices.length < 4) return fail("hull collapsed to a degenerate solid");
  return { status: "ok", vertices, faces: outFaces };
}

function faceEdges(candidate: HullFace): Array<[number, number]> {
  return [[candidate.a, candidate.b], [candidate.b, candidate.c], [candidate.c, candidate.a]];
}

function planeOf(points: Float64Array, a: number, b: number, c: number): HullFace {
  const ax = points[a * 3]!, ay = points[a * 3 + 1]!, az = points[a * 3 + 2]!;
  const ux = points[b * 3]! - ax, uy = points[b * 3 + 1]! - ay, uz = points[b * 3 + 2]! - az;
  const vx = points[c * 3]! - ax, vy = points[c * 3 + 1]! - ay, vz = points[c * 3 + 2]! - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length; ny /= length; nz /= length;
  return { a, b, c, nx, ny, nz, offset: -(nx * ax + ny * ay + nz * az) };
}

function distanceToFace(candidate: HullFace, points: Float64Array, point: number): number {
  return candidate.nx * points[point * 3]! + candidate.ny * points[point * 3 + 1]!
    + candidate.nz * points[point * 3 + 2]! + candidate.offset;
}

function signedPlaneDistance(points: Float64Array, point: number, a: number, b: number, c: number): number {
  return distanceToFace(planeOf(points, a, b, c), points, point);
}

function distance(points: Float64Array, a: number, b: number): number {
  return Math.hypot(
    points[a * 3]! - points[b * 3]!,
    points[a * 3 + 1]! - points[b * 3 + 1]!,
    points[a * 3 + 2]! - points[b * 3 + 2]!,
  );
}

function pointLineDistance(points: Float64Array, point: number, a: number, b: number): number {
  const ux = points[b * 3]! - points[a * 3]!, uy = points[b * 3 + 1]! - points[a * 3 + 1]!, uz = points[b * 3 + 2]! - points[a * 3 + 2]!;
  const wx = points[point * 3]! - points[a * 3]!, wy = points[point * 3 + 1]! - points[a * 3 + 1]!, wz = points[point * 3 + 2]! - points[a * 3 + 2]!;
  const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
  const length = Math.hypot(ux, uy, uz);
  return length > 0 ? Math.hypot(cx, cy, cz) / length : 0;
}

// ---------------------------------------------------------------------------
// simplified-mesh:逐图元调用 T12 公差简化,合并输出;公差超限/拓扑缺陷 → approximate。
// ---------------------------------------------------------------------------

async function simplifiedMeshCollider(
  primitives: readonly ColliderMeshPrimitive[],
  request: PhysicsColliderSourceRequest,
  context: MergeContext,
): Promise<Partial<PhysicsColliderSourceResult>> {
  const tolerance = request.simplifyTolerance!;
  const reasons: string[] = context.topologyOk ? [] : [`topology-error:${context.topologyErrorCodes.join("|")}`];
  const positions: Array<[number, number, number]> = [];
  const indices: number[] = [];
  let simplifierErrorAbsolute: number | null = null;
  let triangleCount = 0;
  for (const primitive of primitives) {
    const result = await simplifyPrimitiveWithTolerance({
      primitiveId: primitive.primitiveId, positions: primitive.positions, indices: primitive.indices,
    }, {
      tolerance,
      ...(request.simplifyTargetTriangleRatio === undefined ? {} : { targetTriangleRatio: request.simplifyTargetTriangleRatio }),
    });
    if (!result.outputIndices || result.outputIndices.length === 0) {
      // 空图元/全退化:贡献为空;其余图元的产出决定成败。
      if (result.status !== "ok") reasons.push(`${result.status}:${primitive.primitiveId}`);
      continue;
    }
    if (result.status !== "ok") reasons.push(`${result.status}:${primitive.primitiveId}`);
    if (result.simplifierErrorAbsolute !== null) {
      simplifierErrorAbsolute = Math.max(simplifierErrorAbsolute ?? 0, result.simplifierErrorAbsolute);
    }
    const vertexBase = positions.length;
    const input = primitive.positions;
    const matrix = primitive.transform;
    for (let offset = 0; offset < input.length; offset += 3) {
      const point = matrix
        ? applyTransform(matrix, [input[offset]!, input[offset + 1]!, input[offset + 2]!])
        : ([input[offset]!, input[offset + 1]!, input[offset + 2]!] as [number, number, number]);
      positions.push(point);
    }
    for (const index of result.outputIndices) indices.push(vertexBase + index);
    triangleCount += result.outputIndices.length / 3;
  }
  if (triangleCount === 0) {
    return { status: "failed", approximate: true,
      reasons: reasons.length ? reasons : ["simplified-mesh produced no triangles"],
      tolerance, simplifierErrorAbsolute };
  }
  return {
    status: reasons.length ? "approximate" : "ok",
    approximate: reasons.length > 0,
    reasons,
    positions, indices, triangleCount, tolerance, simplifierErrorAbsolute,
  };
}

// ---------------------------------------------------------------------------
// GLB 适配器:只读输入文件,primitiveId 与 T12 拓扑/简化一致(mesh:i/primitive:j)。
// ---------------------------------------------------------------------------

export async function generatePhysicsColliderFromGlb(
  filePath: string,
  request: PhysicsColliderSourceRequest,
): Promise<PhysicsColliderSourceResult> {
  const io = await glbIo();
  const document = await io.read(filePath);
  const meshes = document.getRoot().listMeshes();
  const primitives: ColliderMeshPrimitive[] = [];
  let skipped = 0;
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
    const meshPrimitives = meshes[meshIndex]!.listPrimitives();
    for (let primitiveIndex = 0; primitiveIndex < meshPrimitives.length; primitiveIndex += 1) {
      const primitive = meshPrimitives[primitiveIndex]!;
      const positionAccessor = primitive.getAttribute("POSITION");
      if (!positionAccessor || primitive.getMode() !== 4) { skipped += 1; continue; }
      primitives.push({
        primitiveId: `mesh:${meshIndex}/primitive:${primitiveIndex}`,
        positions: decodeVec3Attribute(positionAccessor),
        indices: primitive.getIndices()
          ? decodeScalarIndices(primitive.getIndices()!)
          : sequence(positionAccessor.getCount()),
      });
    }
  }
  const result = await generatePhysicsCollider(primitives, request);
  result.skippedNonTrianglePrimitives = skipped;
  return result;
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
