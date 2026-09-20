/**
 * RayBackend 两级（TLAS→BLAS）compute 内核发射：`ray_trace_tlas_batch`。
 * 共享片段（常量/BvhNode/HitRecord/Möller–Trumbore/slab）自 rayTraceKernel 导入——
 * 单级发射的逐字节不变合同由 rayTraceTlasKernel.test 的 sha256 钉死，改共享片段会同时
 * 改变两个内核。遍历/t 缩放语义以 tlas.ts traceTlasClosest 为仲裁基准（逐式镜像）：
 * 世界 t 以世界方向长度为单位；局部方向按 |M·d| 归一化、tMax×scale、命中 t÷scale 还原
 * 世界参数（仿射下世界/局部射线参数恒等，几何距离 = 参数×|方向|）。
 * 布局合同（TlasInstance 128B、多 BLAS 拼接、HitRecord pad0=instanceIndex）：tlasLayout.ts。
 * 栈合同：TLAS 与 BLAS 两级各自固定深 32，任一溢出 atomicAdd 哨兵 + 本射线 STATUS_OVERFLOW
 * fail-closed；instanceCount ≤ 262144 ⇒ TLAS 深度 ≤ 18，正常输入不可达。
 */

import { RAY_TRACE_WORKGROUP_SIZE } from "./rayTraceLayout.js";
import { WGSL_CORE, WGSL_HELPERS } from "./rayTraceKernel.js";

export const RAY_TRACE_TLAS_ENTRY_POINT = "ray_trace_tlas_batch";

/** 两级 binding 合同（8 条 storage 恰在 maxStorageBuffersPerShaderStage 默认上限内；
 * 实例 order 已折入 tlasInstances 排列、TLAS/BLAS 节点与三角形各自拼接，见 tlasLayout.ts）。 */
export const RAY_TRACE_TLAS_BINDINGS = Object.freeze([
  { binding: 0, name: "nodes", type: "read-only-storage" },
  { binding: 1, name: "tlasInstances", type: "read-only-storage" },
  { binding: 2, name: "vertices", type: "read-only-storage" },
  { binding: 3, name: "indices", type: "read-only-storage" },
  { binding: 4, name: "triangleOrder", type: "read-only-storage" },
  { binding: 5, name: "rayStream", type: "read-only-storage" },
  { binding: 6, name: "hitRecords", type: "storage" },
  { binding: 7, name: "stackOverflows", type: "storage" },
  { binding: 8, name: "params", type: "uniform" },
] as const);

