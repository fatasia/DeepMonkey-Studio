/**
 * RayBackend WGSL compute 软件执行器内核发射（波次4）：`ray_trace_batch`。
 * 对标 UE 硬件光追的软件等效——Web 端唯一 RT 路径；数值语义以 CPU 参考实现
 * （bvhBuilder.intersectTriangle / rayTrace.traceClosest）为仲裁基准：
 *
 * == 语义合同 ==
 * 1. 遍历：栈式 closest-hit，先弹 leftFirst 后弹 rightChild（与 CPU push(right,left) 的
 *    LIFO 弹出顺序一致）；slab 测试与 CPU overlapsBounds 同构——平行轴（dir 分量恒等 0）
 *    只测起点在 slab 内，避免 0×Inf=NaN 剪掉整棵子树；内部节点 exit 上界用当前 bestT
 *    收紧，与 CPU 逐节点重算 entry/exit 同语义。
 * 2. 相交：Möller–Trumbore，运算次序与 CPU 逐行对应（cross/dot 分量展开次序一致），
 *    行列式阈值 |det| < 1e-20、拒绝域 u∈[0,1]/v≥0/u+v≤1、t 可为负起点之后的正值均一致；
 *    f32 与 JS f64 的舍入差由 API 级对拍容差（t 相对 1e-5，primitiveIndex 精确）吸收。
 * 3. 栈：固定深度 RAY_TRACE_STACK_CAPACITY=32。中位分裂最坏深度
 *    ≤ ceil(log2(RAY_BACKEND_LIMITS.maxBlasTriangles)) = 22 < 32，正常输入不可达；
 *    超限 fail-closed：atomicAdd 全局哨兵 stackOverflows、本射线记 STATUS_OVERFLOW、
 *    丢弃命中（不得静默截断遍历继续采信结果）；执行器见到非零哨兵即整批拒绝。
 * 4. 布局：buffer 字节映射见 rayTraceLayout.ts 头注释（BvhNode stride 48B 等）。
 * 5. 写出：每射线恒写一条 HitRecord（miss 时 t=-1/primitiveIndex=SENTINEL/status=0）；
 *    越界 lane（rayIndex ≥ rayCount）在读写前返回，不触 buffer。
 *
 * == 两级扩展（TLAS 实例层） ==
 * `emitTwoLevelRayTraceKernelWgsl` 发射 `ray_trace_tlas_batch`，复用本模块导出的
 * WGSL_CORE/WGSL_HELPERS 共享片段（旧单级发射文本逐字节不变，由 rayTraceTlasKernel.test
 * 的 sha256 合同钉死；有意变更任一内核必须同步更新钉值并复核另一内核语义）。实现位于
 * rayTraceTlasKernel.ts（300 行体量门禁：两级遍历为独立职责单独成文件）；两级专属布局
 * 合同见 tlasLayout.ts，遍历/t 缩放语义以 tlas.ts traceTlasClosest 为仲裁基准。
 */

import { BVH_LEAF_SENTINEL, RAY_TRACE_STACK_CAPACITY, RAY_TRACE_WORKGROUP_SIZE } from "./rayTraceLayout.js";

export const RAY_TRACE_ENTRY_POINT = "ray_trace_batch";

/** WGSL binding 槽位合同（rayTraceExecutor 的 bindGroup 顺序必须逐项对应）。 */
export const RAY_TRACE_BINDINGS = Object.freeze([
  { binding: 0, name: "bvhNodes", type: "read-only-storage" },
  { binding: 1, name: "vertices", type: "read-only-storage" },
  { binding: 2, name: "indices", type: "read-only-storage" },
  { binding: 3, name: "triangleOrder", type: "read-only-storage" },
  { binding: 4, name: "rayStream", type: "read-only-storage" },
  { binding: 5, name: "hitRecords", type: "storage" },
  { binding: 6, name: "stackOverflows", type: "storage" },
  { binding: 7, name: "params", type: "uniform" },
] as const);

