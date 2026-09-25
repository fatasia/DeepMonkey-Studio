import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";

/**
 * 第 3 条权威路径:CPU 拾取查询核心。纯 TS、零依赖、同步执行。
 *
 * 边界声明(诚实契约,宿主必须向上透传):
 * - 复杂度 O(实例数 × 每实例三角形数) 线性遍历,无 BVH/空间加速;十万级三角形的
 *   单次拾取在毫秒到数十毫秒级。拾取是点击时操作,不进渲染热路径。
 * - LOD 批次在 GPU 侧按屏幕空间选层绘制,本查询恒测批次自身几何(最细层)。
 * - 变形(skinning/morph)实例按打包时的基础姿态拾取;宿主以 degradedNotes 声明。
 * - 流送驻留投影中未驻留的几何被跳过并上报 degraded,绝不编造命中。
 * - 标识现状:instanceId 为包内 RenderInstance.id,geometryId 为 GeometryResource.id;
 *   节点级身份经 PickSceneView.objectBindings(运行包顶层映射)透出为 PickHit.nodeId,
 *   缺映射时以 degraded 显式声明降级,绝不编造节点身份。
 * - 结果与 contracts ScenePickingHit 形状兼容(objectId↔instanceId/nodeId, point, distance)。
 */

/** 单次拾取命中。normal 为命中三角形几何法线(世界坐标、已归一化、不按视线侧翻转)。 */
export interface PickHit {
  readonly geometryId: string;
  readonly instanceId: string;
  /**
   * 命中实例所属的作者场景节点(仅当场景视图带节点映射时存在)。
   * 多对一:同一节点的多个实例命中各自携带同一 nodeId;辅助网格等未映射实例没有该字段。
   */
  readonly nodeId?: string;
  /** 视点到命中点的距离,世界单位(方向已归一化)。 */
  readonly distance: number;
  readonly point: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  /** 命中三角形序号(indices 偏移 / 3)。 */
  readonly triangle: number;
}

export interface PickOptions {
  /** 默认 0。 */
  readonly minDistance?: number;
  /** 默认 Infinity。 */
  readonly maxDistance?: number;
  /** 返回前 N 个命中(距离升序截断);默认全部。 */
  readonly maxHits?: number;
}

/** 拾取的当前发布场景视图,与 PacketBuffers.visibilityInputs() 同形。 */
export interface PickSceneView {
  readonly batches: ReadonlyMap<string, CachedPacketBatch>;
  readonly geometries: ReadonlyMap<string, CachedPacketGeometry>;
  /**
   * 节点级拾取映射(运行包顶层 objectBindings 的透传):instanceId → 作者节点。
   * 缺省(旧包/未接线)时命中只到 instanceId 级,并以 degraded 显式声明,不冒充节点身份。
   */
  readonly objectBindings?: readonly { readonly nodeId: string; readonly instanceIds: readonly string[] }[];
  /** 宿主已知会降低命中精度的事实(如变形基础姿态);原样并入 degraded。 */
  readonly degradedNotes?: readonly string[];
}

export type PickResult =
  | { readonly available: true; readonly hits: readonly PickHit[];
    /** 命中精度受限的环境事实;存在时必非空。 */
    readonly degraded?: readonly string[] }
  | { readonly available: false; readonly reason: string };

/** 不可用结果的统一措辞;宿主按 diagnostics/degraded 语义原样透传,不抛糊错。 */
export function pickingUnavailable(reason: string): PickResult {
  return { available: false, reason: `picking unavailable: ${reason}` };
}

/**
 * 校验并归一化拾取射线。输入契约违例属调用方错误,按仓库惯例抛精确错误;
 * 环境不可用(未上传/已释放)才走 PickResult 的 unavailable 分支。
 */
