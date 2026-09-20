/**
 * 软件光栅化 kernel 发射（追平-Nanite 三件套之三的 GPU 腿）：两阶段确定性最小深度光栅化。
 * [追平-Nanite] 微三角后备的 GPU 路径：compute 每三角形一线程，扫描线遍历其屏幕 bbox，
 * 写 visibility 编码空间（slot/packedTriangle/depth），语义合同与 CPU 参考
 * （webgpu/softRasterizeReference.ts）逐项对应——任何一侧修改必须同步另一侧并跑对拍。
 *
 * == 语义合同 ==
 * 1. 三角形与 CPU 参考同向（ccw-in-y-down，edge > 0 为内部）；退化/背面三角形零写入。
 * 2. 像素中心采样（px = x + 0.5）。两阶段确定性 z 剔除：`soft_rasterize_depth_min` 对每像素
 *    atomicMin 单调深度键（f32→u32 符号序保持映射，见 depthKey），dispatch 边界即 WebGPU
 *    全局屏障；`soft_rasterize_write` 第二阶段等键回写 slot/packedTriangle/depth。
 *    胜者 = 最小深度，与 dispatch 内并发顺序无关（顺序互换不变量，真机对拍受检）。
 *    f32 精确相等的并列三角：胜者为并列集合之一（非确定）；CPU 参考（顺序 less，先画先得）
 *    仅在无精确并列时与之可对拍——对拍案例深度分离 ≥1.56e-3。硬件路径的 depth-less 语义
 *    与本合同在「无精确并列」前提下等价。
 * 3. depthKeyScratch（binding 6）由执行器在每次 dispatch 对之前清零为 0xFFFFFFFF
 *    （= SOFT_RASTERIZE_DEPTH_KEY_CLEAR，u32 max 大于一切有限键，含 ±inf 的键）。
 * 4. 深度插值：重心权重 w0/w1/w2 线性插值（透视校正留待消费方以 1/w 通道扩展，注释合同）。
 *    角点经 isFiniteF32 守卫；由有限角点插值出的深度假定有限（f32 溢出到 ±inf 的键仍有序，
 *    NaN 超出合同——与硬件 clip 行为同界）。
 * 5. fail-closed：slot ≥ CLEAR 哨兵、triangleLocalIndex > 255、坐标非有限——depth_min 阶段
 *    atomicAdd 全局哨兵 softRasterFaults（每故障三角恰一次）后返回；write 阶段同一守卫
 *    静默跳过（不重复计数）。执行器见非零哨兵整批拒绝（参照 rayTraceExecutor 纪律）。
 * 6. 布局：triangles 每三角 10×f32（窗口 xyz ×3 + cluster 内局部索引）；visibility
 *    目标 = rg32uint 双通道 + 独立 depth32float（与硬件路径附件空间一致，接线时可 alias）。
 * 7. 接线点（本切片不改 webgpu/ 既有文件）：执行器消费点 = 选层后的「超误差 cluster 集合」
 *    驱动 depth_min → write 两次 dispatchWorkgroups（同一 compute pass 内顺序执行）——参照
 *    clusterLodSelectionKernel.ts 头注释 5 的 indirect 消费模式。
 */

import { VISIBILITY_CLEAR_SLOT, VISIBILITY_TRIANGLE_BITS, VISIBILITY_TRIANGLE_MASK } from "./visibilityBufferEncoding.js";

export const SOFT_RASTERIZE_DEPTH_MIN_ENTRY_POINT = "soft_rasterize_depth_min";
export const SOFT_RASTERIZE_WRITE_ENTRY_POINT = "soft_rasterize_write";
/** compute workgroup 尺寸：kernel 发射与 dispatch 侧共用的单一来源。 */
export const SOFT_RASTERIZE_WORKGROUP_SIZE = 64;
/** depthKeyScratch 的清零值（u32 max：大于一切有限深度的键）。 */
export const SOFT_RASTERIZE_DEPTH_KEY_CLEAR = 0xffff_ffff;

/** WGSL binding 槽位合同（后续执行器的 bindGroup 顺序必须逐项对应）。 */
export const SOFT_RASTERIZE_BINDINGS = Object.freeze([
  { binding: 0, name: "triangles", type: "read-only-storage" },
  { binding: 1, name: "visibilitySlot", type: "storage" },
  { binding: 2, name: "visibilityTriangle", type: "storage" },
  { binding: 3, name: "visibilityDepth", type: "storage" },
  { binding: 4, name: "params", type: "uniform" },
  { binding: 5, name: "softRasterFaults", type: "storage" },
  { binding: 6, name: "depthKeyScratch", type: "storage" },
] as const);

