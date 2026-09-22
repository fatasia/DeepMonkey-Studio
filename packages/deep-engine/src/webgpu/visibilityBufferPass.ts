/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import { rasterMode } from "./pipelines.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { PacketLodResources } from "./packetLodResources.js";
import { packVisibilitySlotRow, visibilitySlotRowFromInstance, INSTANCE_ROW_FLOATS,
  invertMat4, VISIBILITY_ATTACHMENT_FORMAT, VISIBILITY_CLEAR_SLOT, VISIBILITY_SLOT_ROW_FLOATS } from "./visibilityBufferEncoding.js";
import { VISIBILITY_RASTER_WGSL, VISIBILITY_RESOLVE_WGSL, VISIBILITY_BLIT_WGSL } from "./visibilityBufferWgsl.js";
import { type SoftRasterFallbackFrameInput, SoftRasterizeFallback } from "./softRasterizeFallback.js";
import type { PbrTransientTextureHandle, PbrTransientTexturePool } from "./pbrTransientTexturePool.js";
import { runResourceCleanup } from "./resourceCleanup.js";

/** 单帧可见性 slot 容量：meta 走动态 offset uniform 窗口（64KB 上限内）。 */
export const MAX_VISIBILITY_SLOTS = 256;
const RESOLVE_UNIFORM_FLOATS = 36;

export interface VisibilityDrawInputs {
  readonly batches: ReadonlyMap<string, CachedPacketBatch>;
  readonly geometries: ReadonlyMap<string, CachedPacketGeometry>;
  readonly lod: PacketLodResources | undefined;
  readonly deformationActive: boolean;
}

export interface VisibilityFrameRequest {
  readonly hdrView: GPUTextureView;
  readonly depthView: GPUTextureView;
  readonly width: number;
  readonly height: number;
  /** 当前帧 96 浮点 frame uniform 内容（PBR_FRAME_FLOAT_OFFSETS 布局，同缓冲同值）。 */
  readonly frameData: Float32Array;
  readonly inputs: VisibilityDrawInputs;
  /** 软光栅后备输入（超误差 cluster 三角打包，softRasterizeFallback 合同）；undefined=本帧无后备。 */
  readonly softRaster?: SoftRasterFallbackFrameInput;
}

export interface VisibilityFrameStats {
  readonly slotCount: number;
  readonly drawCalls: number;
  /** 因容量/布局不满足而留在 forward 路径的候选绘制数。 */
  readonly skippedDraws: number;
  /** 软光栅后备实际写入三角数；仅在后备 pass 真正编码的帧存在。 */
  readonly fallbackTriangles?: number;
}

interface VisibilityResources {
  readonly frameLayout: GPUBindGroupLayout;
  readonly metaLayout: GPUBindGroupLayout;
  readonly frameGroup: GPUBindGroup;
  readonly metaGroup: GPUBindGroup;
  readonly resolveGroup: GPUBindGroup;
  readonly tableGroup: GPUBindGroup;
  readonly resolveUniform: GPUBuffer;
  readonly materialTable: GPUBuffer;
  readonly metaUniform: GPUBuffer;
  readonly alignment: number;
}

/**
 * P0-2 可见性 buffer 着色路径（opt-in，默认关）。三段：
 * ① meshlet id 光栅化（与 forward 共享深度，less-equal 只写 forward 已见表面）
 * ② 全屏材质还原（slot 表 albedo + 深度重建法线 + 太阳直射；哨兵像素透传 forward）
 * ③ HDR 回写（composite → targets.hdr，后续后处理与透明合成不变）。
 * 软光栅后备（features.softRasterizeFallback，默认关，softRasterizeFallback.ts 合同）：
 * 在 ② 之前插入 soft_rasterize compute pass——选层后仍超误差阈值的 cluster 微三角写
 * visibility 三缓冲（slot 接在硬件之后），② 改走后备变体入口消费三缓冲；关闭或本帧
 * 无超误差输入时编码序列与既有三段完全一致（合同测试受检）。
 * 流水线未就绪/失败/无覆盖 slot 时跳过对应段并如实计数 —— forward 输出原样成立。
 */
export class VisibilityBufferPath {
  private resources: VisibilityResources | undefined;
  private readonly rasterPipelines = new Map<"ccw" | "cw" | "double", GPURenderPipeline>();
  private resolvePipeline: GPURenderPipeline | undefined;
  private blitPipeline: GPURenderPipeline | undefined;
  private preparing: Promise<void> | undefined;
  private failure: string | undefined;

