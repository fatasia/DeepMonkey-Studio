/**
 * Deep GI 探针一跳场景辐射捕获内核（F1 第一切片）：`probe_scene_radiance_batch`。
 *
 * == 职责与边界 ==
 * 对每个待更新探针沿确定性 Fibonacci 球面方向集（与 rayTracing/probeOcclusionRayExtension
 * 的 probeOcclusionDirection 同公式）发射 directionCount 条射线，走既有两级（TLAS→BLAS）
 * 软件遍历（共享片段 WGSL_CORE/WGSL_HELPERS 自 rayTraceKernel 导入，sha256 钉死合同不触碰），
 * 命中点按 Lambert 一跳着色（albedo × NdotL × 直射光 / π），miss 记环境 ambient；
 * 探针辐射 = 方向均值，写入捕获纹理的该探针 texel（rgba16float 2d-array，layer =
 * localCell.z + level × gridSize.z）。这是一跳直射+环境估计：命中点不追第二次阴影射线，
 * 高光/天空遮挡、MASK 纹理 alpha、动态蒙皮都按 RenderPacketRayScene 的既有排除口径处理。
 *
 * == 布局合同 ==
 * binding 0..4 与 rayTraceTlasKernel 完全一致（packTlasScene 拼接：nodes/instances/vertices/
 * indices/triangleOrder）；5 = array<vec4f> 逐原始实例反照率（下标 = HitRecord pad0
 * instanceIndex）；6 = array<ProbeParams>（32B/探针）；7 = params uniform（112B）；
 * 8 = 捕获存储纹理（rgba16float write-only 2d-array）；9 = atomic<u32> 栈溢出哨兵
 * （两级遍历合同同源：溢出 fail-closed，本探针写 0 并入哨兵计数，正常输入不可达）。
 * storage buffer 共 8 条，恰在默认 maxStorageBuffersPerShaderStage 上限内。
 *
 * == 数值语义 ==
 * Fibonacci 方向、Möller–Trumbore、栈遍历逐式镜像既有内核/CPU 参考；命中面法线双面
 * （dot(N,d)>0 翻转），NdotL = max(dot(N, surfaceToLight), 0)，Lambert 除以 π；探针辐射
 * = Σ方向贡献 / directionCount，均值写入 texel，w=1 标记有效捕获（溢出写 0）。
 */

import { RAY_TRACE_WORKGROUP_SIZE } from "./rayTraceLayout.js";
import { WGSL_CORE, WGSL_HELPERS } from "./rayTraceKernel.js";

export const PROBE_RADIANCE_ENTRY_POINT = "probe_scene_radiance_batch";
/** 每探针方向数上限（与 probeOcclusionRayExtension 同预算口径）。 */
export const PROBE_RADIANCE_MAX_DIRECTIONS = 16;
export const PROBE_RADIANCE_WORKGROUP_SIZE = RAY_TRACE_WORKGROUP_SIZE;

export const PROBE_RADIANCE_BINDINGS = Object.freeze([
  { binding: 0, name: "nodes", type: "read-only-storage" },
  { binding: 1, name: "tlasInstances", type: "read-only-storage" },
  { binding: 2, name: "vertices", type: "read-only-storage" },
  { binding: 3, name: "indices", type: "read-only-storage" },
  { binding: 4, name: "triangleOrder", type: "read-only-storage" },
  { binding: 5, name: "instanceAlbedos", type: "read-only-storage" },
  { binding: 6, name: "probeParams", type: "read-only-storage" },
  { binding: 7, name: "params", type: "uniform" },
  { binding: 8, name: "capture", type: "storage-texture" },
  { binding: 9, name: "stackOverflows", type: "storage" },
] as const);

/** params uniform 的 CPU 打包（probeRadianceKernel 布局的唯一写侧）。 */
export const PROBE_RADIANCE_UNIFORM_BYTES = 4 * 4 + 4 * 4 * 3;
export const PROBE_RADIANCE_PROBE_PARAM_BYTES = 32;

export interface ProbeRadianceUniformInput {
  readonly updateCount: number;
  readonly directionCount: number;
  readonly rayMask: number;
  readonly tMax: number;
  /** 归一化 surface→light 方向（世界空间）。 */
  readonly surfaceToLight: readonly [number, number, number];
  readonly lightColor: readonly [number, number, number];
  readonly lightIntensity: number;
  readonly ambient: readonly [number, number, number];
}