export function normalizePickRay(origin: ArrayLike<number>, direction: ArrayLike<number>): {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
} {
  if (origin.length !== 3 || !finiteTriple(origin)) {
    throw new Error("Pick ray origin must contain three finite numbers.");
  }
  if (direction.length !== 3 || !finiteTriple(direction)) {
    throw new Error("Pick ray direction must contain three finite numbers.");
  }
  const length = Math.hypot(direction[0]!, direction[1]!, direction[2]!);
  if (length === 0) throw new Error("Pick ray direction must be nonzero.");
  return { origin: [origin[0]!, origin[1]!, origin[2]!],
    direction: [direction[0]! / length, direction[1]! / length, direction[2]! / length] };
}

/** packInstanceBatches 的实例行宽;[0..11] 世界变换行主序 3x4,[12..23] 法线矩阵,[24..35] 材质。 */
const INSTANCE_ROW_FLOATS = 36;
/** 低于该值按平行射线或退化三角形处理(f64 数学,场景数值为 float32 量级)。 */
const PARALLEL_EPSILON = 1e-12;

/** 对当前发布场景做线性拾取,命中按距离升序。空场景(已发布、零实例)返回空命中,不是不可用。 */
export function pickScene(scene: PickSceneView, origin: ArrayLike<number>, direction: ArrayLike<number>,
  options: PickOptions = {}): PickResult {
  const ray = normalizePickRay(origin, direction);
  const minDistance = options.minDistance ?? 0;
  const maxDistance = options.maxDistance ?? Number.POSITIVE_INFINITY;
  const maxHits = options.maxHits ?? Number.POSITIVE_INFINITY;
  if (!(minDistance >= 0) || !(maxDistance >= minDistance)) {
    throw new Error("Pick distance range must satisfy 0 <= minDistance <= maxDistance.");
  }
  if (!(maxHits >= 1)) throw new Error("Pick maxHits must be at least 1.");
  // 逐 pick 复用的暂存;同步单线程,热循环内零分配。
  const matrix = new Float64Array(9), inverse = new Float64Array(9);
  const localOrigin = new Float64Array(3), localDirection = new Float64Array(3);
  const faceNormal = new Float64Array(3);
  const hits: PickHit[] = [];
  const degraded = new Set<string>(scene.degradedNotes ?? []);
  // 节点映射仅构建一次;instanceId→nodeId 多对一。矛盾映射属调用方契约违例,抛精确错误。
  let nodes: Map<string, string> | undefined;
  if (scene.objectBindings === undefined) {
    degraded.add("node-mapping-unavailable:hits-report-instance-ids-only");
  } else {
    nodes = new Map();
    for (const binding of scene.objectBindings) {
      if (binding.nodeId.length === 0) throw new Error("Object binding node id must be non-empty.");
      for (const instanceId of binding.instanceIds) {
        if (instanceId.length === 0) throw new Error("Object binding instance id must be non-empty.");
        const previous = nodes.get(instanceId);
        if (previous !== undefined && previous !== binding.nodeId) {
          throw new Error(`Object binding maps instance ${instanceId} to conflicting nodes.`);
        }
        nodes.set(instanceId, binding.nodeId);
      }
    }
  }
  for (const batch of scene.batches.values()) {
    const geometry = scene.geometries.get(batch.source.geometry);
    if (geometry === undefined) {
      degraded.add(`geometry-not-resident:${batch.source.geometry}`);
      continue;
    }
    const source = batch.source, ids = source.instanceIds;
    const cullBackface = source.doubleSided !== true;
    for (let row = 0; row < source.count; row++) {
      const instanceId = ids[row];
      // instanceIds 与数据行一一对应是 packInstanceBatches 的合同;违约时如实上报并停在该批次。
      if (instanceId === undefined) { degraded.add("instance-identity-missing"); break; }
      pickInstanceRow(hits, batch, geometry, row, instanceId, nodes?.get(instanceId), cullBackface, ray,
        minDistance, maxDistance, matrix, inverse, localOrigin, localDirection, faceNormal);
    }
  }
  hits.sort((a, b) => a.distance - b.distance);
  return { available: true, hits: hits.slice(0, maxHits),
    ...(degraded.size ? { degraded: [...degraded].sort() } : {}) };
}

