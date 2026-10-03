import { createAdmittedBuffer } from "../webgpu/resourceAdmission.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { PbrTransientTextureHandle, PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";
import { INSTANCE_OUTLINE_WGSL } from "./instanceOutlineWgsl.js";
import { packInstanceOutlineParams, resolveInstanceOutlineOptions, type InstanceOutlineOptions } from "./instanceOutlineCpu.js";

export type { InstanceOutlineOptions } from "./instanceOutlineCpu.js";
export const INSTANCE_OUTLINE_MASK_FORMAT = "rg8unorm" as const;
export const INSTANCE_OUTLINE_EDGE_FORMAT = "rgba8unorm" as const;
export const INSTANCE_OUTLINE_COLOR_FORMAT = "rgba16float" as const;
/** 掩码光栅与阴影管线同一顶点布局(slot0 位置、slot1 实例行 + 材质 flags),可直接复用 packet draw 的非剔除分支。 */
const MASK_BUFFERS: GPUVertexBufferLayout[] = [
  { arrayStride: 40, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
  { arrayStride: 144, stepMode: "instance", attributes: [
    ...[0, 1, 2].map(index => ({ shaderLocation: index + 2, offset: index * 16, format: "float32x4" as const })),
    { shaderLocation: 9, offset: 112, format: "float32x4" }] },
];
const COLOR_WRITE_RED = 1, COLOR_WRITE_GREEN = 2;

export interface InstanceOutlineDrawStats {
  readonly drawCalls: number;
  /** 变形/网格簇批次暂不进入掩码光栅,如实上报而不是静默丢失。 */
  readonly skippedBatches: number;
}

export interface InstanceOutlineInput {
  /** 线性 HDR 输入(只读;可以是 TAA 历史纹理,绝不写回)。 */
  readonly color: GPUTexture;
  readonly depthView: GPUTextureView;
  /** 未抖动的视图投影(列主序 16 float);与主深度的亚像素差由 depthBias 吸收。 */
  readonly viewProjection: ArrayLike<number>;
  readonly options?: InstanceOutlineOptions;
  /** 编码实例绘制;本 pass 会以 silhouette、visible 两条管线各调用一次。 */
  readonly draw: (pass: GPURenderPassEncoder) => InstanceOutlineDrawStats;
}

export interface InstanceOutlineResult {
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;
  readonly passCount: number;
  readonly drawCalls: number;
  readonly skippedBatches: number;
}

interface OutlineGpu {
  readonly maskLayout: GPUBindGroupLayout;
  readonly edgeLayout: GPUBindGroupLayout;
  readonly composeLayout: GPUBindGroupLayout;
  readonly silhouette: GPURenderPipeline;
  readonly visible: GPURenderPipeline;
  readonly edge: GPUComputePipeline;
  readonly compose: GPUComputePipeline;
  readonly sampler: GPUSampler;
}

/** 管线描述与布局(不触发编译);同步构造与异步预热共用,保证两条路径逐字段一致。 */
function describeOutline(device: GPUDevice) {
  const module = device.createShaderModule({ label: "Deep instance outline", code: INSTANCE_OUTLINE_WGSL });
  const maskLayout = device.createBindGroupLayout({ label: "Deep instance outline mask",
    entries: [{ binding: 7, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: 64 } }] });
  const unfilterable = { sampleType: "unfilterable-float" as const };
  const edgeLayout = device.createBindGroupLayout({ label: "Deep instance outline edge", entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 48 } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: unfilterable },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: INSTANCE_OUTLINE_EDGE_FORMAT } },
  ] });
  const composeLayout = device.createBindGroupLayout({ label: "Deep instance outline compose", entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 48 } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: unfilterable },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: unfilterable },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: INSTANCE_OUTLINE_COLOR_FORMAT } },
  ] });
  const rasterLayout = device.createPipelineLayout({ bindGroupLayouts: [maskLayout] });
  const raster = (label: string, entryPoint: string, writeMask: number, depthCompare: GPUCompareFunction,
    bias: { depthBias?: number; depthBiasSlopeScale?: number }): GPURenderPipelineDescriptor => ({ label, layout: rasterLayout,
    vertex: { module, entryPoint: "maskVertex", buffers: MASK_BUFFERS },
    fragment: { module, entryPoint, targets: [{ format: INSTANCE_OUTLINE_MASK_FORMAT, writeMask }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare, ...bias } });
  const compute = (label: string, layout: GPUBindGroupLayout, entryPoint: string): GPUComputePipelineDescriptor => ({ label,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint } });
  return { maskLayout, edgeLayout, composeLayout,
    silhouette: raster("Deep instance outline silhouette", "silhouetteFragment", COLOR_WRITE_RED | COLOR_WRITE_GREEN, "always", {}),
    // 负偏置让同一表面在抖动/未抖动投影下的亚像素深度差仍判为可见(轮廓处掠射角斜率最大)。
    visible: raster("Deep instance outline visible", "visibleFragment", COLOR_WRITE_GREEN, "less-equal",
      { depthBias: -4, depthBiasSlopeScale: -2 }),
    edge: compute("Deep instance outline edge", edgeLayout, "edgeMain"),
    compose: compute("Deep instance outline compose", composeLayout, "composeMain"),
    sampler: device.createSampler({ label: "Deep instance outline edge sampler", magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }) };
}

