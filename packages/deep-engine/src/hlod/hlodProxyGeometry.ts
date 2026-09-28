/**
 * T26 簇级代理几何生成(纯 CPU,零依赖,逐位确定)。
 *
 * == 算法(盒簇合并,预算硬约束) ==
 * 1. 输入摘要按 (minX,minY,minZ,maxX,maxY,maxZ,instanceId) 规范序——与输入数组
 *    顺序无关的确定性基准;实例盒 → 工作盒。
 * 2. 实例数 ≤ 盒预算:逐实例原样出盒(零合并,代理 = 摘要的精确盒表达)。
 * 3. 超预算:链表 + 二叉堆的**相邻对贪心合并**——候选对限规范序相邻盒(合并代价
 *    O(n log n),万级簇可用),代价 = 并盒体积 − 两盒体积(浪费体积最小优先;
 *    并列按 (左盒序,右盒序) 裁决,序 = 初始规范秩/合并递增计数);合并体挂左位,
 *    失效对经版本号惰性删除。直到盒数 = 预算。这是质量近似而非最优解(诚实条款:
 *    相邻对限定的贪心不保证全局最小浪费)。
 * 4. 发射:每盒 6 面 × 4 顶点(stride-6 位置+外法线)+ 36 索引,与
 *    `packetBoundsHlod` 盒代理同约定;终盒按角点键重排(与合并时序解耦)。
 *
 * == 确定性合同(algorithmVersion = "t26-hlod-proxy-v1") ==
 * 同摘要集 + 同选项 → 逐位同网格:规范序全序(instanceId 唯一封底)、堆比较器
 * 全序、无随机无时钟;Float32 转换舍入同引擎确定。跨引擎 ULP 差异不在合同内
 * (同 T13/T26 第一切片诚实条款)。体积乘积溢出 fail-closed(不产 NaN 几何)。
 */

import { HlodError } from "./hlodTypes.js";
import {
  HLOD_PROXY_ALGORITHM_VERSION,
  HLOD_PROXY_DEFAULTS,
  type HlodInstanceShape,
  type HlodProxyBudgetEvidence,
  type HlodProxyConfiguration,
  type HlodProxyMesh,
  type HlodProxyOptions,
  type HlodProxyResult,
} from "./hlodProxyTypes.js";

const TRIANGLES_PER_BOX = 12;

export function resolveHlodProxyOptions(options: HlodProxyOptions = {}): HlodProxyConfiguration {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new HlodError("invalid-options", "HLOD proxy options must be an object.");
  }
  const maxProxyTriangles = options.maxProxyTriangles ?? HLOD_PROXY_DEFAULTS.maxProxyTriangles;
  const metricInstanceSampleLimit =
    options.metricInstanceSampleLimit ?? HLOD_PROXY_DEFAULTS.metricInstanceSampleLimit;
  const metricEvalBudget = options.metricEvalBudget ?? HLOD_PROXY_DEFAULTS.metricEvalBudget;
  if (!Number.isSafeInteger(maxProxyTriangles) || maxProxyTriangles < 12 || maxProxyTriangles > 24576) {
    throw new HlodError("invalid-options", "HLOD maxProxyTriangles must be an integer in [12, 24576].");
  }
  if (!Number.isSafeInteger(metricInstanceSampleLimit) || metricInstanceSampleLimit < 1) {
    throw new HlodError("invalid-options", "HLOD metricInstanceSampleLimit must be a positive integer.");
  }
  if (!Number.isSafeInteger(metricEvalBudget) || metricEvalBudget < 1) {
    throw new HlodError("invalid-options", "HLOD metricEvalBudget must be a positive integer.");
  }
  const effectiveTriangleBudget = Math.max(TRIANGLES_PER_BOX, Math.floor(maxProxyTriangles / TRIANGLES_PER_BOX) * TRIANGLES_PER_BOX);
  return Object.freeze({
    maxProxyTriangles,
    proxyBoxBudget: effectiveTriangleBudget / TRIANGLES_PER_BOX,
    metricInstanceSampleLimit,
    metricEvalBudget,
  });
}

