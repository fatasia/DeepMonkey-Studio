/// <reference types="@webgpu/types" />
/**
 * B2 MegaLights M2 生产帧控制器(features.megaLights 的渲染器侧供给)。
 *
 * == 合同 ==
 * - 路径决策单源复用 megaLights.resolveDirectLightingPath(决策纯函数/上下文合同在
 *   megaLightsFrameDecision.ts,帧早段 depth 消费判定与这里共用同一函数):≤64
 *   本地点/聚光且未强制 → 返回 dispatched=false(既有簇光快路径零 dispatch、零
 *   字节变化);超预算或 options.forceMegaLights → 表面重建 compute + RIS 两趟 +
 *   加性合成挂主 encoder。
 * - fail-closed:本地+面积灯合计超 MAX_MEGA_LIGHTS(65535)拒绝(与 packMegaLights
 *   内部门双闸);决策路径要求 IES 表而生产通路未供给时拒绝(静默恒 1 因子 =
 *   静默错光,不收);directClear 直出快路径由调用方裁决(合成语义依赖 HDR 链)。
 * - 表面供给:自持重建核(megaLightsFrameWgsl.MEGA_LIGHTS_REBUILD_WGSL)从主帧
 *   1x depth 重建视空间表面直写 MegaLightsRuntime 的 surfaces buffer(prepare 的
 *   CPU 端 surfaces 恒传同一共享全零数组 → runtime 首帧后跳过 CPU 上传,GPU 重建
 *   每帧覆写,零 CPU 带宽)。法线为 depth 差分、材质为中性起步档(degraded,
 *   如实登记;GBuffer 消费属 pbrShader 域后续切片)。
 * - 合成:全屏三角形加性混合(loadOp load)叠进 HDR 附件,fragment 读 runtime
 *   颜色 storage —— alpha 恒加 0,附件 alpha 通道逐位不变。帧序在 depth resolve
 *   之后、粒子/后处理之前(后处理统一消费合成后的 HDR)。
 * - 开关语义:features.megaLights=false → 控制器不存在(PbrRenderer 构造器零
 *   改动,帧编排内懒构造),帧逐位一致;构造后翻 false → 调用方停发 encodeFrame
 *   (资源保留,复用零成本)。
 * - 领地纪律:只 import webgpu/rtShadowFrame 的 invertColumnMajor4x4(只复用不
 *   修改,该文件已在 pbrRendererFrames 已提交钩子中成为主干依赖);不触碰
 *   postprocess/、pbrShader、pipelines、pbrPipelineSet 与渲染器互斥域。
 */
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { invertColumnMajor4x4 } from "../webgpu/rtShadowFrame.js";
import { failWithResourceCleanup } from "../webgpu/resourceCleanup.js";
import { MAX_MEGA_LIGHTS, megaLightsFromClustered, packMegaLights,
  resolveDirectLightingPath, type DirectLightingPathDecision } from "./megaLights.js";
import { MEGA_LIGHTS_SURFACES_STRIDE_VEC4 } from "./megaLightsAbi.js";
import type { MegaLightsFrameEncodeContext, MegaLightsFrameControllerOptions,
  MegaLightsFrameMetrics, MegaLightsFrameResult } from "./megaLightsFrameDecision.js";
import { multiplyColumnMajor4x4 } from "./megaLightsFrameDecision.js";
import type { MegaLightsPrepareInput } from "./megaLightsRuntime.js";
import { MegaLightsRuntime } from "./megaLightsRuntime.js";
import { MEGA_LIGHTS_COMPOSITE_PARAMS_BYTES, MEGA_LIGHTS_COMPOSITE_WGSL,
  MEGA_LIGHTS_REBUILD_PARAMS_BYTES, MEGA_LIGHTS_REBUILD_WGSL } from "./megaLightsFrameWgsl.js";

export type { MegaLightsFrameControllerOptions, MegaLightsFrameEncodeContext,
  MegaLightsFrameMetrics, MegaLightsFrameResult } from "./megaLightsFrameDecision.js";
export { megaLightsFramePlanned, multiplyColumnMajor4x4 } from "./megaLightsFrameDecision.js";

/** depth 视图缓存(纹理身份 → 2d 全 mip 单层视图;同纹理逐帧复用)。 */
const depthViewCache = new WeakMap<GPUTexture, GPUTextureView>();