// —— 单级/两级共享片段：改任一片段即同时改变两个内核（sha256 合同钉死保护）。 ——
export const WGSL_CORE = /* wgsl */ `const STACK_CAPACITY: u32 = ${RAY_TRACE_STACK_CAPACITY}u;
const SENTINEL: u32 = ${BVH_LEAF_SENTINEL}u;
const STATUS_MISS: u32 = 0u;
const STATUS_HIT: u32 = 1u;
const STATUS_OVERFLOW: u32 = 2u;
const DET_EPSILON: f32 = 1e-20;

struct BvhNode {
  boundMin: vec4f,
  boundMax: vec4f,
  leftFirst: u32,
  count: u32,
  rightChild: u32,
  pad0: u32,
}
struct HitRecord {
  t: f32,
  primitiveIndex: u32,
  status: u32,
  pad0: u32,
}
`;
export const WGSL_HELPERS = /* wgsl */ `fn fetchVertex(index: u32) -> vec3f {
  let base = index * 3u;
  return vec3f(vertices[base], vertices[base + 1u], vertices[base + 2u]);
}

// Möller–Trumbore; operation order mirrors bvhBuilder.intersectTriangle line by line.
fn intersectTriangle(origin: vec3f, dir: vec3f, prim: u32) -> f32 {
  let v0 = fetchVertex(indices[prim * 3u]);
  let e1 = fetchVertex(indices[prim * 3u + 1u]) - v0;
  let e2 = fetchVertex(indices[prim * 3u + 2u]) - v0;
  let p = cross(dir, e2);
  let det = dot(e1, p);
  if (abs(det) < DET_EPSILON) { return -1.0; }
  let inv = 1.0 / det;
  let tv = origin - v0;
  let u = dot(tv, p) * inv;
  if (u < 0.0 || u > 1.0) { return -1.0; }
  let q = cross(tv, e1);
  let v = dot(dir, q) * inv;
  if (v < 0.0 || u + v > 1.0) { return -1.0; }
  return dot(e2, q) * inv;
}

// Slab test; mirrors rayTrace.overlapsBounds: parallel axis requires origin inside the slab.
fn slabOverlaps(origin: f32, dir: f32, inv: f32, lo: f32, hi: f32,
  entry: ptr<function, f32>, exit: ptr<function, f32>) -> bool {
  if (dir != 0.0) {
    var tNear = (lo - origin) * inv;
    var tFar = (hi - origin) * inv;
    if (tNear > tFar) { let swap = tNear; tNear = tFar; tFar = swap; }
    if (tNear > *entry) { *entry = tNear; }
    if (tFar < *exit) { *exit = tFar; }
    return *entry <= *exit;
  }
  return origin >= lo && origin <= hi;
}
`;

/** 发射单级内核源码；输出逐字节不变合同由 rayTraceTlasKernel.test 的 sha256 钉死。 */
export function emitRayTraceKernelWgsl(): string {
  return /* wgsl */ `// RayBackend software trace kernel (wave 4). Byte layout contract: rayTraceLayout.ts.
// Traversal/intersection semantics: arbitrated against rayTrace.ts (CPU reference).
${WGSL_CORE}struct Params {
  rayCount: u32,
  triangleCount: u32,
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<storage, read> bvhNodes: array<BvhNode>;
@group(0) @binding(1) var<storage, read> vertices: array<f32>;
@group(0) @binding(2) var<storage, read> indices: array<u32>;
@group(0) @binding(3) var<storage, read> triangleOrder: array<u32>;
@group(0) @binding(4) var<storage, read> rayStream: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> hitRecords: array<HitRecord>;
@group(0) @binding(6) var<storage, read_write> stackOverflows: atomic<u32>;
@group(0) @binding(7) var<uniform> params: Params;

${WGSL_HELPERS}
@compute @workgroup_size(${RAY_TRACE_WORKGROUP_SIZE})
fn ${RAY_TRACE_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u) {
  let rayIndex = gid.x;
  if (rayIndex >= params.rayCount) { return; }
  let front = rayStream[rayIndex * 2u];
  let back = rayStream[rayIndex * 2u + 1u];
  let origin = vec3f(front.x, front.y, front.z);
  let dir = vec3f(back.x, back.y, back.z);
  let tMax = front.w;
  let inv = vec3f(1.0 / dir.x, 1.0 / dir.y, 1.0 / dir.z);
  var bestT = tMax;
  var bestPrim = SENTINEL;
  var status = STATUS_MISS;
  var stack: array<u32, STACK_CAPACITY>;
  var sp: u32 = 1u;
  stack[0] = 0u;
  loop {
    if (sp == 0u) { break; }
    sp = sp - 1u;
    let nodeIndex = stack[sp];
    let node = bvhNodes[nodeIndex];
    var entry: f32 = 0.0;
    var exit: f32 = bestT;
    if (!slabOverlaps(origin.x, dir.x, inv.x, node.boundMin.x, node.boundMax.x, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.y, dir.y, inv.y, node.boundMin.y, node.boundMax.y, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.z, dir.z, inv.z, node.boundMin.z, node.boundMax.z, &entry, &exit)) { continue; }
    if (node.count > 0u) {
      for (var local: u32 = 0u; local < node.count; local = local + 1u) {
        let prim = triangleOrder[node.leftFirst + local];
        let t = intersectTriangle(origin, dir, prim);
        if (t >= 0.0 && t <= tMax && t < bestT) {
          bestT = t;
          bestPrim = prim;
          status = STATUS_HIT;
        }
      }
      continue;
    }
    if (sp + 2u > STACK_CAPACITY) {
      // Fail-closed: stack exhausted, discard this ray's result and raise the batch sentinel.
      atomicAdd(&stackOverflows, 1u);
      status = STATUS_OVERFLOW;
      bestT = -1.0;
      bestPrim = SENTINEL;
      break;
    }
    stack[sp] = node.rightChild;
    sp = sp + 1u;
    stack[sp] = node.leftFirst;
    sp = sp + 1u;
  }
  hitRecords[rayIndex] = HitRecord(select(-1.0, bestT, status == STATUS_HIT), bestPrim, status, 0u);
}
`;
}