/**
 * 对象级描边:掩码光栅(1 个 render pass,2 次实例绘制)→ 半分辨率边缘检测 → 全分辨率加法合成。
 * 无描边实例时本类不被创建,不编译 shader、不分配纹理/缓冲;`createAsync` 供后端就绪后空闲预热
 * (createRender/ComputePipelineAsync,不阻塞任何帧),首帧再遇到描边时直接复用已编译管线。
 */
export class InstanceOutlinePass {
  private readonly maskLayout: GPUBindGroupLayout;
  private readonly edgeLayout: GPUBindGroupLayout;
  private readonly composeLayout: GPUBindGroupLayout;
  private readonly silhouette: GPURenderPipeline;
  private readonly visible: GPURenderPipeline;
  private readonly edge: GPUComputePipeline;
  private readonly compose: GPUComputePipeline;
  private readonly sampler: GPUSampler;
  private readonly camera: GPUBuffer;
  private readonly params: GPUBuffer;
  private disposed = false;

  /** 异步预热:管线在驱动后台线程编译,返回时已就绪;调用方需自行丢弃已过期(被同步路径抢先)的结果。 */
  static async createAsync(session: DeviceSession, pool: PbrTransientTexturePool): Promise<InstanceOutlinePass> {
    const device = session.device, plan = describeOutline(device);
    const [silhouette, visible, edge, compose] = await Promise.all([
      device.createRenderPipelineAsync(plan.silhouette), device.createRenderPipelineAsync(plan.visible),
      device.createComputePipelineAsync(plan.edge), device.createComputePipelineAsync(plan.compose)]);
    return new InstanceOutlinePass(session, pool, { ...plan, silhouette, visible, edge, compose });
  }