function depthViewFor(texture: GPUTexture): GPUTextureView {
  let view = depthViewCache.get(texture);
  if (!view) depthViewCache.set(texture, view = texture.createView({ dimension: "2d", mipLevelCount: 1, arrayLayerCount: 1 }));
  return view;
}

/** 控制器自持小资源(uniform×2 + 两个 bind group;按 (depth 纹理, surfaces, color) 身份缓存)。 */
interface MegaLightsFrameAllocation {
  readonly rebuildParams: GPUBuffer;
  readonly rebuildBindGroup: GPUBindGroup;
  readonly compositeParams: GPUBuffer;
  readonly compositeBindGroup: GPUBindGroup;
  readonly rebuildTargetBuffer: GPUBuffer;
  readonly compositeColorBuffer: GPUBuffer;
  readonly depthTexture: GPUTexture;
}

/**
 * MegaLights 生产帧控制器:路径决策 + 表面重建 + RIS 两趟(复用 M1 单源核)+
 * 加性合成,四段挂同一 encoder。资源 rollback-safe(照 clusterCompute/M1 纪律)。
 */
export class MegaLightsFrameController {
  private readonly runtime: MegaLightsRuntime;
  private readonly rebuildModule: GPUShaderModule;
  private readonly compositeModule: GPUShaderModule;
  private readonly rebuildPipeline: GPUComputePipeline;
  private readonly rebuildLayout: GPUBindGroupLayout;
  private readonly compositePipeline: GPURenderPipeline;
  private readonly compositeLayout: GPUBindGroupLayout;
  private readonly forced: boolean;
  private readonly spatialReuse: boolean;
  /** prepare 侧共享全零表面(引用不变 → runtime 首帧后跳过 CPU 上传;GPU 重建覆写)。 */
  private zeroSurfaces: Float32Array | undefined;
  private allocation: MegaLightsFrameAllocation | undefined;
  private dispatchedFrames = 0;
  private lastLightCount = 0;
  private lastReason: DirectLightingPathDecision["reason"] = "within-cluster-budget";
  private lastDispatchGroupsX = 0;
  private lastDispatchGroupsY = 0;
  private disposed = false;

