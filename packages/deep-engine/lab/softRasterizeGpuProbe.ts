/// <reference types="@webgpu/types" />
/**
 * 软光栅化 kernel 真机探针（追平-Nanite 三件套之三的 GPU 腿；由 scripts/softRasterizeGpuTest.mjs
 * 驱动，headless Chrome + WebGPU）。模式沿用 clusterLodGpuProbe：Node 侧与浏览器共用同一 esbuild
 * bundle——固定三角形集合、10×f32 打包、CPU 参考（webgpu/softRasterizeReference）只此一份
 * （防口径分叉）。浏览器腿走完整 API 路径：triangles（10×f32/三角）+ visibility 三通道 +
 * params uniform + depthKeyScratch → depth_min / write 两次 dispatch → 读回三通道 + 故障哨兵。
 * 数值仲裁（Node 侧）：逐像素命中集必须一致（slot/packedTriangle u32 精确相等），depth 相对容差
 * 1e-5（f32 量化级；CPU f64 与 GPU f32 的插值差 ~1e-7，远小于容差）。全部顶点坐标取 dyadic
 * （k/4，|v| ≤ 65）：edge 函数的差与积在 f32/f64 下均精确表示，命中集判定逐位一致；重叠三角形
 * 深度分离 ≥1.56e-3（dyadic 网格量化间隔），胜者判定对舍入稳健。固定集合：全屏大三角（斜坡
 * 深度）/ z-fighting 顺序互换 / 背面+共线+重点退化 / 越界部分覆盖（负向 bbox 走 WGSL u32(f32)
 * 截断钳制路径，真机受检）/ 微三角亚像素+对角共享边+64 单元网格（triangleCount=68 > 64：
 * 第二个 workgroup 与越界尾线程同机受检）/ NaN 坐标与 slot 溢出故障通道（后者 CPU 合同在 API
 * 层抛 RangeError：对拍退化为「全保持初值」平凡合同，基准来源随证据记录）。
 */

import { createSoftRasterTarget, rasterizeTriangle, VISIBILITY_CLEAR_SLOT,
  type SoftRasterTarget, type SoftTriangle } from "../src/webgpu/softRasterizeReference.js";
import { emitSoftRasterizeWgsl, SOFT_RASTERIZE_BINDINGS, SOFT_RASTERIZE_DEPTH_KEY_CLEAR,
  SOFT_RASTERIZE_DEPTH_MIN_ENTRY_POINT, SOFT_RASTERIZE_WORKGROUP_SIZE,
  SOFT_RASTERIZE_WRITE_ENTRY_POINT } from "../src/webgpu/softRasterizeWgsl.js";

export { createSoftRasterTarget, rasterizeTriangle, VISIBILITY_CLEAR_SLOT,
  type SoftRasterTarget, type SoftTriangle } from "../src/webgpu/softRasterizeReference.js";
export { emitSoftRasterizeWgsl, SOFT_RASTERIZE_BINDINGS, SOFT_RASTERIZE_DEPTH_KEY_CLEAR,
  SOFT_RASTERIZE_DEPTH_MIN_ENTRY_POINT, SOFT_RASTERIZE_WORKGROUP_SIZE,
  SOFT_RASTERIZE_WRITE_ENTRY_POINT } from "../src/webgpu/softRasterizeWgsl.js";

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
}

/** [ax,ay,az, bx,by,bz, cx,cy,cz]；坐标一律 dyadic（k/4）保证 f32/f64 edge 函数逐位一致。 */
type Corner = readonly [number, number, number];

function tri(a: Corner, b: Corner, c: Corner, triangleLocalIndex: number): Omit<SoftTriangle, "slot"> {
  return { ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2],
    cx: c[0], cy: c[1], cz: c[2], triangleLocalIndex };
}

/** 确定性固定三角形集合：五个规定族 + NaN/slot 溢出两个 fail-closed 通道。 */
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
      note: "亚像素微三角+窄条+对角共享边对（边上像素双覆盖、depth-less 决胜）+64 单元网格：triangleCount=68 → 2 个 workgroup、60 个越界尾 lane 同机受检。",
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
  ];
}

