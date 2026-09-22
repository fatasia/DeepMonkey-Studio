/// <reference types="@webgpu/types" />
/**
 * 软光栅后备接线合同（追平-Nanite 三件套之三的「接线」切片）：VisibilityBufferPath 的后备扩展。
 * [输入] 选层（REFINE_SENTINEL / 误差超限判定）后仍超屏幕误差阈值的 cluster 微三角，
 * 经 packSoftRasterTriangles 打包（每三角 10×f32：窗口 xyz×3 + cluster 内局部索引）——
 * 与 kernel（softRasterizeWgsl binding 0）同一打包合同，单一来源禁止双写。
 * [输出] 写入现有 visibility 目标的三缓冲 alias：slot / packedTriangle / depth，编码空间
 * 与硬件路径（rg32uint 附件 + depth32float）逐通道同义；resolve 后备变体
 * （visibilityBufferWgsl.fragmentVisibilityResolveFallback）按同一着色公式消费。
 *
 * == 合同 ==
 * 1. 打包即合同：packSoftRasterTriangles 是渲染器、CPU 桥与真机探针（softRasterizeGpuProbe）
 *   共用的唯一打包点；unpackSoftRasterTriangle 是唯一解包点（f32 逐位往返）。
 * 2. CPU 桥：rasterizePackedTrianglesCpu 从同一打包数据出发，slot 分配 slotBase+i 与 GPU
 *   dispatch 完全同序（kernel：slot = params.slotBase + triangleIndex）——「可见性目标级」
 *   对拍的基准腿；slot 越界（≥ CLEAR）在 API 层抛 RangeError（fail-closed，与
 *   softRasterizeReference.rasterizeTriangle 合同一致；探针的溢出案例由此退化为平凡合同）。
 * 3. slot 语义：每三角一个 slot（kernel 合同决定），slotBase 由 VisibilityBufferPath 在硬件
 *   slot 之后分配；每 slot 的材质表行由调用方按三角顺序给出（slotRows，16 f32/行）。
 * 4. fail-closed：编码入参（数量/长度/容量/slot 上限）任一不符，encodeRaster 返回 undefined
 *   ——该帧零后备、硬件输出原样成立。kernel 内部故障走 softRasterFaults 哨兵，真机探针
 *   逐案例读回仲裁；渲染帧内的哨兵读回与「非零整批拒绝」为遥测 deferred（本切片诚实边界）。
 * 5. 资源：全部 GPU 资源经 DeviceSession own/release；显式 7 槽布局（探针先例：write 入口
 *   不引用 faults，layout:"auto" 的两份派生布局会结构不一致）。viewport/容量变化时重建。
 */

import type { DeviceSession } from "./deviceSession.js";
import { type SoftRasterTarget, type SoftTriangle, rasterizeTriangle } from "./softRasterizeReference.js";
import { emitSoftRasterizeWgsl, SOFT_RASTERIZE_BINDINGS, SOFT_RASTERIZE_DEPTH_KEY_CLEAR,
  SOFT_RASTERIZE_DEPTH_MIN_ENTRY_POINT, SOFT_RASTERIZE_WORKGROUP_SIZE,
  SOFT_RASTERIZE_WRITE_ENTRY_POINT } from "./softRasterizeWgsl.js";
import { VISIBILITY_CLEAR_SLOT, VISIBILITY_SLOT_ROW_FLOATS } from "./visibilityBufferEncoding.js";
import { VISIBILITY_RESOLVE_WGSL } from "./visibilityBufferWgsl.js";

/** 每三角打包浮点数：9 位置 + 1 cluster 内局部索引（kernel binding 0 的行距）。 */
export const SOFT_RASTERIZE_TRIANGLE_FLOATS = 10;
/** 软光栅后备三角的局部索引形态：不含 slot（slot 由执行器按 slotBase+i 分配）。 */
export type SoftRasterTriangleInput = Omit<SoftTriangle, "slot">;

/** 一帧的后备输入：超误差 cluster 三角打包 + 逐 slot 材质表行（VisibilityFrameRequest.softRaster）。 */
export interface SoftRasterFallbackFrameInput {
  /** packSoftRasterTriangles 产出；长度 ≥ triangleCount × 10。 */
  readonly triangles: Float32Array<ArrayBuffer>;
  readonly triangleCount: number;
  /** 材质表行（VISIBILITY_SLOT_ROW_FLOATS × f32/行，行序 = 三角序 = slot 序）。 */
  readonly slotRows: Float32Array<ArrayBuffer>;
}