/** 校验并以规范序返回摘要;唯一性与数值合法性 fail-closed。 */
export function validateHlodShapes(shapes: readonly HlodInstanceShape[]): readonly HlodInstanceShape[] {
  if (!Array.isArray(shapes)) throw new HlodError("invalid-shape", "HLOD instance shapes must be an array.");
  const byId = new Map<string, HlodInstanceShape>();
  for (const shape of shapes) {
    if (!shape || typeof shape !== "object" || typeof shape.instanceId !== "string" || shape.instanceId.length === 0) {
      throw new HlodError("invalid-shape", "HLOD instance shape id must be a non-empty string.");
    }
    if (byId.has(shape.instanceId)) {
      throw new HlodError("duplicate-instance-id", `Duplicate HLOD instance shape id: ${shape.instanceId}.`);
    }
    for (const bounds of [shape.min, shape.max]) {
      if (!Array.isArray(bounds) || bounds.length !== 3 || !bounds.every(Number.isFinite)) {
        throw new HlodError("invalid-shape", `HLOD instance shape ${shape.instanceId} bounds must be 3 finite numbers.`);
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      if (shape.min[axis]! > shape.max[axis]!) {
        throw new HlodError("invalid-shape", `HLOD instance shape ${shape.instanceId} min must not exceed max.`);
      }
    }
    byId.set(shape.instanceId, shape);
  }
  return Object.freeze([...byId.values()].sort(compareShape));
}

/** 摘要规范序:角点键字典序,instanceId 封底(唯一 → 全序)。 */
export function compareShape(left: HlodInstanceShape, right: HlodInstanceShape): number {
  const leftKey = [left.min[0], left.min[1], left.min[2], left.max[0], left.max[1], left.max[2]] as const;
  const rightKey = [right.min[0], right.min[1], right.min[2], right.max[0], right.max[1], right.max[2]] as const;
  for (let axis = 0; axis < 6; axis++) {
    if (leftKey[axis] !== rightKey[axis]) return leftKey[axis]! - rightKey[axis]!;
  }
  return left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0;
}

/**
 * 簇代理生成入口:摘要集 → 预算受控的低面代理网格。
 * `nodeId` 仅随结果回传供批层关联(生成本身是摘要集的纯函数)。
 */
export function generateClusterProxyGeometry(shapes: readonly HlodInstanceShape[],
  options: HlodProxyOptions = {}): HlodProxyResult {
  const config = resolveHlodProxyOptions(options);
  const ordered = validateHlodShapes(shapes);
  if (ordered.length === 0) {
    throw new HlodError("invalid-shape", "HLOD proxy generation requires at least one instance shape.");
  }
  const work = ordered.map((shape, index) => ({
    minX: shape.min[0]!, minY: shape.min[1]!, minZ: shape.min[2]!,
    maxX: shape.max[0]!, maxY: shape.max[1]!, maxZ: shape.max[2]!, seq: index,
  }));
  const merged = work.length > config.proxyBoxBudget;
  const boxes = merged ? mergeBoxesToBudget(work, config.proxyBoxBudget) : work;
  boxes.sort(compareWorkBox);
  return Object.freeze({
    algorithmVersion: HLOD_PROXY_ALGORITHM_VERSION,
    mesh: emitBoxMesh(boxes),
    budget: Object.freeze({
      maxProxyTriangles: config.maxProxyTriangles,
      effectiveTriangleBudget: config.proxyBoxBudget * TRIANGLES_PER_BOX,
      inputShapeCount: ordered.length,
      merged,
    }),
  });
}

interface WorkBox {
  readonly minX: number; readonly minY: number; readonly minZ: number;
  readonly maxX: number; readonly maxY: number; readonly maxZ: number;
  /** 身序:初始 = 规范秩;合并体 = 递增计数(堆并列裁决)。 */
  readonly seq: number;
}

function compareWorkBox(left: WorkBox, right: WorkBox): number {
  const leftKey = [left.minX, left.minY, left.minZ, left.maxX, left.maxY, left.maxZ] as const;
  const rightKey = [right.minX, right.minY, right.minZ, right.maxX, right.maxY, right.maxZ] as const;
  for (let axis = 0; axis < 6; axis++) {
    if (leftKey[axis] !== rightKey[axis]) return leftKey[axis]! - rightKey[axis]!;
  }
  return left.seq - right.seq;
}

function boxVolume(box: WorkBox): number {
  const value = (box.maxX - box.minX) * (box.maxY - box.minY) * (box.maxZ - box.minZ);
  if (!Number.isFinite(value)) {
    throw new HlodError("invalid-shape", "HLOD proxy box volume overflows finite representation.");
  }
  return value;
}

/**
 * 相邻对贪心合并到预算盒数(见模块头注释)。链表槽位 + 二叉堆(代价,左序,右序),
 * 版本号惰性失效;预算必 ≥1 且 < n(调用方保证)。
 */
function mergeBoxesToBudget(boxes: WorkBox[], budget: number): WorkBox[] {
  const n = boxes.length;
  const slot: WorkBox[] = boxes.slice();
  const prev = new Int32Array(n).fill(-1);
  const next = new Int32Array(n).fill(-1);
  const alive = new Uint8Array(n).fill(1);
  const version = new Int32Array(n);
  for (let i = 0; i + 1 < n; i++) next[i] = i + 1;
  for (let i = 1; i < n; i++) prev[i] = i - 1;
  let aliveCount = n;
  let nextSeq = n;
  const heap: MergeEntry[] = [];
  const pushPair = (left: number, right: number): void => {
    const a = slot[left]!, b = slot[right]!;
    const union = boxVolume({
      minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), minZ: Math.min(a.minZ, b.minZ),
      maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), maxZ: Math.max(a.maxZ, b.maxZ), seq: -1,
    });
    heapPush(heap, { cost: union - boxVolume(a) - boxVolume(b), leftSeq: a.seq, rightSeq: b.seq,
      left, leftVersion: version[left]!, right, rightVersion: version[right]! });
  };
  for (let i = 0; i + 1 < n; i++) pushPair(i, i + 1);
  while (aliveCount > budget) {
    const entry = heapShift(heap);
    if (!entry) break; // 结构上不可达(存活 >1 必有合法相邻对);防御性退出。
    if (!alive[entry.left] || !alive[entry.right]
      || version[entry.left] !== entry.leftVersion || version[entry.right] !== entry.rightVersion) continue;
    const a = slot[entry.left]!, b = slot[entry.right]!;
    slot[entry.left] = {
      minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), minZ: Math.min(a.minZ, b.minZ),
      maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), maxZ: Math.max(a.maxZ, b.maxZ),
      seq: nextSeq++,
    };
    alive[entry.right] = 0;
    version[entry.left] = version[entry.left]! + 1;
    version[entry.right] = version[entry.right]! + 1;
    const predecessor = prev[entry.left]!, successor = next[entry.right]!;
    next[entry.left] = successor;
    if (successor >= 0) prev[successor] = entry.left;
    aliveCount -= 1;
    if (predecessor >= 0) pushPair(predecessor, entry.left);
    if (successor >= 0) pushPair(entry.left, successor);
  }
  const result: WorkBox[] = [];
  let cursor = 0;
  while (cursor >= 0) {
    if (alive[cursor]) result.push(slot[cursor]!);
    cursor = next[cursor]!;
  }
  return result;
}

