/**
 * compute BVH 光追骨架·共享遍历 WGSL 片段库（BLAS 级 + 核心）。
 * 消费内核（shadowRayKernel 及后续 Web-RT pass）按需拼装本模块片段；片段引用的
 * storage 变量名为消费方必遵合同：`nodes`（array<BvhNode>，BLAS 段为 tlasLayout 拼接布局）、
 * `vertices`（array<f32>）、`indices`（array<u32>）、`triangleOrder`（array<u32>）、
 * `stackOverflows`（atomic<u32>，fail-closed 哨兵）。
 *
 * == f16 可选加速（acceptance: 遍历 f16 加速档） ==
 * `bvhTraverseCoreWgsl({ f16: true })` 发射 `enable f16;` + 32B stride 的 BvhNodeF16
 * （bounds 为 vec4<f16>；packer 以 halfFloat 外扩量化保证存储盒 ⊇ 原盒 ⇒ 剪枝只松不紧，
 * 命中结果与 f32 布局逐位一致，probe 双档对拍钉死）。遍历体经 `nodeMin/nodeMax`
 * （f32() 恒等/升宽转换）在两档间逐字共享；节点带宽 48B→32B。
 *
 * == 命中信息合同（TraverseHit） ==
 * normal=几何法线（消费空间；BLAS 级=实例局部，两级=世界）、t=距离（方向长度单位）、
 * instanceIndex=TLAS 实例原始下标（BLAS 级由调用方填）、primitiveIndex=全局三角下标、
 * hit=0 miss/1 hit。Möller–Trumbore/slab 语义与 rayTraceKernel 仲裁基准逐行同构
 * （DET_EPSILON 1e-20、u/v 拒绝域、平行轴 origin-in-slab）。
 */

export interface BvhTraverseOptions {
  /** f16 压缩节点档（需 device "shader-f16" feature；默认 false）。 */
  readonly f16?: boolean;
}

const BVH_NODE_F32 = /* wgsl */ `struct BvhNode {
  boundMin: vec4f,
  boundMax: vec4f,
  leftFirst: u32,
  count: u32,
  rightChild: u32,
  pad0: u32,
}
`;
// enable 指令必须先于一切全局声明（const 亦然）——本片段必须置于内核发射的最前。
const BVH_NODE_F16 = /* wgsl */ `enable f16;
// f16 压缩节点（stride 32B；bounds 经 halfFloat 外扩量化，剪枝保守性见模块头注释）。
struct BvhNode {
  boundMin: vec4<f16>,
  boundMax: vec4<f16>,
  leftFirst: u32,
  count: u32,
  rightChild: u32,
  pad0: u32,
}
`;

/** 常量 + 节点结构（f32/f16 档）+ TraverseHit；两档共享同名的 nodeMin/nodeMax 存取器。 */
export function bvhTraverseCoreWgsl(options: BvhTraverseOptions = {}): string {
  const nodeStruct = options.f16 === true ? BVH_NODE_F16 : BVH_NODE_F32;
  return /* wgsl */ `${nodeStruct}const STACK_CAPACITY: u32 = 32u;
const SENTINEL: u32 = 4294967295u;
const DET_EPSILON: f32 = 1e-20;
struct TraverseHit {
  normal: vec3f,
  t: f32,
  instanceIndex: u32,
  primitiveIndex: u32,
  hit: u32,
  pad0: u32,
}

// bounds 存取器：f16 档 f32() 为精确升宽，f32 档为恒等（遍历体两档逐字共享）。
fn nodeMin(node: BvhNode) -> vec3f {
  return vec3f(f32(node.boundMin.x), f32(node.boundMin.y), f32(node.boundMin.z));
}
fn nodeMax(node: BvhNode) -> vec3f {
  return vec3f(f32(node.boundMax.x), f32(node.boundMax.y), f32(node.boundMax.z));
}
`;
}

/** slab 盒测试（与 rayTraceKernel 仲裁基准同语义：平行轴只测 origin-in-slab）。 */
export const BVH_SLAB_WGSL = /* wgsl */ `fn slabOverlaps(origin: f32, dir: f32, inv: f32, lo: f32, hi: f32,
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

/** Möller–Trumbore（返回 t；法线经指针带出：双面几何法线，dot(n,dir)>0 翻转）。 */
export const BVH_INTERSECT_NORMAL_WGSL = /* wgsl */ `fn fetchVertex(index: u32) -> vec3f {
  let base = index * 3u;
  return vec3f(vertices[base], vertices[base + 1u], vertices[base + 2u]);
}

