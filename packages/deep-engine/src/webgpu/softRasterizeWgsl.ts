/**
 * 软件光栅化 kernel 发射（追平-Nanite 三件套之三的 GPU 腿）：`soft_rasterize_triangles`。
 * [追平-Nanite] 微三角后备的 GPU 路径：compute 每三角形一线程，扫描线遍历其屏幕 bbox，
 * 写 visibility 编码空间（slot/packedTriangle/depth），语义合同与 CPU 参考
 * （webgpu/softRasterizeReference.ts）逐项对应——任何一侧修改必须同步另一侧并跑对拍。
 *
 * == 语义合同 ==
 * 1. 三角形与 CPU 参考同向（ccw-in-y-down，edge > 0 为内部）；退化/背面三角形零写入。
 * 2. 像素中心采样（px = x + 0.5）；top-left 规则由「小于即拒绝 + 起点偏移 0.5」近似，
 *    共享边双写由 depth less 语义消除（同深度后写不覆盖先写——与 CPU 的 `depth >= 跳过` 一致）。
 * 3. 深度插值：重心权重 w0/w1/w2 线性插值（透视校正留待消费方以 1/w 通道扩展，注释合同）。
 * 4. fail-closed：slot ≥ CLEAR 哨兵、triangleLocalIndex > 255、坐标非有限——本三角形
 *    atomicAdd 全局哨兵 softRasterFaults 后返回；执行器见非零哨兵整批拒绝（参照
 *    rayTraceExecutor 的 error-scope 纪律）。
 * 5. 布局：triangles 每三角 10×f32（窗口 xyz ×3 + cluster 内局部索引）；visibility
 *    目标 = rg32uint 双通道 + 独立 depth32float（与硬件路径附件空间一致，接线时可 alias）。
 * 6. webgpu/ 接线点（本切片不改 webgpu/ 既有文件）：执行器消费点 = 选层后的
 *    「超误差 cluster 集合」驱动本 kernel 的 triangleCount/firstTriangle——参照
 *    clusterLodSelectionKernel.ts 头注释 5 的 indirect 消费模式。
 */

import { VISIBILITY_CLEAR_SLOT, VISIBILITY_TRIANGLE_BITS, VISIBILITY_TRIANGLE_MASK } from "./visibilityBufferEncoding.js";

export const SOFT_RASTERIZE_ENTRY_POINT = "soft_rasterize_triangles";

/** WGSL binding 槽位合同（后续执行器的 bindGroup 顺序必须逐项对应）。 */
export const SOFT_RASTERIZE_BINDINGS = Object.freeze([
  { binding: 0, name: "triangles", type: "read-only-storage" },
  { binding: 1, name: "visibilitySlot", type: "storage" },
  { binding: 2, name: "visibilityTriangle", type: "storage" },
  { binding: 3, name: "visibilityDepth", type: "storage" },
  { binding: 4, name: "params", type: "uniform" },
  { binding: 5, name: "softRasterFaults", type: "storage" },
] as const);

/** 发射内核源码；常量自 visibilityBufferEncoding 单一来源插值（禁止双写）。 */
export function emitSoftRasterizeWgsl(): string {
  const clearSlot = VISIBILITY_CLEAR_SLOT;
  const triangleMask = VISIBILITY_TRIANGLE_MASK;
  const triangleBits = VISIBILITY_TRIANGLE_BITS;
  return /* wgsl */ `// Soft rasterizer micro-triangle fallback (wave 3). Byte layout contract:
// softRasterizeReference.ts + visibilityBufferEncoding.ts. Semantics arbitrate against
// webgpu/softRasterizeReference.ts (CPU reference): ccw-in-y-down, pixel-center sampling,
// depth-less z rejection, clearing sentinel 0xFFFFFFFF.
const CLEAR_SLOT: u32 = ${clearSlot}u;
const TRIANGLE_MASK: u32 = ${triangleMask}u;
const TRIANGLE_BITS: u32 = ${triangleBits}u;

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
@group(0) @binding(4) var<storage, read> params: SoftRasterParams;
@group(0) @binding(5) var<storage, read_write> softRasterFaults: array<atomic<u32>>;

fn edge(ax: f32, ay: f32, bx: f32, by: f32, px: f32, py: f32) -> f32 {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

@compute @workgroup_size(64)
fn soft_rasterize_triangles(@builtin(global_invocation_id) gid: vec3u) {
  let triangleIndex = gid.x;
  if (triangleIndex >= params.triangleCount) { return; }
  let base = triangleIndex * 10u;
  let ax = triangles[base]; let ay = triangles[base + 1u]; let az = triangles[base + 2u];
  let bx = triangles[base + 3u]; let by = triangles[base + 4u]; let bz = triangles[base + 5u];
  let cx = triangles[base + 6u]; let cy = triangles[base + 7u]; let cz = triangles[base + 8u];
  if (!isFinite(ax) || !isFinite(ay) || !isFinite(az) || !isFinite(bx) || !isFinite(by)
    || !isFinite(bz) || !isFinite(cx) || !isFinite(cy) || !isFinite(cz)) {
    atomicAdd(&softRasterFaults[0], 1u);
    return;
  }
  let slot = slotBase + triangleIndex;
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
  if (localIndex > (${triangleMask}u)) {
    atomicAdd(&softRasterFaults[0], 1u);
    return;
  }
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
        if (depth < visibilityDepth[pixel]) {
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