interface MergeEntry {
  readonly cost: number; readonly leftSeq: number; readonly rightSeq: number;
  readonly left: number; readonly leftVersion: number; readonly right: number; readonly rightVersion: number;
}

function entryLess(a: MergeEntry, b: MergeEntry): boolean {
  if (a.cost !== b.cost) return a.cost < b.cost;
  if (a.leftSeq !== b.leftSeq) return a.leftSeq < b.leftSeq;
  return a.rightSeq < b.rightSeq;
}

function heapPush(heap: MergeEntry[], entry: MergeEntry): void {
  heap.push(entry);
  let child = heap.length - 1;
  while (child > 0) {
    const parent = (child - 1) >> 1;
    if (!entryLess(heap[child]!, heap[parent]!)) break;
    [heap[parent], heap[child]] = [heap[child]!, heap[parent]!];
    child = parent;
  }
}

function heapShift(heap: MergeEntry[]): MergeEntry | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length === 0) return top;
  heap[0] = last!;
  let parent = 0;
  for (;;) {
    const left = parent * 2 + 1, right = left + 1;
    let best = parent;
    if (left < heap.length && entryLess(heap[left]!, heap[best]!)) best = left;
    if (right < heap.length && entryLess(heap[right]!, heap[best]!)) best = right;
    if (best === parent) break;
    [heap[parent], heap[best]] = [heap[best]!, heap[parent]!];
    parent = best;
  }
  return top;
}