fn intersectTriangleNormal(origin: vec3f, dir: vec3f, prim: u32, normal: ptr<function, vec3f>) -> f32 {
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
  let faceNormal = normalize(cross(e1, e2));
  *normal = select(faceNormal, -faceNormal, dot(faceNormal, dir) > 0.0);
  return dot(e2, q) * inv;
}
`;

/** 遮挡专用 Möller–Trumbore（无法线计算，any-hit 快路径）。 */
export const BVH_INTERSECT_WGSL = /* wgsl */ `fn fetchVertex(index: u32) -> vec3f {
  let base = index * 3u;
  return vec3f(vertices[base], vertices[base + 1u], vertices[base + 2u]);
}

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
`;

/** BLAS 级栈式 closest-hit：写 t/局部法线/全局三角下标；溢出 fail-closed（哨兵+返回 0）。 */
export const BVH_BLAS_CLOSEST_WGSL = /* wgsl */ `fn blasClosestHit(origin: vec3f, dir: vec3f, inv: vec3f,
  tMaxLocal: f32, nodeBase: u32, triangleBase: u32,
  hit: ptr<function, TraverseHit>, overflow: ptr<function, u32>) -> u32 {
  var bestT = tMaxLocal;
  var bestPrim = SENTINEL;
  var bestNormal = vec3f(0.0);
  var stack: array<u32, STACK_CAPACITY>;
  var sp: u32 = 1u;
  stack[0] = 0u;
  loop {
    if (sp == 0u) { break; }
    sp = sp - 1u;
    let node = nodes[nodeBase + stack[sp]];
    var entry: f32 = 0.0;
    var exit: f32 = bestT;
    let nmin = nodeMin(node);
    let nmax = nodeMax(node);
    if (!slabOverlaps(origin.x, dir.x, inv.x, nmin.x, nmax.x, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.y, dir.y, inv.y, nmin.y, nmax.y, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.z, dir.z, inv.z, nmin.z, nmax.z, &entry, &exit)) { continue; }
    if (node.count > 0u) {
      for (var local: u32 = 0u; local < node.count; local = local + 1u) {
        let prim = triangleOrder[triangleBase + node.leftFirst + local];
        var n: vec3f;
        let t = intersectTriangleNormal(origin, dir, prim, &n);
        if (t >= 0.0 && t <= tMaxLocal && t < bestT) {
          bestT = t;
          bestPrim = prim;
          bestNormal = n;
        }
      }
      continue;
    }
    if (sp + 2u > STACK_CAPACITY) {
      atomicAdd(&stackOverflows, 1u);
      *overflow = 1u;
      return 0u;
    }
    stack[sp] = node.rightChild;
    sp = sp + 1u;
    stack[sp] = node.leftFirst;
    sp = sp + 1u;
  }
  if (bestPrim == SENTINEL) { return 0u; }
  (*hit).t = bestT;
  (*hit).normal = bestNormal;
  (*hit).primitiveIndex = bestPrim;
  return 1u;
}
`;

/** BLAS 级 any-hit（遮挡早退：首个 t∈(0,tMaxLocal] 命中即 true；溢出 fail-closed）。 */
export const BVH_BLAS_OCCLUDED_WGSL = /* wgsl */ `fn blasOccluded(origin: vec3f, dir: vec3f, inv: vec3f,
  tMaxLocal: f32, nodeBase: u32, triangleBase: u32, overflow: ptr<function, u32>) -> bool {
  var stack: array<u32, STACK_CAPACITY>;
  var sp: u32 = 1u;
  stack[0] = 0u;
  loop {
    if (sp == 0u) { break; }
    sp = sp - 1u;
    let node = nodes[nodeBase + stack[sp]];
    var entry: f32 = 0.0;
    var exit: f32 = tMaxLocal;
    let nmin = nodeMin(node);
    let nmax = nodeMax(node);
    if (!slabOverlaps(origin.x, dir.x, inv.x, nmin.x, nmax.x, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.y, dir.y, inv.y, nmin.y, nmax.y, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.z, dir.z, inv.z, nmin.z, nmax.z, &entry, &exit)) { continue; }
    if (node.count > 0u) {
      for (var local: u32 = 0u; local < node.count; local = local + 1u) {
        let prim = triangleOrder[triangleBase + node.leftFirst + local];
        let t = intersectTriangle(origin, dir, prim);
        if (t >= 0.0 && t <= tMaxLocal) { return true; }
      }
      continue;
    }
    if (sp + 2u > STACK_CAPACITY) {
      atomicAdd(&stackOverflows, 1u);
      *overflow = 1u;
      return false;
    }
    stack[sp] = node.rightChild;
    sp = sp + 1u;
    stack[sp] = node.leftFirst;
    sp = sp + 1u;
  }
  return false;
}
`;