function pickInstanceRow(hits: PickHit[], batch: CachedPacketBatch,
  geometry: CachedPacketGeometry, row: number, instanceId: string, nodeId: string | undefined,
  cullBackface: boolean, ray: ReturnType<typeof normalizePickRay>, minDistance: number, maxDistance: number,
  matrix: Float64Array, inverse: Float64Array, localOrigin: Float64Array, localDirection: Float64Array,
  faceNormal: Float64Array): void {
  const data = batch.source.data, base = row * INSTANCE_ROW_FLOATS;
  // packTransform 布局:packed[0..3] 为世界矩阵第 0 行(基向量 x 分量 + tx),依此类推。
  setRowMajor3x3(matrix, data, base);
  const determinant = invertRowMajor3x3(inverse, matrix);
  if (determinant === 0) return; // packTransform 拒绝奇异矩阵;此分支仅为防御,不产生命中。
  transformByInverse(localOrigin, inverse, ray.origin[0] - data[base + 3]!,
    ray.origin[1] - data[base + 7]!, ray.origin[2] - data[base + 11]!);
  transformByInverse(localDirection, inverse, ray.direction[0], ray.direction[1], ray.direction[2]);
  const { id, vertices, indices } = geometry.source;
  // 射线经 M⁻¹(仿射逆,方向不归一化)变换后,交点参数 t 与世界距离等价。
  for (let triangle = 0; triangle + 2 < indices.length; triangle += 3) {
    const distance = rayTriangle(localOrigin, localDirection, vertices, indices, triangle,
      cullBackface, determinant, faceNormal);
    if (distance === undefined || distance < minDistance || distance > maxDistance) continue;
    hits.push({ geometryId: id, instanceId, ...(nodeId === undefined ? {} : { nodeId }), distance,
      point: [ray.origin[0] + distance * ray.direction[0],
        ray.origin[1] + distance * ray.direction[1], ray.origin[2] + distance * ray.direction[2]],
      normal: normalizedFaceNormal(inverse, faceNormal), triangle: triangle / 3 });
  }
}

/**
 * Möller–Trumbore,局部空间。cullBackface 时仅接受正面:
 * 世界几何法线 = det·M⁻ᵀ·n_local,故 front ⇔ detT·det > 0;镜像实例(det<0)判定随 det 翻转。
 * faceNormal 写出局部几何法线(e1×e2,未归一化);返回世界距离 t,未命中返回 undefined。
 */
function rayTriangle(origin: Float64Array, direction: Float64Array, vertices: Float32Array,
  indices: Uint32Array, triangle: number, cullBackface: boolean, determinant: number,
  faceNormal: Float64Array): number | undefined {
  const v0 = indices[triangle]! * 6, v1 = indices[triangle + 1]! * 6, v2 = indices[triangle + 2]! * 6;
  const e1x = vertices[v1]! - vertices[v0]!, e1y = vertices[v1 + 1]! - vertices[v0 + 1]!,
    e1z = vertices[v1 + 2]! - vertices[v0 + 2]!;
  const e2x = vertices[v2]! - vertices[v0]!, e2y = vertices[v2 + 1]! - vertices[v0 + 1]!,
    e2z = vertices[v2 + 2]! - vertices[v0 + 2]!;
  const px = direction[1]! * e2z - direction[2]! * e2y;
  const py = direction[2]! * e2x - direction[0]! * e2z;
  const pz = direction[0]! * e2y - direction[1]! * e2x;
  const detT = e1x * px + e1y * py + e1z * pz;
  if (cullBackface ? detT * determinant <= PARALLEL_EPSILON : Math.abs(detT) < PARALLEL_EPSILON) return undefined;
  const invDet = 1 / detT;
  const sx = origin[0]! - vertices[v0]!, sy = origin[1]! - vertices[v0 + 1]!, sz = origin[2]! - vertices[v0 + 2]!;
  const u = (sx * px + sy * py + sz * pz) * invDet;
  if (u < 0 || u > 1) return undefined;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (direction[0]! * qx + direction[1]! * qy + direction[2]! * qz) * invDet;
  if (v < 0 || u + v > 1) return undefined;
  const distance = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  if (distance <= 0) return undefined;
  faceNormal[0] = e1y * e2z - e1z * e2y;
  faceNormal[1] = e1z * e2x - e1x * e2z;
  faceNormal[2] = e1x * e2y - e1y * e2x;
  return distance;
}