/** 打包（唯一打包点）：逐位写 10×f32/三角；调用方保证坐标有限、局部索引 0..125。 */
export function packSoftRasterTriangles(triangles: readonly SoftRasterTriangleInput[],
  target = new Float32Array(triangles.length * SOFT_RASTERIZE_TRIANGLE_FLOATS)): Float32Array<ArrayBuffer> {
  if (target.length !== triangles.length * SOFT_RASTERIZE_TRIANGLE_FLOATS) {
    throw new RangeError("Soft raster pack target must hold exactly 10 floats per triangle.");
  }
  triangles.forEach((triangle, index) => {
    target.set([triangle.ax, triangle.ay, triangle.az, triangle.bx, triangle.by, triangle.bz,
      triangle.cx, triangle.cy, triangle.cz, triangle.triangleLocalIndex], index * SOFT_RASTERIZE_TRIANGLE_FLOATS);
  });
  return target;
}

/** 解包（唯一解包点）：f32 逐位往返；行距/长度不符抛 RangeError。 */
export function unpackSoftRasterTriangle(packed: Float32Array<ArrayBuffer>, index: number): SoftRasterTriangleInput {
  const base = index * SOFT_RASTERIZE_TRIANGLE_FLOATS;
  if (!Number.isSafeInteger(index) || index < 0 || base + SOFT_RASTERIZE_TRIANGLE_FLOATS > packed.length) {
    throw new RangeError("Soft raster unpack index is outside the packed triangle buffer.");
  }
  return { ax: packed[base]!, ay: packed[base + 1]!, az: packed[base + 2]!,
    bx: packed[base + 3]!, by: packed[base + 4]!, bz: packed[base + 5]!,
    cx: packed[base + 6]!, cy: packed[base + 7]!, cz: packed[base + 8]!,
    triangleLocalIndex: packed[base + 9]! };
}

/** CPU 桥：同一打包 → CPU 参考目标（slot = slotBase+i，与 GPU dispatch 同序）。返回写入像素数。 */
export function rasterizePackedTrianglesCpu(target: SoftRasterTarget, packed: Float32Array<ArrayBuffer>,
  triangleCount: number, slotBase: number): number {
  if (!Number.isSafeInteger(triangleCount) || triangleCount < 0
    || packed.length < triangleCount * SOFT_RASTERIZE_TRIANGLE_FLOATS) {
    throw new RangeError("CPU fallback reference needs triangleCount within the packed buffer.");
  }
  let written = 0;
  for (let index = 0; index < triangleCount; index += 1) {
    written += rasterizeTriangle(target, { ...unpackSoftRasterTriangle(packed, index), slot: slotBase + index });
  }
  return written;
}

/**
 * 软光栅后备执行器：soft_rasterize 两阶段 kernel + resolve 后备变体管线的 GPU 资源与编码。
 * ensure 失败被记录为 failureReason（渲染循环永不因该特性阻塞）；encodeRaster 返回
 * undefined 表示该帧无后备（未就绪/入参 fail-closed），visibility 主路径原样成立。
 */
export class SoftRasterizeFallback {
  private prepared: Promise<void> | undefined;
  private failure: string | undefined;
  private pipelineMin: GPUComputePipeline | undefined;
  private pipelineWrite: GPUComputePipeline | undefined;
  private resolveVariant: GPURenderPipeline | undefined;
  private bindGroup: GPUBindGroup | undefined;
  private triangles: GPUBuffer | undefined;
  private channels: [GPUBuffer, GPUBuffer, GPUBuffer] | undefined;
  private params: GPUBuffer | undefined;
  private faults: GPUBuffer | undefined;
  private scratch: GPUBuffer | undefined;
  private pixels = 0;
  private capacity = 0;
  private scratchClear: Uint32Array<ArrayBuffer> | undefined;

  constructor(private readonly session: DeviceSession) {}

  get failureReason(): string | undefined { return this.failure; }
  /** resolve 后备变体管线（fragmentVisibilityResolveFallback）；未就绪为 undefined。 */
  get resolvePipeline(): GPURenderPipeline | undefined { return this.resolveVariant; }

  /** 幂等预热；softRaster 模块与 resolve 模块由调用方传入（复用主路径的编译校验结果）。 */
  ensure(softRasterModule?: GPUShaderModule, resolveModule?: GPUShaderModule): Promise<void> {
    if (this.prepared) return this.prepared;
    this.prepared = this.create(softRasterModule, resolveModule).catch(error => {
      this.failure = error instanceof Error ? error.message : String(error);
    });
    return this.prepared;
  }