  constructor(private readonly session: DeviceSession, private readonly transient: PbrTransientTexturePool,
    private readonly frameBuffer: GPUBuffer, private readonly softRasterize?: SoftRasterizeFallback) {}

  get failureReason(): string | undefined { return this.failure; }

  /** 幂等预热；失败被记录为 failureReason，渲染循环永不因该特性阻塞。 */
  ensure(): Promise<void> {
    if (this.preparing) return this.preparing;
    this.preparing = this.create().catch(error => {
      this.failure = error instanceof Error ? error.message : String(error);
    });
    return this.preparing;
  }

  private async create(): Promise<void> {
    const device = this.session.device;
    const module = device.createShaderModule({ label: "Deep visibility raster", code: VISIBILITY_RASTER_WGSL });
    const resolveModule = device.createShaderModule({ label: "Deep visibility resolve", code: VISIBILITY_RESOLVE_WGSL });
    const blitModule = device.createShaderModule({ label: "Deep visibility blit", code: VISIBILITY_BLIT_WGSL });
    // 软光栅后备（opt-in）：复用同一 resolve 模块建变体管线；失败只关后备，不拖垮主路径。
    await this.softRasterize?.ensure(undefined, resolveModule);
    for (const shader of [module, resolveModule, blitModule]) {
      const info = await shader.getCompilationInfo();
      const errors = info.messages.filter(message => message.type === "error");
      if (errors.length) throw new Error(errors.map(message => `WGSL ${message.lineNum}: ${message.message}`).join("\n"));
    }
    const frameLayout = device.createBindGroupLayout({ label: "Deep visibility frame", entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: 64 } }] });
    const metaLayout = device.createBindGroupLayout({ label: "Deep visibility meta", entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 } }] });
    const resolveLayout = device.createBindGroupLayout({ label: "Deep visibility resolve uniforms", entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: RESOLVE_UNIFORM_FLOATS * 4 } }] });
    const viewsLayout = device.createBindGroupLayout({ label: "Deep visibility views", entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }] });
    const tableLayout = device.createBindGroupLayout({ label: "Deep visibility material table", entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }] });
    const rasterBuffers: GPUVertexBufferLayout[] = [
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
      { arrayStride: 144, stepMode: "instance", attributes: [
        { shaderLocation: 2, offset: 0, format: "float32x4" }, { shaderLocation: 3, offset: 16, format: "float32x4" },
        { shaderLocation: 4, offset: 32, format: "float32x4" }] },
      { arrayStride: 4, attributes: [{ shaderLocation: 5, offset: 0, format: "uint32" }] }];
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, metaLayout] });
    for (const raster of ["ccw", "cw", "double"] as const) {
      this.rasterPipelines.set(raster, await device.createRenderPipelineAsync({
        label: `Deep visibility raster ${raster}`, layout: pipelineLayout,
        vertex: { module, entryPoint: "vertexVisibility", buffers: rasterBuffers },
        fragment: { module, entryPoint: "fragmentVisibility", targets: [{ format: VISIBILITY_ATTACHMENT_FORMAT }] },
        primitive: { topology: "triangle-list", cullMode: raster === "double" ? "none" : "back",
          frontFace: raster === "cw" ? "cw" : "ccw" },
        depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "less-equal" } }));
    }
    this.resolvePipeline = await device.createRenderPipelineAsync({
      label: "Deep visibility resolve", layout: "auto",
      vertex: { module: resolveModule, entryPoint: "vertexFullscreen" },
      fragment: { module: resolveModule, entryPoint: "fragmentVisibilityResolve", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" } });
    this.blitPipeline = await device.createRenderPipelineAsync({
      label: "Deep visibility blit", layout: "auto",
      vertex: { module: blitModule, entryPoint: "vertexFullscreen" },
      fragment: { module: blitModule, entryPoint: "fragmentBlit", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" } });
    const alignment = Math.max(256, device.limits.minUniformBufferOffsetAlignment);
    const created: GPUBuffer[] = [];
    try {
      const metaUniform = this.owned(device.createBuffer({ label: "Deep visibility meta",
        size: MAX_VISIBILITY_SLOTS * alignment, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
      const materialTable = this.owned(device.createBuffer({ label: "Deep visibility material table",
        size: MAX_VISIBILITY_SLOTS * VISIBILITY_SLOT_ROW_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      const resolveUniform = this.owned(device.createBuffer({ label: "Deep visibility resolve uniforms",
        size: RESOLVE_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
      created.push(metaUniform, materialTable, resolveUniform);
      this.resources = { alignment, metaUniform, materialTable, resolveUniform, frameLayout, metaLayout,
        frameGroup: device.createBindGroup({ layout: frameLayout, entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }] }),
        metaGroup: device.createBindGroup({ layout: metaLayout, entries: [{ binding: 0, resource: { buffer: metaUniform, size: 16 } }] }),
        resolveGroup: device.createBindGroup({ layout: resolveLayout, entries: [{ binding: 0, resource: { buffer: resolveUniform } }] }),
        tableGroup: device.createBindGroup({ layout: tableLayout, entries: [{ binding: 0, resource: { buffer: materialTable } }] }) };
    } catch (error) {
      runResourceCleanup("Visibility buffer resource cleanup failed.", created.map(value => () => this.session.release(value)));
      throw error;
    }
  }

  private owned<T extends GPUBuffer>(buffer: T): T { this.session.own(buffer); return buffer; }

  /** 编码三段 pass；返回本帧 slot 统计。管线未就绪返回 undefined（该帧纯 forward）。 */
  encodeComposite(encoder: GPUCommandEncoder, request: VisibilityFrameRequest): VisibilityFrameStats | undefined {
    const resources = this.resources;
    if (this.session.state !== "ready" || !resources || !this.resolvePipeline || !this.blitPipeline
      || this.rasterPipelines.size !== 3) return undefined;
    const { inputs, frameData } = request;
    if (inputs.deformationActive) return { slotCount: 0, drawCalls: 0, skippedDraws: 0 };
    const device = this.session.device;
    const visibility = this.transient.acquire({ resourceId: "visibility-buffer", format: VISIBILITY_ATTACHMENT_FORMAT,
      width: request.width, height: request.height, sampleCount: 1,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    try {
      const meta = new Uint32Array(MAX_VISIBILITY_SLOTS * 4);
      const table = new Float32Array(MAX_VISIBILITY_SLOTS * VISIBILITY_SLOT_ROW_FLOATS);
      let slot = 0, drawCalls = 0, skippedDraws = 0;
      const pass = encoder.beginRenderPass({ label: "Deep visibility raster", colorAttachments: [{
        view: visibility.view,
        clearValue: { r: VISIBILITY_CLEAR_SLOT, g: VISIBILITY_CLEAR_SLOT, b: VISIBILITY_CLEAR_SLOT, a: 0 },
        loadOp: "clear", storeOp: "store" }],
        depthStencilAttachment: { view: request.depthView, depthLoadOp: "load", depthStoreOp: "store" } });
      let activePipeline: GPURenderPipeline | undefined;
      try {
        for (const batch of inputs.batches.values()) {
          const source = batch.source;
          if (source.alphaMode !== "OPAQUE" || source.textures !== undefined || source.lod?.strategy !== "author-selected") continue;
          const draws = inputs.lod?.draws(source.key);
          if (!draws) continue;
          for (const draw of draws) {
            if (slot >= MAX_VISIBILITY_SLOTS) { skippedDraws += 1; continue; }
            const geometry = inputs.geometries.get(draw.geometry);
            if (!geometry?.mesh.meshletVisibility || draw.instanceByteOffset % (INSTANCE_ROW_FLOATS * 4) !== 0) {
              skippedDraws += 1; continue;
            }
            const rowOffset = draw.instanceByteOffset / 4;
            if (rowOffset + INSTANCE_ROW_FLOATS > source.data.length) { skippedDraws += 1; continue; }
            const pipeline = this.rasterPipelines.get(rasterMode(source.mirrored, source.doubleSided))!;
            if (pipeline !== activePipeline) { pass.setPipeline(pipeline); pass.setBindGroup(0, resources.frameGroup); activePipeline = pipeline; }
            const slotIndex = slot;
            slot += 1;
            meta.set([slotIndex, 0, 0, 0], slotIndex * 4);
            packVisibilitySlotRow(visibilitySlotRowFromInstance(source.data.subarray(rowOffset, rowOffset + INSTANCE_ROW_FLOATS)),
              table.subarray(slotIndex * VISIBILITY_SLOT_ROW_FLOATS, (slotIndex + 1) * VISIBILITY_SLOT_ROW_FLOATS));
            pass.setBindGroup(1, resources.metaGroup, [slotIndex * resources.alignment]);
            geometry.mesh.drawMeshletVisibility(pass, draw);
            drawCalls += 1;
          }
        }
      } finally { pass.end(); }
      // 软光栅后备（材质还原之前）：超误差 cluster 微三角经 kernel 写 visibility 三缓冲，
      // slot 接在硬件 slot 之后、材质表行同表追加；未就绪/入参 fail-closed 时零后备。
      let fallbackTriangles: number | undefined;
      const fallbackInput = request.softRaster;
      if (fallbackInput !== undefined && this.softRasterize !== undefined
        && slot + fallbackInput.triangleCount <= MAX_VISIBILITY_SLOTS) {
        fallbackTriangles = this.softRasterize.encodeRaster(encoder, fallbackInput, slot, request.width, request.height);
        if (fallbackTriangles !== undefined) {
          // 合并到本帧唯一一次材质表上传。若先单独写后备行，再上传扩展后的 table，
          // table 的零初始化尾部会覆盖后备材质，造成微三角可见但颜色/参数归零。
          table.set(fallbackInput.slotRows.subarray(0, fallbackTriangles * VISIBILITY_SLOT_ROW_FLOATS),
            slot * VISIBILITY_SLOT_ROW_FLOATS);
          slot += fallbackTriangles;
        }
      }
      if (!slot) return { slotCount: 0, drawCalls: 0, skippedDraws };
      device.queue.writeBuffer(resources.metaUniform, 0, meta, 0, slot * 4);
      device.queue.writeBuffer(resources.materialTable, 0, table, 0, slot * VISIBILITY_SLOT_ROW_FLOATS);
      const uniforms = new Float32Array(RESOLVE_UNIFORM_FLOATS);
      uniforms.set(invertMat4(frameData.subarray(0, 16)), 0);
      uniforms.set([frameData[64]!, frameData[65]!, frameData[66]!, frameData[67]!], 16);
      uniforms.set([frameData[76]!, frameData[77]!, frameData[78]!, frameData[79]!], 20);
      uniforms.set([frameData[84]!, frameData[85]!, frameData[86]!, frameData[87]!], 24);
      uniforms.set([request.width, request.height, 1 / request.width, 1 / request.height], 28);
      device.queue.writeBuffer(resources.resolveUniform, 0, uniforms);
      const composite = this.transient.acquire({ resourceId: "visibility-composite", format: "rgba16float",
        width: request.width, height: request.height, sampleCount: 1,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      try {
        // 后备编码成功 → resolve 走后备变体（三缓冲命中像素优先）；否则主变体原样。
        const fallbackActive = fallbackTriangles !== undefined && this.softRasterize?.resolvePipeline !== undefined;
        const resolvePipeline = fallbackActive ? this.softRasterize!.resolvePipeline! : this.resolvePipeline!;
        const resolve = encoder.beginRenderPass({ label: "Deep visibility resolve", colorAttachments: [{
          view: composite.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
        resolve.setPipeline(resolvePipeline);
        resolve.setBindGroup(0, resources.resolveGroup);
        resolve.setBindGroup(1, device.createBindGroup({ layout: resolvePipeline.getBindGroupLayout(1), entries: [
          { binding: 0, resource: visibility.view }, { binding: 1, resource: request.depthView },
          { binding: 2, resource: request.hdrView },
          ...(fallbackActive ? this.softRasterize!.resolveEntries() : [])] }));
        resolve.setBindGroup(2, resources.tableGroup);
        resolve.draw(3);
        resolve.end();
        const blit = encoder.beginRenderPass({ label: "Deep visibility blit", colorAttachments: [{
          view: request.hdrView, loadOp: "load", storeOp: "store" }] });
        blit.setPipeline(this.blitPipeline);
        blit.setBindGroup(0, device.createBindGroup({ layout: this.blitPipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: composite.view }] }));
        blit.draw(3);
        blit.end();
      } finally { this.transient.release(composite); }
      return fallbackTriangles === undefined ? { slotCount: slot, drawCalls, skippedDraws }
        : { slotCount: slot, drawCalls, skippedDraws, fallbackTriangles };
    } finally { this.transient.release(visibility); }
  }

  dispose(): void {
    this.rasterPipelines.clear(); this.resolvePipeline = undefined; this.blitPipeline = undefined;
    this.softRasterize?.dispose();
    const resources = this.resources; this.resources = undefined;
    if (resources) {
      runResourceCleanup("Visibility buffer disposal failed.", [
        () => this.session.release(resources.metaUniform), () => this.session.release(resources.materialTable),
        () => this.session.release(resources.resolveUniform)]);
    }
  }
}