export function packProbeRadianceUniform(input: ProbeRadianceUniformInput): ArrayBuffer {
  const data = new ArrayBuffer(PROBE_RADIANCE_UNIFORM_BYTES);
  new Uint32Array(data, 0, 3).set([input.updateCount, input.directionCount, input.rayMask]);
  new Float32Array(data, 12, 1)[0] = input.tMax;
  const floats = new Float32Array(data);
  floats.set([...input.surfaceToLight, input.lightIntensity], 4);
  floats.set([...input.lightColor, 0], 8);
  floats.set([...input.ambient, 0], 12);
  return data;
}

/** 每探针参数打包：position.xyz + 目标 layer；localCell.xy（texel 坐标）。 */
export function packProbeRadianceProbeParams(updates: readonly {
  position: readonly [number, number, number];
  layer: number;
  cellX: number;
  cellY: number;
}[]): ArrayBuffer {
  const data = new ArrayBuffer(updates.length * PROBE_RADIANCE_PROBE_PARAM_BYTES);
  const floats = new Float32Array(data);
  updates.forEach((update, index) => {
    const base = index * 8;
    floats.set([update.position[0], update.position[1], update.position[2], update.layer], base);
    floats.set([update.cellX, update.cellY, 0, 0], base + 4);
  });
  return data;
}

