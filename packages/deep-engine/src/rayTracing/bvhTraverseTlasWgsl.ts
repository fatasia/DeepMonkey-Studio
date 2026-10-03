/**
 * compute BVH 光追骨架·共享遍历 WGSL 片段库（TLAS 实例级）。
 * 依赖 bvhTraverseWgsl.ts 的核心片段（BvhNode/TraverseHit/nodeMin/nodeMax/slab/intersect/
 * blasClosestHit/blasOccluded/STACK_CAPACITY/SENTINEL）；storage 变量名合同同其头注释，
 * 另需 `tlasInstances`（array<TlasInstance>，128B 记录，tlasLayout.ts 布局合同）。
 *
 * == t 缩放语义（仲裁基准 tlas.ts traceTlasClosest 逐式镜像） ==
 * 世界射线经行主序 3×4 worldToLocal 拉回实例局部；tlasLocalRay 返回 scale=|M·d|，
 * 局部方向按 scale 归一化、localTMax = tMax×scale、命中 worldT = t÷scale（t 以世界方向
 * 长度计；scale≤0 含 NaN 整实例跳过，与 CPU directionScale 守卫同语义）。
 * 世界法线：cofactor 矩阵变换（(A⁻¹)ᵀ 的 det 常比因子在归一化中消去）——行 0/1/2 =
 * cross(b,c)/cross(c,a)/cross(a,b)，刚体+均匀缩放与非均匀缩放均正确。
 * 实例 mask 过滤：`(meta0.y & rayMask) == 0` 整实例跳过（与 rayTraceTlasKernel 同语义）。
 */

/** TlasInstance 128B 记录（tlasLayout.ts 布局合同，与 rayTraceTlasKernel 逐字一致）。 */
export const TLAS_INSTANCE_STRUCT_WGSL = /* wgsl */ `struct TlasInstance {
  boundsMin: vec4f,
  boundsMax: vec4f,
  row0: vec4f,
  row1: vec4f,
  row2: vec4f,
  meta0: vec4u,
  pad0: vec4u,
  pad1: vec4u,
}
`;

/** 世界射线→实例局部：写局部 origin/归一化方向，返回 scale=|M·d|（退化返回 -1）。 */
export const TLAS_LOCAL_RAY_WGSL = /* wgsl */ `fn tlasLocalRay(inst: TlasInstance, origin: vec3f, dir: vec3f,
  localOrigin: ptr<function, vec3f>, localDir: ptr<function, vec3f>) -> f32 {
  *localOrigin = inst.row0.xyz * origin.x + inst.row1.xyz * origin.y + inst.row2.xyz * origin.z
    + vec3f(inst.row0.w, inst.row1.w, inst.row2.w);
  let transformed = inst.row0.xyz * dir.x + inst.row1.xyz * dir.y + inst.row2.xyz * dir.z;
  let scale = length(transformed);
  if (!(scale > 0.0)) { return -1.0; }
  *localDir = transformed / scale;
  return scale;
}

// 实例局部几何法线 → 世界空间（cofactor 变换，归一化消去 det 常比因子；推导见模块头注释）。
fn tlasWorldNormal(inst: TlasInstance, localNormal: vec3f) -> vec3f {
  let a = inst.row0.xyz;
  let b = inst.row1.xyz;
  let c = inst.row2.xyz;
  let cofactor0 = cross(b, c);
  let cofactor1 = cross(c, a);
  let cofactor2 = cross(a, b);
  return normalize(cofactor0 * localNormal.x + cofactor1 * localNormal.y + cofactor2 * localNormal.z);
}
`;