/** 世界几何法线 = M⁻ᵀ·n_local(与 packTransform 上传的法线矩阵同口径),归一化后返回。 */
function normalizedFaceNormal(inverse: Float64Array, localNormal: Float64Array): readonly [number, number, number] {
  // M⁻ᵀ·n 的第 i 分量 = M⁻¹ 第 i 列与 n 的点积(行主序存储,即跨步取 inverse[i + 3j])。
  const x = inverse[0]! * localNormal[0]! + inverse[3]! * localNormal[1]! + inverse[6]! * localNormal[2]!;
  const y = inverse[1]! * localNormal[0]! + inverse[4]! * localNormal[1]! + inverse[7]! * localNormal[2]!;
  const z = inverse[2]! * localNormal[0]! + inverse[5]! * localNormal[1]! + inverse[8]! * localNormal[2]!;
  const length = Math.hypot(x, y, z);
  return length === 0 ? [0, 0, 0] : [x / length, y / length, z / length];
}

function setRowMajor3x3(matrix: Float64Array, data: Float32Array, base: number): void {
  matrix[0] = data[base]!; matrix[1] = data[base + 1]!; matrix[2] = data[base + 2]!;
  matrix[3] = data[base + 4]!; matrix[4] = data[base + 5]!; matrix[5] = data[base + 6]!;
  matrix[6] = data[base + 8]!; matrix[7] = data[base + 9]!; matrix[8] = data[base + 10]!;
}

/** 原地行主序 3x3 求逆(伴随/行列式法);奇异返回 0 且不写 output。 */
function invertRowMajor3x3(output: Float64Array, m: Float64Array): number {
  const det = m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!)
    - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!)
    + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
  if (!Number.isFinite(det) || det === 0) return 0;
  const invDet = 1 / det;
  output[0] = (m[4]! * m[8]! - m[5]! * m[7]!) * invDet;
  output[1] = (m[2]! * m[7]! - m[1]! * m[8]!) * invDet;
  output[2] = (m[1]! * m[5]! - m[2]! * m[4]!) * invDet;
  output[3] = (m[5]! * m[6]! - m[3]! * m[8]!) * invDet;
  output[4] = (m[0]! * m[8]! - m[2]! * m[6]!) * invDet;
  output[5] = (m[2]! * m[3]! - m[0]! * m[5]!) * invDet;
  output[6] = (m[3]! * m[7]! - m[4]! * m[6]!) * invDet;
  output[7] = (m[1]! * m[6]! - m[0]! * m[7]!) * invDet;
  output[8] = (m[0]! * m[4]! - m[1]! * m[3]!) * invDet;
  return det;
}

/** out = M⁻¹·p;M⁻¹ 为行主序,即 out_i = Σ_j inverse[i·3+j]·p_j。 */
function transformByInverse(out: Float64Array, inverse: Float64Array,
  x: number, y: number, z: number): void {
  out[0] = inverse[0]! * x + inverse[1]! * y + inverse[2]! * z;
  out[1] = inverse[3]! * x + inverse[4]! * y + inverse[5]! * z;
  out[2] = inverse[6]! * x + inverse[7]! * y + inverse[8]! * z;
}

function finiteTriple(value: ArrayLike<number>): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
}
