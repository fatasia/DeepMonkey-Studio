/**
 * 软光栅化真机对拍的固定案例集合（由 lab/softRasterizeGpuProbe.ts 与
 * scripts/softRasterizeGpuTest.mjs 消费；按职责从探针拆出以满足源体量门禁）。
 * 数值纪律：全部顶点坐标 dyadic（k/4，|v| ≤ 65）——edge 函数的差与积在 f32/f64 下均精确
 * 表示，命中集判定逐位一致；重叠三角形深度分离 ≥1.56e-3（dyadic 量化间隔），胜者判定
 * 对舍入稳健。案例族：全屏大三角（斜坡深度）/ z-fighting 顺序互换 / 背面+共线+重点退化 /
 * 越界部分覆盖（负向 bbox 走 WGSL u32(f32) 截断钳制路径，真机受检）/ 微三角亚像素+对角
 * 共享边+64 单元网格（triangleCount=68 > 64：第二个 workgroup 与越界尾线程同机受检）/
 * NaN 坐标与 slot 溢出故障通道（后者 CPU 合同在 API 层抛 RangeError：对拍退化为
 * 「全保持初值」平凡合同，基准来源随证据记录）/ 可见性目标级 fallback-target-alias
 * （softRasterizeFallback 接线合同端到端：目标初值含硬件已写内容 slot=7/packed=5/depth=1.0，
 * 覆盖像素改写、未覆盖像素保持；打包与 CPU 基准走 packSoftRasterTriangles /
 * rasterizePackedTrianglesCpu 单一来源，与渲染器同函数）。
 */

import { VISIBILITY_CLEAR_SLOT, type SoftTriangle } from "../src/webgpu/softRasterizeReference.js";

export interface SoftRasterCaseSpec {
  readonly name: string;
  readonly note: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly slotBase: number;
  readonly expectedFaults: number;
  readonly minCovered: number;
  readonly triangles: readonly Omit<SoftTriangle, "slot">[];
  /** z-fight 顺序互换案例：near/far 三角下标，runner 归一化胜者图后跨案例对拍。 */
  readonly zfightWinner?: { readonly nearIndex: number; readonly farIndex: number };
  /** 仅 GPU fail-closed 通道案例：CPU 合同在 API 层拒绝（RangeError），无 CPU 光栅基准。 */
  readonly cpuSkippedReason?: string;
  /** 可见性目标级案例：目标的既有内容初值（模拟硬件路径已写）；depth 初值恒 1.0。 */
  readonly initialSlotFill?: number;
  readonly initialPackedFill?: number;
}

/** [ax,ay,az, bx,by,bz, cx,cy,cz]；坐标一律 dyadic（k/4）保证 f32/f64 edge 函数逐位一致。 */
type Corner = readonly [number, number, number];

function tri(a: Corner, b: Corner, c: Corner, triangleLocalIndex: number): Omit<SoftTriangle, "slot"> {
  return { ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2],
    cx: c[0], cy: c[1], cz: c[2], triangleLocalIndex };
}

