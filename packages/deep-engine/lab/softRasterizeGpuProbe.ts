/// <reference types="@webgpu/types" />
/**
 * 软光栅化 kernel 真机探针（追平-Nanite 三件套之三的 GPU 腿；由 scripts/softRasterizeGpuTest.mjs
 * 驱动，headless Chrome + WebGPU）。模式沿用 clusterLodGpuProbe：Node 侧与浏览器共用同一 esbuild
 * bundle——固定三角形集合（lab/softRasterizeCases.ts）、10×f32 打包、CPU 参考（走
 * webgpu/softRasterizeFallback 合同层：packSoftRasterTriangles / rasterizePackedTrianglesCpu，
 * 与渲染器 VisibilityBufferPath 后备段同一函数，防口径分叉）。
 * 浏览器腿走完整 API 路径：triangles（10×f32/三角）+ visibility 三通道 +
 * params uniform + depthKeyScratch → depth_min / write 两次 dispatch → 读回三通道 + 故障哨兵。
 * 数值仲裁（Node 侧）：逐像素命中集必须一致（slot/packedTriangle u32 精确相等），depth 相对容差
 * 1e-5（f32 量化级；CPU f64 与 GPU f32 的插值差 ~1e-7，远小于容差）。
 */

import { createSoftRasterTarget, VISIBILITY_CLEAR_SLOT,
  type SoftRasterTarget, type SoftTriangle } from "../src/webgpu/softRasterizeReference.js";
import { packSoftRasterTriangles, rasterizePackedTrianglesCpu } from "../src/webgpu/softRasterizeFallback.js";
import { emitSoftRasterizeWgsl, SOFT_RASTERIZE_BINDINGS, SOFT_RASTERIZE_DEPTH_KEY_CLEAR,
  SOFT_RASTERIZE_DEPTH_MIN_ENTRY_POINT, SOFT_RASTERIZE_WORKGROUP_SIZE,
  SOFT_RASTERIZE_WRITE_ENTRY_POINT } from "../src/webgpu/softRasterizeWgsl.js";
import { buildSoftRasterCases, type SoftRasterCaseSpec } from "./softRasterizeCases.js";

export { buildSoftRasterCases, type SoftRasterCaseSpec } from "./softRasterizeCases.js";
export { createSoftRasterTarget, rasterizeTriangle, VISIBILITY_CLEAR_SLOT,
  type SoftRasterTarget, type SoftTriangle } from "../src/webgpu/softRasterizeReference.js";
export { packSoftRasterTriangles, rasterizePackedTrianglesCpu } from "../src/webgpu/softRasterizeFallback.js";
export { emitSoftRasterizeWgsl, SOFT_RASTERIZE_BINDINGS, SOFT_RASTERIZE_DEPTH_KEY_CLEAR,
  SOFT_RASTERIZE_DEPTH_MIN_ENTRY_POINT, SOFT_RASTERIZE_WORKGROUP_SIZE,
  SOFT_RASTERIZE_WRITE_ENTRY_POINT } from "../src/webgpu/softRasterizeWgsl.js";

export interface SoftRasterCaseRequest {
  readonly name: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly triangleCount: number;
  readonly trianglesBase64: string;
  readonly initialSlotBase64: string;
  readonly initialPackedBase64: string;
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
    const packedTriangles = packSoftRasterTriangles(spec.triangles);
    const params = new Uint32Array([spec.viewportWidth, spec.viewportHeight,
      spec.triangles.length, spec.slotBase]);
    return {
      name: spec.name, viewportWidth: spec.viewportWidth, viewportHeight: spec.viewportHeight,
      triangleCount: spec.triangles.length,
      trianglesBase64: toBase64(new Uint8Array(packedTriangles.buffer)),
      initialSlotBase64: toBase64(new Uint8Array(new Uint32Array(pixels)
        .fill(spec.initialSlotFill ?? VISIBILITY_CLEAR_SLOT).buffer)),
      initialPackedBase64: toBase64(new Uint8Array(new Uint32Array(pixels)
        .fill(spec.initialPackedFill ?? 0).buffer)),
      initialDepthBase64: toBase64(new Uint8Array(new Float32Array(pixels).fill(1).buffer)),
      paramsBase64: toBase64(new Uint8Array(params.buffer)),
    };
  });
}

/** CPU 参考（与 GPU dispatch 同序、同 slot 分配 slotBase+i，经 fallback 合同 CPU 桥）；cpuSkipped 案例返回 null。 */
export function runSoftRasterCpuReference(spec: SoftRasterCaseSpec): SoftRasterTarget | null {
  if (spec.cpuSkippedReason !== undefined) return null;
  const target = createSoftRasterTarget(spec.viewportWidth, spec.viewportHeight);
  target.slot.fill(spec.initialSlotFill ?? VISIBILITY_CLEAR_SLOT);
  target.packedTriangle.fill(spec.initialPackedFill ?? 0); // 可见性目标级初值：硬件已写内容；depth 初值恒 1.0。
  rasterizePackedTrianglesCpu(target, packSoftRasterTriangles(spec.triangles), spec.triangles.length, spec.slotBase);
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
        q.writeBuffer(channels[1]!, 0, base64ToBytes(request.initialPackedBase64));
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