export function emitProbeRadianceKernelWgsl(): string {
  return /* wgsl */ `// Deep GI probe one-bounce scene radiance capture (F1). Concat contract: tlasLayout.ts.
// Traversal mirrors rayTraceTlasKernel (arbitrated against tlas.ts traceTlasClosest); the
// Fibonacci direction set mirrors probeOcclusionDirection (probeOcclusionRayExtension.ts).
${WGSL_CORE}
const PI: f32 = 3.141592653589793;
const GOLDEN_SPHERE_ANGLE: f32 = 5.759586531581287; // pi * (1 + sqrt(5)), mirrors the CPU reference

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
struct ProbeParams {
  posLayer: vec4f,
  cellPad: vec4f,
}
struct RadianceParams {
  updateCount: u32,
  directionCount: u32,
  rayMask: u32,
  tMax: f32,
  lightDirIntensity: vec4f,
  lightColor: vec4f,
  ambient: vec4f,
}

@group(0) @binding(0) var<storage, read> nodes: array<BvhNode>;
@group(0) @binding(1) var<storage, read> tlasInstances: array<TlasInstance>;
@group(0) @binding(2) var<storage, read> vertices: array<f32>;
@group(0) @binding(3) var<storage, read> indices: array<u32>;
@group(0) @binding(4) var<storage, read> triangleOrder: array<u32>;
@group(0) @binding(5) var<storage, read> instanceAlbedos: array<vec4f>;
@group(0) @binding(6) var<storage, read> probeParams: array<ProbeParams>;
@group(0) @binding(7) var<uniform> params: RadianceParams;
@group(0) @binding(8) var capture: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(9) var<storage, read_write> stackOverflows: atomic<u32>;

${WGSL_HELPERS}

// Two-level closest hit with inline origin/direction (no rayStream): identical traversal,
// t-scaling and mask semantics as ray_trace_tlas_batch; returns world-space t (tMax on miss).
fn probeTraceClosest(origin: vec3f, dir: vec3f, inv: vec3f, tMax: f32,
  bestPrim: ptr<function, u32>, bestInstance: ptr<function, u32>) -> f32 {
  var bestWorldT = tMax;
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
        let inst = tlasInstances[node.leftFirst + local];
        let metaWords = inst.meta0;
        if ((metaWords.y & params.rayMask) == 0u) { continue; }
        let localOrigin = inst.row0.xyz * origin.x + inst.row1.xyz * origin.y + inst.row2.xyz * origin.z
          + vec3f(inst.row0.w, inst.row1.w, inst.row2.w);
        let localDir = inst.row0.xyz * dir.x + inst.row1.xyz * dir.y + inst.row2.xyz * dir.z;
        let scale = length(localDir);
        if (!(scale > 0.0)) { continue; }
        let normalized = localDir / scale;
        let localTMax = tMax * scale;
        let localInv = vec3f(1.0 / normalized.x, 1.0 / normalized.y, 1.0 / normalized.z);
        var prim = SENTINEL;
        let localT = traceBlas(localOrigin, normalized, localInv, localTMax, metaWords.z, metaWords.w, &prim, &overflowFlag);
        if (overflowFlag != 0u) { break; }
        if (prim != SENTINEL) {
          let worldT = localT / scale;
          if (worldT <= tMax && worldT < bestWorldT) {
            bestWorldT = worldT;
            *bestPrim = prim;
            *bestInstance = metaWords.x;
          }
        }
      }
      if (overflowFlag != 0u) { break; }
      continue;
    }
    if (sp + 2u > STACK_CAPACITY) {
      atomicAdd(&stackOverflows, 1u);
      overflowFlag = 1u;
      break;
    }
    stack[sp] = node.rightChild;
    sp = sp + 1u;
    stack[sp] = node.leftFirst;
    sp = sp + 1u;
  }
  if (overflowFlag != 0u) { return -1.0; }
  return bestWorldT;
}

// BLAS walk identical to traceBlasClosest in rayTraceTlasKernel (nodeBase/triangleBase slicing).
fn traceBlas(origin: vec3f, dir: vec3f, inv: vec3f, tMaxLocal: f32, nodeBase: u32,
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

// Fibonacci sphere direction: same formula/order as probeOcclusionDirection on the CPU.
fn fibonacciDirection(ordinal: u32, count: u32) -> vec3f {
  let k = (f32(ordinal) + 0.5) / f32(count);
  let phi = acos(1.0 - 2.0 * k);
  let theta = GOLDEN_SPHERE_ANGLE * (f32(ordinal) + 0.5);
  let sinPhi = sin(phi);
  return vec3f(sinPhi * cos(theta), cos(phi), sinPhi * sin(theta));
}

@compute @workgroup_size(${PROBE_RADIANCE_WORKGROUP_SIZE})
fn ${PROBE_RADIANCE_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u) {
  let probeIndex = gid.x;
  if (probeIndex >= params.updateCount) { return; }
  let probe = probeParams[probeIndex];
  let origin = probe.posLayer.xyz;
  let layer = i32(probe.posLayer.w);
  let cell = vec2i(probe.cellPad.xy);
  var sum = vec3f(0.0, 0.0, 0.0);
  var overflowed = false;
  for (var ordinal: u32 = 0u; ordinal < params.directionCount; ordinal = ordinal + 1u) {
    let dir = fibonacciDirection(ordinal, params.directionCount);
    let inv = vec3f(1.0 / dir.x, 1.0 / dir.y, 1.0 / dir.z);
    var prim = SENTINEL;
    var instance = SENTINEL;
    // probeTraceClosest returns tMax (>= 0) on miss; a negative t is the overflow rejection.
    let t = probeTraceClosest(origin, dir, inv, params.tMax, &prim, &instance);
    if (t < 0.0) { overflowed = true; break; }
    if (prim == SENTINEL || instance == SENTINEL) {
      // Open direction: the probe sees the environment ambient directly.
      sum = sum + params.ambient.rgb;
      continue;
    }
    let v0 = fetchVertex(indices[prim * 3u]);
    let v1 = fetchVertex(indices[prim * 3u + 1u]);
    let v2 = fetchVertex(indices[prim * 3u + 2u]);
    var normal = normalize(cross(v1 - v0, v2 - v0));
    if (dot(normal, dir) > 0.0) { normal = -normal; }
    let albedo = instanceAlbedos[instance].rgb;
    let nDotL = max(dot(normal, params.lightDirIntensity.xyz), 0.0);
    let lambert = albedo * params.lightColor.rgb * params.lightDirIntensity.w * nDotL / PI;
    sum = sum + lambert;
  }
  if (overflowed) {
    textureStore(capture, cell, layer, vec4f(0.0));
    return;
  }
  let mean = sum / f32(params.directionCount);
  textureStore(capture, cell, layer, vec4f(mean, 1.0));
}
`;
}