export interface SoftRasterCaseRequest {
  readonly name: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly triangleCount: number;
  readonly trianglesBase64: string;
  readonly initialSlotBase64: string;
  readonly initialDepthBase64: string;
  readonly paramsBase64: string;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

/** 案例规格 → 传输载荷（Node 侧打包；params = 16B uniform，4×u32：宽/高/三角数/slotBase）。 */
export function buildSoftRasterRequests(specs: readonly SoftRasterCaseSpec[]): readonly SoftRasterCaseRequest[] {
  return specs.map((spec) => {
    const pixels = spec.viewportWidth * spec.viewportHeight;
    const packedTriangles = new Float32Array(spec.triangles.length * 10);
    spec.triangles.forEach((triangle, index) => {
      packedTriangles.set([triangle.ax, triangle.ay, triangle.az, triangle.bx, triangle.by, triangle.bz,
        triangle.cx, triangle.cy, triangle.cz, triangle.triangleLocalIndex], index * 10);
    });
    const params = new Uint32Array([spec.viewportWidth, spec.viewportHeight,
      spec.triangles.length, spec.slotBase]);
    return {
      name: spec.name, viewportWidth: spec.viewportWidth, viewportHeight: spec.viewportHeight,
      triangleCount: spec.triangles.length,
      trianglesBase64: toBase64(new Uint8Array(packedTriangles.buffer)),
      initialSlotBase64: toBase64(new Uint8Array(new Uint32Array(pixels).fill(VISIBILITY_CLEAR_SLOT).buffer)),
      initialDepthBase64: toBase64(new Uint8Array(new Float32Array(pixels).fill(1).buffer)),
      paramsBase64: toBase64(new Uint8Array(params.buffer)),
    };
  });
}

/** CPU 参考（与 GPU dispatch 同序、同 slot 分配 slotBase+i）；cpuSkipped 案例返回 null。 */
export function runSoftRasterCpuReference(spec: SoftRasterCaseSpec): SoftRasterTarget | null {
  if (spec.cpuSkippedReason !== undefined) return null;
  const target = createSoftRasterTarget(spec.viewportWidth, spec.viewportHeight);
  spec.triangles.forEach((triangle, index) => {
    rasterizeTriangle(target, { ...triangle, slot: spec.slotBase + index });
  });
  return target;
}

export interface SoftRasterCaseReadback {
  readonly slotBase64: string;
  readonly packedTriangleBase64: string;
  readonly depthBase64: string;
  readonly faults: number;
  readonly covered: number;
}

export interface SoftRasterProbeResult {
  readonly adapter: Readonly<Record<string, string | number>>;
  readonly features: readonly string[];
  readonly cases: Readonly<Record<string, SoftRasterCaseReadback>>;
  /** 非法/警告级编译诊断（门禁对象）。 */
  readonly validationMessages: readonly string[];
  /** 全量编译诊断（含 info 级，排障用）。 */
  readonly compilationMessages: readonly string[];
  readonly errors: readonly string[];
}

const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const USAGE_STORAGE = 0x80, USAGE_COPY_DST = 0x8, USAGE_COPY_SRC = 0x4,
  USAGE_MAP_READ = 0x1, USAGE_UNIFORM = 0x40;
const MAP_MODE_READ = 0x1;

async function readBack(device: GPUDevice, buffer: GPUBuffer): Promise<ArrayBuffer> {
  await buffer.mapAsync(MAP_MODE_READ);
  try {
    return new Uint8Array(buffer.getMappedRange() as ArrayBuffer).slice().buffer;
  } finally {
    buffer.unmap();
  }
}

/** 浏览器腿：真实 WebGPU 设备上按完整 API 路径 dispatch soft_rasterize_triangles 并读回。 */
export async function runSoftRasterGpuProbe(requests: readonly SoftRasterCaseRequest[]): Promise<SoftRasterProbeResult> {
  const errors: string[] = [];
  const cases: Record<string, SoftRasterCaseReadback> = {};
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  const device = await adapter.requestDevice({ label: "soft-rasterize-gpu-probe" });
  device.addEventListener?.("uncapturederror", (event) => {
    errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
  });
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  let validationMessages: string[] = [];
  const compilationMessages: string[] = [];
  try {
    // 模块与 pipeline 创建段也包 validation error scope：真实失败原因不得被吞成
    // "invalid due to a previous error"（否则排障只能靠猜）。
    device.pushErrorScope("validation");
    const module = device.createShaderModule({ label: "soft-rasterize", code: emitSoftRasterizeWgsl() });
    compilationMessages.push(...(await module.getCompilationInfo()).messages
      .map(message => `${message.type}:${message.lineNum}:${message.message}`));
    validationMessages = compilationMessages.filter(message => !message.startsWith("info:"));
    // 显式布局（7 槽全量，顺序 = SOFT_RASTERIZE_BINDINGS 合同）：write 入口不引用 faults，
    // layout:"auto" 的两份派生布局会结构不一致；显式布局也是执行器接线的真实形态。
    const layout = device.createBindGroupLayout({ label: "soft-rasterize",
      entries: SOFT_RASTERIZE_BINDINGS.map((binding) => ({
        binding: binding.binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding.type === "uniform" ? "uniform" as const
          : binding.type === "read-only-storage" ? "read-only-storage" as const : "storage" as const },
      })) });
    const pipelineLayout = device.createPipelineLayout({ label: "soft-rasterize", bindGroupLayouts: [layout] });
    const pipelineMin = device.createComputePipeline({ label: "soft-rasterize-depth-min",
      layout: pipelineLayout, compute: { module, entryPoint: SOFT_RASTERIZE_DEPTH_MIN_ENTRY_POINT } });
    const pipelineWrite = device.createComputePipeline({ label: "soft-rasterize-write",
      layout: pipelineLayout, compute: { module, entryPoint: SOFT_RASTERIZE_WRITE_ENTRY_POINT } });
    const pipelineError = await device.popErrorScope();
    if (pipelineError) throw new Error(`Soft rasterize pipeline creation failed: ${pipelineError.message}`);
    for (const request of requests) {
      const pixelBytes = request.viewportWidth * request.viewportHeight * 4;
      const triangles = device.createBuffer({ label: "soft-raster-triangles",
        size: request.triangleCount * 40, usage: USAGE_STORAGE | USAGE_COPY_DST });
      const channels = ["slot", "packed", "depth"].map((name) => device.createBuffer({
        label: `soft-raster-${name}`, size: pixelBytes,
        usage: USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC }));
      const faults = device.createBuffer({ label: "soft-raster-faults", size: 4, usage: USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC });
      const params = device.createBuffer({ label: "soft-raster-params", size: 16,
        usage: USAGE_UNIFORM | USAGE_COPY_DST });
      // 两阶段合同：depthKeyScratch 每次 dispatch 对之前清零为 DEPTH_KEY_CLEAR（u32 max）。
      const scratch = device.createBuffer({ label: "soft-raster-depth-key-scratch", size: pixelBytes,
        usage: USAGE_STORAGE | USAGE_COPY_DST });
      const readbacks = channels.map((_, index) => device.createBuffer({
        label: `soft-raster-readback-${index}`, size: pixelBytes, usage: USAGE_COPY_DST | USAGE_MAP_READ }));
      const faultsReadback = device.createBuffer({ label: "soft-raster-faults-readback", size: 4, usage: USAGE_COPY_DST | USAGE_MAP_READ });
      try {
        // 同步设备操作段整体包 validation error scope：失效命令缓冲不得被读回全零误读（先例纪律）。
        device.pushErrorScope("validation");
        const q = device.queue;
        q.writeBuffer(triangles, 0, base64ToBytes(request.trianglesBase64));
        q.writeBuffer(channels[0]!, 0, base64ToBytes(request.initialSlotBase64));
        q.writeBuffer(channels[1]!, 0, new Uint8Array(pixelBytes));
        q.writeBuffer(channels[2]!, 0, base64ToBytes(request.initialDepthBase64));
        q.writeBuffer(faults, 0, new Uint32Array([0]));
        q.writeBuffer(params, 0, base64ToBytes(request.paramsBase64));
        q.writeBuffer(scratch, 0, new Uint32Array(request.viewportWidth * request.viewportHeight)
          .fill(SOFT_RASTERIZE_DEPTH_KEY_CLEAR));
        const bindGroup = device.createBindGroup({ layout,
          entries: [triangles, ...channels, params, faults, scratch].map((buffer, binding) =>
            ({ binding, resource: { buffer } })) });
        const encoder = device.createCommandEncoder({ label: "soft-rasterize" });
        const pass = encoder.beginComputePass({ label: "soft-rasterize" });
        pass.setPipeline(pipelineMin);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(request.triangleCount / SOFT_RASTERIZE_WORKGROUP_SIZE), 1, 1);
        // 第二阶段 dispatch：WebGPU dispatch 边界 = 全局屏障，等键回写胜者（合同 2）。
        pass.setPipeline(pipelineWrite);
        pass.dispatchWorkgroups(Math.ceil(request.triangleCount / SOFT_RASTERIZE_WORKGROUP_SIZE), 1, 1);
        pass.end();
        readbacks.forEach((readback, index) =>
          encoder.copyBufferToBuffer(channels[index]!, 0, readback, 0, pixelBytes));
        encoder.copyBufferToBuffer(faults, 0, faultsReadback, 0, 4);
        device.queue.submit([encoder.finish()]);
        const validationError = await device.popErrorScope();
        if (validationError) throw new Error(`Soft rasterize GPU validation failed: ${validationError.message}`);
        const bytes = await Promise.all([...readbacks, faultsReadback].map((buffer) => readBack(device, buffer)));
        const slots = new Uint32Array(bytes[0]!);
        cases[request.name] = {
          slotBase64: toBase64(new Uint8Array(bytes[0]!)),
          packedTriangleBase64: toBase64(new Uint8Array(bytes[1]!)),
          depthBase64: toBase64(new Uint8Array(bytes[2]!)),
          faults: new Uint32Array(bytes[3]!)[0]!,
          covered: [...slots].filter(word => word !== VISIBILITY_CLEAR_SLOT).length,
        };
      } finally {
        for (const buffer of [triangles, ...channels, params, faults, scratch, faultsReadback, ...readbacks]) buffer.destroy();
      }
    }
  } finally {
    device.destroy();
  }
  return {
    adapter: { vendor: info?.vendor ?? "", architecture: info?.architecture ?? "",
      device: info?.device ?? "", description: info?.description ?? "" },
    features: [...adapter.features].sort(),
    cases, validationMessages, compilationMessages, errors,
  };
}