export function emitTwoLevelRayTraceKernelWgsl(): string {
  return /* wgsl */ `// RayBackend two-level software trace kernel (TLAS then BLAS). Concat contract: tlasLayout.ts.
// Instance traversal/t-scaling semantics: arbitrated against tlas.ts traceTlasClosest (CPU reference).
${WGSL_CORE}
struct TlasInstance {
  boundsMin: vec4f,
  boundsMax: vec4f,
  row0: vec4f,
  row1: vec4f,
  row2: vec4f,
  meta0: vec4u,
  pad0: vec4u,
  pad1: vec4u,
}
struct Params {
  rayCount: u32,
  rayMask: u32,
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<storage, read> nodes: array<BvhNode>;
@group(0) @binding(1) var<storage, read> tlasInstances: array<TlasInstance>;
@group(0) @binding(2) var<storage, read> vertices: array<f32>;
@group(0) @binding(3) var<storage, read> indices: array<u32>;
@group(0) @binding(4) var<storage, read> triangleOrder: array<u32>;
@group(0) @binding(5) var<storage, read> rayStream: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> hitRecords: array<HitRecord>;
@group(0) @binding(7) var<storage, read_write> stackOverflows: atomic<u32>;
@group(0) @binding(8) var<uniform> params: Params;

${WGSL_HELPERS}
// BLAS-level stack traversal in instance-local space: node i of this BLAS lives at
// nodes[nodeBase + i], its triangle slots at triangleOrder[triangleBase + slot].
// Stack overflow fails closed exactly like the single-level kernel (returns -1.0, raises flag).
fn traceBlasClosest(origin: vec3f, dir: vec3f, inv: vec3f, tMaxLocal: f32, nodeBase: u32,
  triangleBase: u32, bestPrim: ptr<function, u32>, overflow: ptr<function, u32>) -> f32 {
  var bestT = tMaxLocal;
  var stack: array<u32, STACK_CAPACITY>;
  var sp: u32 = 1u;
  stack[0] = 0u;
  loop {
    if (sp == 0u) { break; }
    sp = sp - 1u;
    let node = nodes[nodeBase + stack[sp]];
    var entry: f32 = 0.0;
    var exit: f32 = bestT;
    if (!slabOverlaps(origin.x, dir.x, inv.x, node.boundMin.x, node.boundMax.x, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.y, dir.y, inv.y, node.boundMin.y, node.boundMax.y, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.z, dir.z, inv.z, node.boundMin.z, node.boundMax.z, &entry, &exit)) { continue; }
    if (node.count > 0u) {
      for (var local: u32 = 0u; local < node.count; local = local + 1u) {
        let prim = triangleOrder[triangleBase + node.leftFirst + local];
        let t = intersectTriangle(origin, dir, prim);
        if (t >= 0.0 && t <= tMaxLocal && t < bestT) {
          bestT = t;
          *bestPrim = prim;
        }
      }
      continue;
    }
    if (sp + 2u > STACK_CAPACITY) {
      atomicAdd(&stackOverflows, 1u);
      *overflow = 1u;
      return -1.0;
    }
    stack[sp] = node.rightChild;
    sp = sp + 1u;
    stack[sp] = node.leftFirst;
    sp = sp + 1u;
  }
  return bestT;
}

@compute @workgroup_size(${RAY_TRACE_WORKGROUP_SIZE})
fn ${RAY_TRACE_TLAS_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u) {
  let rayIndex = gid.x;
  if (rayIndex >= params.rayCount) { return; }
  let front = rayStream[rayIndex * 2u];
  let back = rayStream[rayIndex * 2u + 1u];
  let origin = vec3f(front.x, front.y, front.z);
  let dir = vec3f(back.x, back.y, back.z);
  let tMax = front.w;
  let inv = vec3f(1.0 / dir.x, 1.0 / dir.y, 1.0 / dir.z);
  var bestWorldT = tMax;
  var bestPrim = SENTINEL;
  var bestInstance = SENTINEL;
  var status = STATUS_MISS;
  var overflowFlag: u32 = 0u;
  var stack: array<u32, STACK_CAPACITY>;
  var sp: u32 = 1u;
  stack[0] = 0u;
  loop {
    if (sp == 0u) { break; }
    sp = sp - 1u;
    let node = nodes[stack[sp]];
    var entry: f32 = 0.0;
    var exit: f32 = bestWorldT;
    if (!slabOverlaps(origin.x, dir.x, inv.x, node.boundMin.x, node.boundMax.x, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.y, dir.y, inv.y, node.boundMin.y, node.boundMax.y, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.z, dir.z, inv.z, node.boundMin.z, node.boundMax.z, &entry, &exit)) { continue; }
    if (node.count > 0u) {
      for (var local: u32 = 0u; local < node.count; local = local + 1u) {
        // records are laid out in TLAS BVH order-slot order (tlasLayout.ts contract)
        let inst = tlasInstances[node.leftFirst + local];
        let metaWords = inst.meta0;
        if ((metaWords.y & params.rayMask) == 0u) { continue; }
        // world -> instance local via the row-major 3x4 inverse affine; normalize the local
        // direction by |M*d| (scale), scale tMax up and the hit t back down, so the reported
        // t stays in world direction-length units -- mirrors traceTlasClosest line by line.
        let localOrigin = inst.row0.xyz * origin.x + inst.row1.xyz * origin.y + inst.row2.xyz * origin.z
          + vec3f(inst.row0.w, inst.row1.w, inst.row2.w);
        let localDir = inst.row0.xyz * dir.x + inst.row1.xyz * dir.y + inst.row2.xyz * dir.z;
        let scale = length(localDir);
        if (!(scale > 0.0)) { continue; }
        let normalized = localDir / scale;
        let localTMax = tMax * scale;
        let localInv = vec3f(1.0 / normalized.x, 1.0 / normalized.y, 1.0 / normalized.z);
        var prim = SENTINEL;
        let localT = traceBlasClosest(localOrigin, normalized, localInv, localTMax, metaWords.z, metaWords.w, &prim, &overflowFlag);
        if (overflowFlag != 0u) { break; }
        if (prim != SENTINEL) {
          let worldT = localT / scale;
          if (worldT <= tMax && worldT < bestWorldT) {
            bestWorldT = worldT;
            bestPrim = prim;
            bestInstance = metaWords.x;
            status = STATUS_HIT;
          }
        }
      }
      if (overflowFlag != 0u) { break; }
      continue;
    }
    if (sp + 2u > STACK_CAPACITY) {
      atomicAdd(&stackOverflows, 1u);
      overflowFlag = 1u;
      status = STATUS_OVERFLOW;
      bestWorldT = -1.0;
      bestPrim = SENTINEL;
      bestInstance = SENTINEL;
      break;
    }
    stack[sp] = node.rightChild;
    sp = sp + 1u;
    stack[sp] = node.leftFirst;
    sp = sp + 1u;
  }
  if (overflowFlag != 0u) {
    status = STATUS_OVERFLOW;
    bestWorldT = -1.0;
    bestPrim = SENTINEL;
    bestInstance = SENTINEL;
  }
  // two-level contract: HitRecord slot 4 carries instanceIndex (single level writes 0)
  hitRecords[rayIndex] = HitRecord(select(-1.0, bestWorldT, status == STATUS_HIT), bestPrim, status, bestInstance);
}
`;
}