  constructor(private readonly session: DeviceSession, private readonly pool: PbrTransientTexturePool, gpu?: OutlineGpu) {
    const device = session.device;
    const built = gpu ?? (() => {
      const plan = describeOutline(device);
      return { ...plan, silhouette: device.createRenderPipeline(plan.silhouette), visible: device.createRenderPipeline(plan.visible),
        edge: device.createComputePipeline(plan.edge), compose: device.createComputePipeline(plan.compose) };
    })();
    ({ maskLayout: this.maskLayout, edgeLayout: this.edgeLayout, composeLayout: this.composeLayout,
      silhouette: this.silhouette, visible: this.visible, edge: this.edge, compose: this.compose, sampler: this.sampler } = built);
    this.camera = createAdmittedBuffer(session, { label: "Deep instance outline camera", size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.params = createAdmittedBuffer(session, { label: "Deep instance outline parameters", size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  encode(encoder: GPUCommandEncoder, input: InstanceOutlineInput): InstanceOutlineResult {
    if (this.disposed) throw new Error("Instance outline is disposed.");
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for instance outline.");
    if (!this.pool.frameOpen) throw new Error("Instance outline transient textures require an open frame scope.");
    if (input.viewProjection.length !== 16) throw new RangeError("Instance outline requires a 4x4 view-projection.");
    const options = resolveInstanceOutlineOptions(input.options);
    const { width, height } = input.color;
    const halfWidth = Math.max(1, Math.ceil(width / 2)), halfHeight = Math.max(1, Math.ceil(height / 2));
    const handles: PbrTransientTextureHandle[] = [];
    const acquire = (resourceId: string, format: GPUTextureFormat, w: number, h: number, usage: number) => {
      const handle = this.pool.acquire({ resourceId, format, width: w, height: h, sampleCount: 1, usage });
      handles.push(handle); return handle;
    };
    try {
      const device = this.session.device;
      const mask = acquire("outline-mask", INSTANCE_OUTLINE_MASK_FORMAT, width, height,
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
      const edge = acquire("outline-edge", INSTANCE_OUTLINE_EDGE_FORMAT, halfWidth, halfHeight,
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
      const output = acquire("outline-hdr", INSTANCE_OUTLINE_COLOR_FORMAT, width, height,
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
      device.queue.writeBuffer(this.camera, 0, new Float32Array(Array.from(input.viewProjection)));
      device.queue.writeBuffer(this.params, 0, packInstanceOutlineParams(options));
      const maskView = mask.texture.createView(), edgeView = edge.texture.createView();
      const maskGroup = device.createBindGroup({ layout: this.maskLayout, entries: [{ binding: 7, resource: { buffer: this.camera } }] });
      const edgeGroup = device.createBindGroup({ layout: this.edgeLayout, entries: [
        { binding: 0, resource: { buffer: this.params } }, { binding: 1, resource: maskView },
        { binding: 5, resource: edgeView }] });
      const composeGroup = device.createBindGroup({ layout: this.composeLayout, entries: [
        { binding: 0, resource: { buffer: this.params } }, { binding: 1, resource: maskView },
        { binding: 2, resource: input.color.createView() }, { binding: 3, resource: edgeView },
        { binding: 4, resource: this.sampler }, { binding: 6, resource: output.texture.createView() }] });
      const raster = encoder.beginRenderPass({ label: "Deep instance outline mask",
        colorAttachments: [{ view: maskView, clearValue: [1, 1, 0, 0], loadOp: "clear", storeOp: "store" }],
        depthStencilAttachment: { view: input.depthView, depthReadOnly: true } });
      let stats: InstanceOutlineDrawStats;
      try {
        raster.setBindGroup(0, maskGroup);
        raster.setPipeline(this.silhouette); stats = input.draw(raster);
        raster.setPipeline(this.visible); input.draw(raster);
      } finally { raster.end(); }
      const dispatch = (label: string, pipeline: GPUComputePipeline, group: GPUBindGroup, w: number, h: number) => {
        const pass = encoder.beginComputePass({ label });
        try { pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8)); }
        finally { pass.end(); }
      };
      dispatch("Deep instance outline edge", this.edge, edgeGroup, halfWidth, halfHeight);
      dispatch("Deep instance outline compose", this.compose, composeGroup, width, height);
      return Object.freeze({ texture: output.texture, width, height, passCount: 3,
        drawCalls: stats.drawCalls * 2, skippedBatches: stats.skippedBatches });
    } finally { for (const handle of handles) this.pool.release(handle); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.release(this.camera); this.session.release(this.params);
  }
}