  private async create(softRasterModule?: GPUShaderModule, resolveModule?: GPUShaderModule): Promise<void> {
    const device = this.session.device;
    const module = softRasterModule ?? device.createShaderModule({ label: "Deep soft rasterize", code: emitSoftRasterizeWgsl() });
    const resolveShader = resolveModule ?? device.createShaderModule({ label: "Deep visibility resolve", code: VISIBILITY_RESOLVE_WGSL });
    for (const shader of [module, resolveShader]) {
      const errors = (await shader.getCompilationInfo()).messages.filter(message => message.type === "error");
      if (errors.length) throw new Error(errors.map(message => `WGSL ${message.lineNum}: ${message.message}`).join("\n"));
    }
    // 显式 7 槽布局（顺序 = SOFT_RASTERIZE_BINDINGS 合同）：两入口共用（探针先例）。
    const layout = device.createBindGroupLayout({ label: "Deep soft rasterize",
      entries: SOFT_RASTERIZE_BINDINGS.map(binding => ({
        binding: binding.binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding.type === "uniform" ? "uniform" as const
          : binding.type === "read-only-storage" ? "read-only-storage" as const : "storage" as const } })) });
    const pipelineLayout = device.createPipelineLayout({ label: "Deep soft rasterize", bindGroupLayouts: [layout] });
    this.pipelineMin = await device.createComputePipelineAsync({ label: "Deep soft rasterize depth-min",
      layout: pipelineLayout, compute: { module, entryPoint: SOFT_RASTERIZE_DEPTH_MIN_ENTRY_POINT } });
    this.pipelineWrite = await device.createComputePipelineAsync({ label: "Deep soft rasterize write",
      layout: pipelineLayout, compute: { module, entryPoint: SOFT_RASTERIZE_WRITE_ENTRY_POINT } });
    this.resolveVariant = await device.createRenderPipelineAsync({
      label: "Deep visibility resolve fallback", layout: "auto",
      vertex: { module: resolveShader, entryPoint: "vertexFullscreen" },
      fragment: { module: resolveShader, entryPoint: "fragmentVisibilityResolveFallback", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" } });
  }

  /** resolve 后备变体 group(1) 的追加绑定（binding 3..5 = slot/packed/depth 三缓冲）。 */
  resolveEntries(): readonly GPUBindGroupEntry[] {
    const channels = this.channels;
    if (!channels) throw new Error("Soft rasterize fallback channels are not allocated.");
    return [{ binding: 3, resource: { buffer: channels[0] } }, { binding: 4, resource: { buffer: channels[1] } },
      { binding: 5, resource: { buffer: channels[2] } }];
  }

  /**
   * 编码后备 compute pass（depth_min → write 两次 dispatch，同一 pass 顺序执行）。
   * 返回写入三角数；未就绪或入参 fail-closed 返回 undefined（该帧零后备）。
   */
  encodeRaster(encoder: GPUCommandEncoder, input: SoftRasterFallbackFrameInput,
    slotBase: number, width: number, height: number): number | undefined {
    if (this.session.state !== "ready" || !this.pipelineMin || !this.pipelineWrite || this.failure !== undefined) return undefined;
    const { triangleCount } = input;
    if (!(triangleCount >= 1) || input.triangles.length < triangleCount * SOFT_RASTERIZE_TRIANGLE_FLOATS
      || input.slotRows.length < triangleCount * VISIBILITY_SLOT_ROW_FLOATS
      || slotBase + triangleCount > VISIBILITY_CLEAR_SLOT) return undefined;
    try {
      this.ensureCapacity(width, height, triangleCount);
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error); // 资源域故障对该特性是持久的。
      return undefined; // 该帧零后备（硬件输出原样成立）。
    }
    const device = this.session.device;
    device.queue.writeBuffer(this.triangles!, 0, input.triangles, 0, triangleCount * SOFT_RASTERIZE_TRIANGLE_FLOATS);
    device.queue.writeBuffer(this.params!, 0, new Uint32Array([width, height, triangleCount, slotBase]));
    device.queue.writeBuffer(this.faults!, 0, new Uint32Array([0]));
    device.queue.writeBuffer(this.scratch!, 0, this.scratchClear!);
    const pass = encoder.beginComputePass({ label: "Deep visibility soft rasterize fallback" });
    pass.setPipeline(this.pipelineMin);
    pass.setBindGroup(0, this.bindGroup!);
    pass.dispatchWorkgroups(Math.ceil(triangleCount / SOFT_RASTERIZE_WORKGROUP_SIZE), 1, 1);
    // 第二阶段 dispatch：WebGPU dispatch 边界 = 全局屏障，等键回写胜者（kernel 合同 2）。
    pass.setPipeline(this.pipelineWrite);
    pass.dispatchWorkgroups(Math.ceil(triangleCount / SOFT_RASTERIZE_WORKGROUP_SIZE), 1, 1);
    pass.end();
    return triangleCount;
  }

  /** 按 viewport/容量惰性分配；变化即重建（release 幂等，中途失败统一回收并重置状态）。 */
  private ensureCapacity(width: number, height: number, triangleCount: number): void {
    const device = this.session.device;
    const pixels = width * height;
    const capacity = Math.max(64, 1 << Math.ceil(Math.log2(Math.max(1, triangleCount))));
    const created: GPUBuffer[] = [];
    try {
      const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      if (pixels !== this.pixels || this.scratch === undefined) {
        this.disposeTarget();
        const channels: [GPUBuffer, GPUBuffer, GPUBuffer] = [
          this.owned(created, device.createBuffer({ label: "Deep soft raster visibility slot", size: pixels * 4, usage: usage | GPUBufferUsage.COPY_SRC })),
          this.owned(created, device.createBuffer({ label: "Deep soft raster visibility packed", size: pixels * 4, usage: usage | GPUBufferUsage.COPY_SRC })),
          this.owned(created, device.createBuffer({ label: "Deep soft raster visibility depth", size: pixels * 4, usage: usage | GPUBufferUsage.COPY_SRC }))];
        this.scratch = this.owned(created, device.createBuffer({ label: "Deep soft raster depth-key scratch", size: pixels * 4, usage }));
        this.channels = channels; this.pixels = pixels;
        this.scratchClear = new Uint32Array(pixels).fill(SOFT_RASTERIZE_DEPTH_KEY_CLEAR);
        this.bindGroup = undefined;
      }
      if (this.triangles === undefined || capacity > this.capacity) {
        if (this.triangles !== undefined) this.session.release(this.triangles);
        this.triangles = this.owned(created, device.createBuffer({ label: "Deep soft raster triangles",
          size: capacity * SOFT_RASTERIZE_TRIANGLE_FLOATS * 4, usage }));
        this.capacity = capacity;
      }
      if (this.params === undefined) {
        this.params = this.owned(created, device.createBuffer({ label: "Deep soft raster params",
          size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
        this.faults = this.owned(created, device.createBuffer({ label: "Deep soft raster faults",
          size: 4, usage: usage | GPUBufferUsage.COPY_SRC }));
      }
      if (this.bindGroup === undefined) {
        this.bindGroup = device.createBindGroup({ layout: this.pipelineMin!.getBindGroupLayout(0),
          entries: [this.triangles!, ...this.channels!, this.params!, this.faults!, this.scratch!]
            .map((buffer, binding) => ({ binding, resource: { buffer } })) });
      }
    } catch (error) {
      for (const buffer of created) this.session.release(buffer);
      this.disposeTarget();
      if (this.triangles !== undefined) { this.session.release(this.triangles); this.triangles = undefined; this.capacity = 0; }
      if (this.params !== undefined) { this.session.release(this.params); this.params = undefined; }
      if (this.faults !== undefined) { this.session.release(this.faults); this.faults = undefined; }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private owned(created: GPUBuffer[], buffer: GPUBuffer): GPUBuffer {
    this.session.own(buffer); created.push(buffer); return buffer;
  }

  /** 释放 viewport 尺寸域的三缓冲 + scratch（bindGroup 随之失效）；params/faults/triangles 保留。 */
  private disposeTarget(): void {
    const channels = this.channels; const scratch = this.scratch;
    this.channels = undefined; this.scratch = undefined; this.bindGroup = undefined; this.pixels = 0;
    for (const buffer of [...channels ?? [], ...(scratch === undefined ? [] : [scratch])]) this.session.release(buffer);
  }

  dispose(): void {
    const held = [this.triangles, ...this.channels ?? [], this.params, this.faults, this.scratch]
      .filter((buffer): buffer is GPUBuffer => buffer !== undefined);
    this.pipelineMin = undefined; this.pipelineWrite = undefined; this.resolveVariant = undefined;
    this.triangles = undefined; this.channels = undefined; this.params = undefined;
    this.faults = undefined; this.scratch = undefined; this.bindGroup = undefined;
    this.pixels = 0; this.capacity = 0; this.scratchClear = undefined;
    for (const buffer of held) this.session.release(buffer);
  }
}