  constructor(private readonly session: Pick<DeviceSession, "device" | "state" | "own" | "release">,
    options: MegaLightsFrameControllerOptions = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("MegaLights frame controller options must be an object.");
    }
    this.forced = options.forceMegaLights === true;
    this.spatialReuse = options.spatialReuse !== false;
    this.runtime = new MegaLightsRuntime(session);
    const device = session.device;
    this.rebuildModule = device.createShaderModule({ label: "Deep MegaLights surface rebuild",
      code: MEGA_LIGHTS_REBUILD_WGSL });
    this.compositeModule = device.createShaderModule({ label: "Deep MegaLights composite",
      code: MEGA_LIGHTS_COMPOSITE_WGSL });
    this.rebuildLayout = device.createBindGroupLayout({ label: "Deep MegaLights surface rebuild layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ] });
    this.rebuildPipeline = device.createComputePipeline({ label: "Deep MegaLights surface rebuild",
      layout: device.createPipelineLayout({ label: "Deep MegaLights surface rebuild pipeline layout",
        bindGroupLayouts: [this.rebuildLayout] }),
      compute: { module: this.rebuildModule, entryPoint: "deepMegaRebuildSurfacesFrame" } });
    this.compositeLayout = device.createBindGroupLayout({ label: "Deep MegaLights composite layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ] });
    // 加性混合 one+one:RGB 叠加直接光,alpha 恒加 0(附件 alpha 逐位不变);
    // 附件格式 rgba16float = PBR_HDR_FORMAT。
    this.compositePipeline = device.createRenderPipeline({ label: "Deep MegaLights composite",
      layout: device.createPipelineLayout({ label: "Deep MegaLights composite pipeline layout",
        bindGroupLayouts: [this.compositeLayout] }),
      vertex: { module: this.compositeModule, entryPoint: "deepMegaCompositeVertex" },
      fragment: { module: this.compositeModule, entryPoint: "deepMegaCompositeFragment",
        targets: [{ format: "rgba16float", blend: { color: { srcFactor: "one", dstFactor: "one", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } } }] },
      primitive: { topology: "triangle-list" } });
  }

  get metrics(): MegaLightsFrameMetrics {
    return { dispatchedFrames: this.dispatchedFrames, lastLightCount: this.lastLightCount,
      lastReason: this.lastReason, lastDispatchGroupsX: this.lastDispatchGroupsX,
      lastDispatchGroupsY: this.lastDispatchGroupsY };
  }

  /** RIS compute 运行时(真机探针/诊断复用;生产帧请走 encodeFrame)。 */
  get risRuntime(): MegaLightsRuntime {
    return this.runtime;
  }

  /**
   * 编码一帧:路径决策 →(RIS 路径时)表面重建 compute + RIS 两趟 + 加性合成。
   * 簇光预算内路径**不产生任何 GPU 命令**,仅刷新决策遥测。
   */
  encodeFrame(context: MegaLightsFrameEncodeContext): MegaLightsFrameResult {
    this.assertReady();
    const { width, height, lights } = context;
    const points = lights.points?.length ?? 0;
    const spots = lights.spots?.length ?? 0;
    const areaCount = lights.areas?.length ?? 0;
    const decision = resolveDirectLightingPath({ points, spots, areas: areaCount, forceMegaLights: this.forced });
    this.lastReason = decision.reason;
    this.lastLightCount = decision.localLightCount;
    if (decision.path === "cluster-forward-plus") {
      return { dispatched: false, reason: decision.reason, localLightCount: decision.localLightCount,
        areaCount };
    }
    // fail-closed 双闸之一:决策路径要求池容量(超 65535 拒;packMegaLights 内部
    // 同门兜底,这里先行给出带路径语义的错误信息)。
    if (decision.localLightCount + areaCount > MAX_MEGA_LIGHTS) {
      throw new Error(`MegaLights frame requires ${decision.localLightCount + areaCount} lights, `
        + `exceeding the ${MAX_MEGA_LIGHTS} mega pool capacity.`);
    }
    const packed = packMegaLights(megaLightsFromClustered(lights));
    // 生产通路不供给 IES 展开表(runtime 缺省最小 -1 行,因子恒 1):带 iesSpotIndex
    // 的灯会引用不存在的行 = 越界读,fail-closed 拒绝而非静默错光(断点如实登记,
    // 预算内场景走簇光路径不受影响)。
    if (packed.iesReferenceCount > 0) {
      throw new Error("MegaLights frame encountered lights referencing IES rows; the production "
        + "path does not supply the IES table yet (cluster-budget path keeps them shaded).");
    }
    const groupsX = Math.ceil(width / 8);
    const groupsY = Math.ceil(height / 8);
    const prepareInput: MegaLightsPrepareInput = { width, height, lights: packed,
      surfaces: this.sharedZeroSurfaces(width, height),
      spatialEnabled: this.spatialReuse, temporalEnabled: true };
    this.runtime.prepare(prepareInput);
    this.encodeDispatches(context, packed.count, groupsX, groupsY);
    this.dispatchedFrames += 1;
    this.lastDispatchGroupsX = groupsX;
    this.lastDispatchGroupsY = groupsY;
    return { dispatched: true, reason: decision.reason, localLightCount: decision.localLightCount,
      areaCount };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.allocation) this.releaseAllocation(this.allocation);
    this.allocation = undefined;
    this.runtime.dispose();
  }

  private encodeDispatches(context: MegaLightsFrameEncodeContext, lightCount: number,
    groupsX: number, groupsY: number): void {
    const { encoder, width, height, depthTexture } = context;
    const device = this.session.device;
    const allocation = this.ensureAllocation(width, height, depthTexture);
    // 段一:表面重建(读 depth、写 runtime surfaces buffer;零 CPU 上传带宽)。
    device.queue.writeBuffer(allocation.rebuildParams, 0, this.packRebuildParams(context).buffer as ArrayBuffer);
    const rebuildPass = encoder.beginComputePass({ label: "Deep MegaLights surface rebuild" });
    rebuildPass.setPipeline(this.rebuildPipeline);
    rebuildPass.setBindGroup(0, allocation.rebuildBindGroup);
    rebuildPass.dispatchWorkgroups(groupsX, groupsY);
    rebuildPass.end();
    // 段二/三:RIS 两趟(读重建表面;M1 单源核;pass 边界内存序规范强保证)。
    this.runtime.encode(encoder, { width, height, lightCount });
    // 段四:加性合成(render pass,one+one 混合;loadOp load 保留既有 HDR 内容,
    // alpha 加 0;附件视图由调用方供给——主帧 1x HDR)。
    device.queue.writeBuffer(allocation.compositeParams, 0, this.packCompositeParams(width, height).buffer as ArrayBuffer);
    const compositePass = encoder.beginRenderPass({ label: "Deep MegaLights composite",
      colorAttachments: [{ view: context.colorView, loadOp: "load", storeOp: "store" }] });
    compositePass.setPipeline(this.compositePipeline);
    compositePass.setBindGroup(0, allocation.compositeBindGroup);
    compositePass.draw(3);
    compositePass.end();
  }

  private packRebuildParams(context: MegaLightsFrameEncodeContext): Float32Array<ArrayBuffer> {
    // worldToView × inv(depthViewProjection):clip → world → view 一步组合矩阵。
    const inverse = invertColumnMajor4x4(context.depthViewProjection);
    const combined = multiplyColumnMajor4x4(context.worldToView, inverse);
    const words = new Float32Array(MEGA_LIGHTS_REBUILD_PARAMS_BYTES / 4);
    words.set(combined, 0);
    new Uint32Array(words.buffer).set([context.width, context.height], 16);
    return words;
  }

  private packCompositeParams(width: number, height: number): Float32Array<ArrayBuffer> {
    const words = new Float32Array(MEGA_LIGHTS_COMPOSITE_PARAMS_BYTES / 4);
    new Uint32Array(words.buffer).set([width, height], 0);
    return words;
  }

  private sharedZeroSurfaces(width: number, height: number): Float32Array {
    const length = width * height * MEGA_LIGHTS_SURFACES_STRIDE_VEC4 * 4;
    if (this.zeroSurfaces?.length !== length) this.zeroSurfaces = new Float32Array(length);
    return this.zeroSurfaces;
  }

  /** bind group 按 (depth 纹理, surfaces buffer, color buffer) 身份缓存;任一更换即重建。 */
  private ensureAllocation(width: number, height: number,
    depthTexture: GPUTexture): MegaLightsFrameAllocation {
    const surfacesBuffer = this.runtime.surfacesBuffer;
    const colorBuffer = this.runtime.colorBuffer;
    const current = this.allocation;
    if (current && current.rebuildTargetBuffer === surfacesBuffer
      && current.compositeColorBuffer === colorBuffer && current.depthTexture === depthTexture) {
      return current;
    }
    if (current) this.releaseAllocation(current);
    const device = this.session.device;
    const owned: GPUBuffer[] = [];
    const allocateUniform = (size: number, label: string): GPUBuffer => {
      const buffer = this.session.own(device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM
        | GPUBufferUsage.COPY_DST, label }));
      owned.push(buffer);
      return buffer;
    };
    try {
      const rebuildParams = allocateUniform(MEGA_LIGHTS_REBUILD_PARAMS_BYTES, "Deep MegaLights rebuild params");
      const compositeParams = allocateUniform(MEGA_LIGHTS_COMPOSITE_PARAMS_BYTES, "Deep MegaLights composite params");
      const rebuildBindGroup = device.createBindGroup({ label: "Deep MegaLights surface rebuild bindings",
        layout: this.rebuildLayout, entries: [
          { binding: 0, resource: { buffer: rebuildParams } },
          { binding: 1, resource: depthViewFor(depthTexture) },
          { binding: 2, resource: { buffer: surfacesBuffer } },
        ] });
      const compositeBindGroup = device.createBindGroup({ label: "Deep MegaLights composite bindings",
        layout: this.compositeLayout, entries: [
          { binding: 0, resource: { buffer: compositeParams } },
          { binding: 1, resource: { buffer: colorBuffer } },
        ] });
      const next: MegaLightsFrameAllocation = { rebuildParams, rebuildBindGroup, compositeParams,
        compositeBindGroup, rebuildTargetBuffer: surfacesBuffer, compositeColorBuffer: colorBuffer,
        depthTexture };
      this.allocation = next;
      return next;
    } catch (error) {
      failWithResourceCleanup(error, "MegaLights frame allocation rollback failed.",
        owned.map(buffer => () => this.session.release(buffer)));
      throw error;
    }
  }

  private releaseAllocation(allocation: MegaLightsFrameAllocation): void {
    this.session.release(allocation.rebuildParams);
    this.session.release(allocation.compositeParams);
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("MegaLights frame controller is disposed.");
    if (this.session.state !== "ready") {
      throw new Error(`MegaLights frame controller cannot use a ${this.session.state} GPU session.`);
    }
  }
}