/** 盒 → 网格:6 面 × 4 顶点(外法线,从外看 CCW)+ 36 索引;与 packetBoundsHlod 同约定。 */
function emitBoxMesh(boxes: readonly WorkBox[]): HlodProxyMesh {
  const vertices = new Float32Array(boxes.length * 24 * 6);
  const indices = new Uint32Array(boxes.length * 36);
  for (const [boxIndex, box] of boxes.entries()) {
    const base = boxIndex * 24;
    emitFace(vertices, base + 0, [1, 0, 0], [
      [box.maxX, box.minY, box.maxZ], [box.maxX, box.minY, box.minZ],
      [box.maxX, box.maxY, box.minZ], [box.maxX, box.maxY, box.maxZ]]);
    emitFace(vertices, base + 4, [-1, 0, 0], [
      [box.minX, box.minY, box.minZ], [box.minX, box.minY, box.maxZ],
      [box.minX, box.maxY, box.maxZ], [box.minX, box.maxY, box.minZ]]);
    emitFace(vertices, base + 8, [0, 1, 0], [
      [box.minX, box.maxY, box.maxZ], [box.maxX, box.maxY, box.maxZ],
      [box.maxX, box.maxY, box.minZ], [box.minX, box.maxY, box.minZ]]);
    emitFace(vertices, base + 12, [0, -1, 0], [
      [box.minX, box.minY, box.minZ], [box.maxX, box.minY, box.minZ],
      [box.maxX, box.minY, box.maxZ], [box.minX, box.minY, box.maxZ]]);
    emitFace(vertices, base + 16, [0, 0, 1], [
      [box.minX, box.minY, box.maxZ], [box.maxX, box.minY, box.maxZ],
      [box.maxX, box.maxY, box.maxZ], [box.minX, box.maxY, box.maxZ]]);
    emitFace(vertices, base + 20, [0, 0, -1], [
      [box.maxX, box.minY, box.minZ], [box.minX, box.minY, box.minZ],
      [box.minX, box.maxY, box.minZ], [box.maxX, box.maxY, box.minZ]]);
    const indexBase = boxIndex * 36;
    for (let face = 0; face < 6; face++) {
      const first = base + face * 4, out = indexBase + face * 6;
      indices[out] = first; indices[out + 1] = first + 1; indices[out + 2] = first + 2;
      indices[out + 3] = first; indices[out + 4] = first + 2; indices[out + 5] = first + 3;
    }
  }
  return Object.freeze({
    vertices, indices,
    triangleCount: indices.length / 3,
    boxCount: boxes.length,
  });
}

type Vec3 = readonly [number, number, number];

function emitFace(vertices: Float32Array, vertexBase: number, normal: Vec3,
  corners: readonly (readonly [number, number, number])[]): void {
  for (const [cornerIndex, corner] of corners.entries()) {
    const offset = (vertexBase + cornerIndex) * 6;
    vertices[offset] = corner[0]; vertices[offset + 1] = corner[1]; vertices[offset + 2] = corner[2];
    vertices[offset + 3] = normal[0]; vertices[offset + 4] = normal[1]; vertices[offset + 5] = normal[2];
  }
}