/** 确定性固定三角形集合：五个规定族 + NaN/slot 溢出两个 fail-closed 通道 + 可见性目标级案例。 */
export function buildSoftRasterCases(): readonly SoftRasterCaseSpec[] {
  const grid: Omit<SoftTriangle, "slot">[] = [];
  for (let cell = 0; cell < 64; cell++) {
    const cx = cell % 8, cy = Math.floor(cell / 8);
    const z = cell / 128; // dyadic：与 0.2/0.4/0.5/0.7/0.8 无精确撞点（最近分离 ≥3.1e-3）
    grid.push(tri([cx + 0.125, cy + 0.25, z], [cx + 0.25, cy + 0.625, z],
      [cx + 0.5, cy + 0.375, z], 20 + cell));
  }
  const zfightNote = "同覆盖双平面三角 z=0.5/0.5005（分离 5e-4）；depth-less 语义胜者与顺序无关。";
  return [
    { name: "fullscreen-sloped", viewportWidth: 32, viewportHeight: 24, slotBase: 3,
      expectedFaults: 0, minCovered: 32 * 24,
      note: "全屏大三角覆盖全部 768 像素；斜坡深度 0.2/0.5/0.8 全屏检验 f32 插值 vs CPU f64。",
      triangles: [tri([-1, -1, 0.2], [-1, 49, 0.5], [65, -1, 0.8], 7)] },
    { name: "zfight-near-first", viewportWidth: 8, viewportHeight: 6, slotBase: 11,
      expectedFaults: 0, minCovered: 8, zfightWinner: { nearIndex: 0, farIndex: 1 },
      note: `${zfightNote} 本案例 near 先画。`,
      triangles: [tri([-1, -1, 0.5], [2, 6, 0.5], [5, -1, 0.5], 1),
        tri([-1, -1, 0.5005], [2, 6, 0.5005], [5, -1, 0.5005], 2)] },
    { name: "zfight-far-first", viewportWidth: 8, viewportHeight: 6, slotBase: 13,
      expectedFaults: 0, minCovered: 8, zfightWinner: { nearIndex: 1, farIndex: 0 },
      note: `${zfightNote} 本案例 dispatch 顺序对调；胜者归一化图必须与 near-first 逐像素一致。`,
      triangles: [tri([-1, -1, 0.5005], [2, 6, 0.5005], [5, -1, 0.5005], 2),
        tri([-1, -1, 0.5], [2, 6, 0.5], [5, -1, 0.5], 1)] },
    { name: "backface-degenerate", viewportWidth: 8, viewportHeight: 6, slotBase: 17,
      expectedFaults: 0, minCovered: 8,
      note: "背面（cw）、共线、重复点三类零面积三角零写入；仅 ccw 有效三角落盘。",
      triangles: [tri([-1, -1, 0.5], [5, -1, 0.5], [2, 6, 0.5], 3),
        tri([1, 1, 0.4], [2, 2, 0.4], [3, 3, 0.4], 4),
        tri([2, 2, 0.4], [2, 2, 0.4], [3, 1, 0.4], 5),
        tri([1, 1, 0.3], [1, 5, 0.5], [6, 1, 0.7], 6)] },
    { name: "out-of-bounds-sloped", viewportWidth: 16, viewportHeight: 12, slotBase: 23,
      expectedFaults: 0, minCovered: 16,
      note: "bbox 四方越界：min x/y 为负 → WGSL u32(f32) 截断钳制路径真机受检；max 越右/下界 → 视口钳制；斜坡深度。",
      triangles: [tri([-7.5, -3.5, 0.25], [4.5, 21.5, 0.5], [27.5, 8.5, 0.75], 9)] },
    { name: "micro-subpixel-grid", viewportWidth: 8, viewportHeight: 8, slotBase: 29,
      expectedFaults: 0, minCovered: 16,
      note: "亚像素微三角+窄条+对角共享边对（边上像素双覆盖、depth-less 决胜）+64 单元网格：triangleCount=68 → 2 个 workgroup、60 个越界尾 lane 同机受检越界守卫。",
      triangles: [tri([3.25, 3.25, 0.2], [3.5, 3.75, 0.2], [3.75, 3.5, 0.2], 12),
        tri([1.25, 1.5, 0.8], [2.0, 1.75, 0.8], [2.75, 1.5, 0.8], 13),
        tri([0, 0, 0.4], [8, 8, 0.4], [8, 0, 0.6], 14),
        tri([0, 0, 0.7], [0, 8, 0.7], [8, 8, 0.7], 15), ...grid] },
    { name: "fault-nan-coordinate", viewportWidth: 6, viewportHeight: 4, slotBase: 31,
      expectedFaults: 1, minCovered: 1,
      note: "NaN 坐标三角走 isFinite 故障通道（哨兵=1、零写入），同批有效三角照常光栅化；CPU 对 NaN 自然零写入（死循环边界）。",
      triangles: [tri([NaN, NaN, 0.5], [2, 6, 0.5], [5, -1, 0.5], 1),
        tri([-1, -1, 0.5], [2, 6, 0.5], [5, -1, 0.5], 2)] },
    { name: "fault-slot-overflow", viewportWidth: 4, viewportHeight: 4,
      slotBase: VISIBILITY_CLEAR_SLOT, expectedFaults: 1, minCovered: 0,
      cpuSkippedReason: "CPU 合同在 API 层拒绝 slot ≥ CLEAR（RangeError fail-closed），无 CPU 光栅基准；逐像素对拍退化为「全保持初值」平凡合同。",
      note: "slotBase=CLEAR 哨兵：slot ≥ CLEAR 故障通道；全部像素保持 CLEAR/0/1.0。",
      triangles: [tri([0, 0, 0.5], [0, 3, 0.5], [3, 3, 0.5], 1)] },
    { name: "fallback-target-alias", viewportWidth: 16, viewportHeight: 12, slotBase: 41,
      expectedFaults: 0, minCovered: 24, initialSlotFill: 7, initialPackedFill: 5,
      note: "可见性目标级（softRasterizeFallback 接线合同端到端）：目标初值含硬件已写内容（slot=7/packed=5/depth=1.0），后备覆盖像素改写 slot=slotBase+i 与 packed、未覆盖像素保持初值；三个三角 y 域两两分离（覆盖带不交、胜者无歧义），深度全 dyadic 且 < 1。",
      triangles: [tri([2, 2, 0.25], [5.5, 9, 0.75], [9, 2, 0.5], 33),
        tri([10, 4, 0.375], [12.75, 11, 0.875], [15.5, 4, 0.625], 34),
        tri([0, 10, 0.125], [1.5, 13, 0.625], [3, 10, 0.375], 35)] },
  ];
}