/** 发射内核源码；常量自 visibilityBufferEncoding 单一来源插值（禁止双写）。 */
export function emitSoftRasterizeWgsl(): string {
  const clearSlot = VISIBILITY_CLEAR_SLOT;
  const triangleMask = VISIBILITY_TRIANGLE_MASK;
  const triangleBits = VISIBILITY_TRIANGLE_BITS;
  const depthKeyClear = SOFT_RASTERIZE_DEPTH_KEY_CLEAR;
  const workgroupSize = SOFT_RASTERIZE_WORKGROUP_SIZE;
  return /* wgsl */ `// Soft rasterizer micro-triangle fallback (wave 3). Byte layout contract:
// softRasterizeReference.ts + visibilityBufferEncoding.ts. Semantics arbitrate against
// webgpu/softRasterizeReference.ts (CPU reference): ccw-in-y-down, pixel-center sampling,
// deterministic minimum-depth winner via two-phase atomic keys, clearing sentinel 0xFFFFFFFF.
const CLEAR_SLOT: u32 = ${clearSlot}u;
const TRIANGLE_MASK: u32 = ${triangleMask}u;
const TRIANGLE_BITS: u32 = ${triangleBits}u;
const DEPTH_KEY_CLEAR: u32 = ${depthKeyClear}u;

struct SoftRasterParams {
  viewportWidth: u32,
  viewportHeight: u32,
  triangleCount: u32,
  slotBase: u32,
};

@group(0) @binding(0) var<storage, read> triangles: array<f32>; // 每三角 10 f32：9 位置 + 1 cluster 内局部索引
@group(0) @binding(1) var<storage, read_write> visibilitySlot: array<u32>;
@group(0) @binding(2) var<storage, read_write> visibilityTriangle: array<u32>;
@group(0) @binding(3) var<storage, read_write> visibilityDepth: array<f32>;
@group(0) @binding(4) var<uniform> params: SoftRasterParams;
@group(0) @binding(5) var<storage, read_write> softRasterFaults: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> depthKeyScratch: array<atomic<u32>>;

fn edge(ax: f32, ay: f32, bx: f32, by: f32, px: f32, py: f32) -> f32 {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

// WGSL 无 isFinite 内建：f32 有限性 = |v| ≤ FLT_MAX（NaN 比较恒 false 同样被拒，±inf 超界被拒）。
fn isFiniteF32(v: f32) -> bool {
  return abs(v) <= 3.4028234663852886e38;
}

// 全域单调 f32→u32 键（含负深度）：正数置符号位、负数全部取反；DEPTH_KEY_CLEAR 大于一切有限键。
fn depthKey(d: f32) -> u32 {
  let bits = bitcast<u32>(d);
  return select(bits | 0x80000000u, ~bits, bits >= 0x80000000u);
}

@compute @workgroup_size(${workgroupSize})
fn soft_rasterize_depth_min(@builtin(global_invocation_id) gid: vec3u) {
  let triangleIndex = gid.x;
  if (triangleIndex >= params.triangleCount) { return; }
  let base = triangleIndex * 10u;
  let ax = triangles[base]; let ay = triangles[base + 1u]; let az = triangles[base + 2u];
  let bx = triangles[base + 3u]; let by = triangles[base + 4u]; let bz = triangles[base + 5u];
  let cx = triangles[base + 6u]; let cy = triangles[base + 7u]; let cz = triangles[base + 8u];
  if (!isFiniteF32(ax) || !isFiniteF32(ay) || !isFiniteF32(az) || !isFiniteF32(bx) || !isFiniteF32(by)
    || !isFiniteF32(bz) || !isFiniteF32(cx) || !isFiniteF32(cy) || !isFiniteF32(cz)) {
    atomicAdd(&softRasterFaults[0], 1u);
    return;
  }
  let slot = params.slotBase + triangleIndex;
  if (slot >= CLEAR_SLOT) {
    atomicAdd(&softRasterFaults[0], 1u);
    return;
  }
  let area = edge(ax, ay, bx, by, cx, cy);
  if (area <= 0.0) { return; }
  let minX = max(0u, u32(ceil(min(min(ax, bx), cx) - 0.5)));
  let maxX = min(params.viewportWidth - 1u, u32(floor(max(max(ax, bx), cx) - 0.5)));
  let minY = max(0u, u32(ceil(min(min(ay, by), cy) - 0.5)));
  let maxY = min(params.viewportHeight - 1u, u32(floor(max(max(ay, by), cy) - 0.5)));
  if (minX > maxX || minY > maxY) { return; }
  let localIndex = u32(triangles[base + 9u]);
  if (localIndex > (TRIANGLE_MASK)) {
    atomicAdd(&softRasterFaults[0], 1u);
    return;
  }
  var y = minY;
  loop {
    if (y > maxY) { break; }
    var x = minX;
    loop {
      if (x > maxX) { break; }
      let px = f32(x) + 0.5;
      let py = f32(y) + 0.5;
      let w0 = edge(bx, by, cx, cy, px, py);
      let w1 = edge(cx, cy, ax, ay, px, py);
      let w2 = edge(ax, ay, bx, by, px, py);
      if (w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0) {
        let depth = (w0 / area) * az + (w1 / area) * bz + (w2 / area) * cz;
        let pixel = y * params.viewportWidth + x;
        atomicMin(&depthKeyScratch[pixel], depthKey(depth));
      }
      x += 1u;
    }
    y += 1u;
  }
}

// 第二阶段：dispatch 边界（全局屏障）之后等键回写——胜者 = 最小深度，与并发顺序无关。
// f32 精确相等的并列三角都会通过等键检查（胜者非确定，见合同 2）。
@compute @workgroup_size(${workgroupSize})
fn soft_rasterize_write(@builtin(global_invocation_id) gid: vec3u) {
  let triangleIndex = gid.x;
  if (triangleIndex >= params.triangleCount) { return; }
  let base = triangleIndex * 10u;
  let ax = triangles[base]; let ay = triangles[base + 1u]; let az = triangles[base + 2u];
  let bx = triangles[base + 3u]; let by = triangles[base + 4u]; let bz = triangles[base + 5u];
  let cx = triangles[base + 6u]; let cy = triangles[base + 7u]; let cz = triangles[base + 8u];
  if (!isFiniteF32(ax) || !isFiniteF32(ay) || !isFiniteF32(az) || !isFiniteF32(bx) || !isFiniteF32(by)
    || !isFiniteF32(bz) || !isFiniteF32(cx) || !isFiniteF32(cy) || !isFiniteF32(cz)) {
    return; // 故障三角已在 depth_min 计数，本阶段静默跳过（每故障三角恰一次）。
  }
  let slot = params.slotBase + triangleIndex;
  if (slot >= CLEAR_SLOT) { return; }
  let area = edge(ax, ay, bx, by, cx, cy);
  if (area <= 0.0) { return; }
  let minX = max(0u, u32(ceil(min(min(ax, bx), cx) - 0.5)));
  let maxX = min(params.viewportWidth - 1u, u32(floor(max(max(ax, bx), cx) - 0.5)));
  let minY = max(0u, u32(ceil(min(min(ay, by), cy) - 0.5)));
  let maxY = min(params.viewportHeight - 1u, u32(floor(max(max(ay, by), cy) - 0.5)));
  if (minX > maxX || minY > maxY) { return; }
  let localIndex = u32(triangles[base + 9u]);
  if (localIndex > (TRIANGLE_MASK)) { return; }
  let packed = localIndex & TRIANGLE_MASK;
  var y = minY;
  loop {
    if (y > maxY) { break; }
    var x = minX;
    loop {
      if (x > maxX) { break; }
      let px = f32(x) + 0.5;
      let py = f32(y) + 0.5;
      let w0 = edge(bx, by, cx, cy, px, py);
      let w1 = edge(cx, cy, ax, ay, px, py);
      let w2 = edge(ax, ay, bx, by, px, py);
      if (w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0) {
        let depth = (w0 / area) * az + (w1 / area) * bz + (w2 / area) * cz;
        let pixel = y * params.viewportWidth + x;
        if (atomicLoad(&depthKeyScratch[pixel]) == depthKey(depth)) {
          visibilityDepth[pixel] = depth;
          visibilitySlot[pixel] = slot;
          visibilityTriangle[pixel] = packed;
        }
      }
      x += 1u;
    }
    y += 1u;
  }
}

`;
}