/** 两级 closest-hit：TLAS 盒剪枝 → 实例循环 → blasClosestHit；写 t/世界法线/实例/全局三角。 */
export const TLAS_CLOSEST_WGSL = /* wgsl */ `fn traceTwoLevelClosest(origin: vec3f, dir: vec3f, inv: vec3f,
  tMax: f32, rayMask: u32, hit: ptr<function, TraverseHit>, overflow: ptr<function, u32>) -> u32 {
  var bestWorldT = tMax;
  var bestPrim = SENTINEL;
  var bestInstance = SENTINEL;
  var bestNormal = vec3f(0.0);
  var stack: array<u32, STACK_CAPACITY>;
  var sp: u32 = 1u;
  stack[0] = 0u;
  loop {
    if (sp == 0u) { break; }
    sp = sp - 1u;
    let node = nodes[stack[sp]];
    var entry: f32 = 0.0;
    var exit: f32 = bestWorldT;
    let nmin = nodeMin(node);
    let nmax = nodeMax(node);
    if (!slabOverlaps(origin.x, dir.x, inv.x, nmin.x, nmax.x, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.y, dir.y, inv.y, nmin.y, nmax.y, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.z, dir.z, inv.z, nmin.z, nmax.z, &entry, &exit)) { continue; }
    if (node.count > 0u) {
      for (var local: u32 = 0u; local < node.count; local = local + 1u) {
        let inst = tlasInstances[node.leftFirst + local];
        let metaWords = inst.meta0;
        if ((metaWords.y & rayMask) == 0u) { continue; }
        var localOrigin: vec3f;
        var localDir: vec3f;
        let scale = tlasLocalRay(inst, origin, dir, &localOrigin, &localDir);
        if (scale < 0.0) { continue; }
        let localTMax = tMax * scale;
        let localInv = vec3f(1.0 / localDir.x, 1.0 / localDir.y, 1.0 / localDir.z);
        var subHit: TraverseHit;
        var subOverflow: u32 = 0u;
        let found = blasClosestHit(localOrigin, localDir, localInv, localTMax, metaWords.z, metaWords.w,
          &subHit, &subOverflow);
        if (subOverflow != 0u) { *overflow = 1u; return 0u; }
        if (found == 1u) {
          let worldT = subHit.t / scale;
          if (worldT <= tMax && worldT < bestWorldT) {
            bestWorldT = worldT;
            bestPrim = subHit.primitiveIndex;
            bestInstance = metaWords.x;
            bestNormal = tlasWorldNormal(inst, subHit.normal);
          }
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
  (*hit).t = bestWorldT;
  (*hit).normal = bestNormal;
  (*hit).instanceIndex = bestInstance;
  (*hit).primitiveIndex = bestPrim;
  return 1u;
}
`;

/** 两级 any-hit（遮挡早退）：TLAS 剪枝 → 实例循环 → blasOccluded；溢出 fail-closed。 */
export const TLAS_OCCLUDED_WGSL = /* wgsl */ `fn traceTwoLevelOccluded(origin: vec3f, dir: vec3f, inv: vec3f,
  tMax: f32, rayMask: u32, overflow: ptr<function, u32>) -> bool {
  var stack: array<u32, STACK_CAPACITY>;
  var sp: u32 = 1u;
  stack[0] = 0u;
  loop {
    if (sp == 0u) { break; }
    sp = sp - 1u;
    let node = nodes[stack[sp]];
    var entry: f32 = 0.0;
    var exit: f32 = tMax;
    let nmin = nodeMin(node);
    let nmax = nodeMax(node);
    if (!slabOverlaps(origin.x, dir.x, inv.x, nmin.x, nmax.x, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.y, dir.y, inv.y, nmin.y, nmax.y, &entry, &exit)) { continue; }
    if (!slabOverlaps(origin.z, dir.z, inv.z, nmin.z, nmax.z, &entry, &exit)) { continue; }
    if (node.count > 0u) {
      for (var local: u32 = 0u; local < node.count; local = local + 1u) {
        let inst = tlasInstances[node.leftFirst + local];
        let metaWords = inst.meta0;
        if ((metaWords.y & rayMask) == 0u) { continue; }
        var localOrigin: vec3f;
        var localDir: vec3f;
        let scale = tlasLocalRay(inst, origin, dir, &localOrigin, &localDir);
        if (scale < 0.0) { continue; }
        let localTMax = tMax * scale;
        let localInv = vec3f(1.0 / localDir.x, 1.0 / localDir.y, 1.0 / localDir.z);
        var subOverflow: u32 = 0u;
        if (blasOccluded(localOrigin, localDir, localInv, localTMax, metaWords.z, metaWords.w, &subOverflow)) {
          return true;
        }
        if (subOverflow != 0u) { *overflow = 1u; return false; }
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
