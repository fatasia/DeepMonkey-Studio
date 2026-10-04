/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { createSdfSceneBakeCache, type SdfSceneBakeInstance, type SdfSceneBakeReport } from "./sdfSceneBake.js";
import { resolveSdfSkyVisibilityTraceConfig, SDF_SKY_VISIBILITY_ENTRY,
  SDF_SKY_VISIBILITY_PARAMS_BYTES, SDF_SKY_VISIBILITY_WORKGROUP_SIZE,
  DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL } from "./sdfSkyVisibility.js";
import { resolveDeepGiTemporalAlpha } from "./probeShUpdate.js";
import { DEEP_SDF_GI_PROBE_UPDATE_WGSL, SDF_GI_PROBE_UPDATE_ENTRY,
  SDF_GI_PROBE_UPDATE_PARAMS_BYTES, SDF_GI_PROBE_UPDATE_WORKGROUP_SIZE } from "./sdfGiProbeUpdateWgsl.js";
import { deriveSdfGiProbeLattice, sdfGiBakeInstancesFromPackets,
  type SdfGiPacketSnapshot } from "./sdfGiSceneAdapter.js";
import { bakeSdfSceneWithRetries, probeLatticeBounds, resolveSdfGiBakeCellSize } from "./sdfGiBakePlan.js";
import { encodeSdfSceneBakeGpu, type SdfGiBakedGrid } from "./sdfSceneBakeGpu.js";
import { SdfGiPublishRuntime, sdfGiPublishLevel } from "./sdfGiPublish.js";
import { buildSdfGiSlots, sdfGiSlotBuffers } from "./sdfGiBakeSlots.js";
import { packSdfGiProbeUpdateParams, packSdfGiSkyRadianceTable,
  planSdfGiProbeWindow, sdfGiTimedPassRegistration } from "./sdfGiPacking.js";
import { readbackStorageBuffer } from "./sdfGiReadback.js";
import type { SdfGiFrameInput, SdfGiFramePlan, SdfGiGpuSlots, SdfGiMetrics, SdfGiPassTiming,
  SdfGiRuntimeOptions } from "./sdfGiRuntimeTypes.js";
import type { ProbeClipmapLevel } from "../lighting/probeClipmapPlan.js";
import type { ProbeClipmapLightingBinding } from "../lighting/pbrLightingBindings.js";

/**
 * Brief-GI M2/M3 生产 dispatch 运行时:把引擎侧通路(场景 SDF 烘焙 → 天光圆锥
 * 追踪 → 探针 SH 更新 → 探针场物化)接进 pbrRendererFrames 帧循环。帧合同类型见
 * sdfGiRuntimeTypes.ts,纯函数/预算窗口/计时登记暂存见 sdfGiPacking.ts 文件头。
 *
 * - 烘焙(静态层,场景 dirty 一次):GPU compute 距离场优先(sdfSceneBakeGpu,同
 *   encoder 写后读零拷贝;失败/超预算回退 CPU 增量烘焙,墙钟如实报告)→ 天光追踪;
 * - SH 更新(动态层,每帧):ddgiUpdateBudget 同族滑动窗口分摊,天空辐射表逐帧刷新;
 * - 探针消费(M3):每帧 update 窗口后物化探针场为 clipmap 采样纹理(sdfGiPublish),
 *   宿主经 setProbeClipmap 发布 —— 主 pass ambient 项真实消费探针记录;
 * - 开关:features.sdfGi(默认关 = 不构建,既有帧逐位零变化)。SSGDI 动态直接层
 *   的 GPU 核消费属后续切片(如实声明,当前不接入)。
 */

// WebGPU usage 数值常量(rayTracing/shadowRayPass.ts 同款先例):node/vitest stub
// 环境无 GPUBufferUsage 全局,模块顶层禁止求值 GPU 全局(否则 host.test 等
// pbrRenderer→host 单链 suite 级炸)。
const STORAGE_RW = 0x80 | 0x8 | 0x4; // STORAGE | COPY_DST | COPY_SRC(可见度/记录读写)

/** Brief-GI M2/M3 生产 dispatch 运行时(帧循环 host 持有;features.sdfGi 开启才构造)。 */
export class SdfGiProductionRuntime {
  private readonly tracePipeline: GPUComputePipeline;
  private readonly updatePipeline: GPUComputePipeline;
  private readonly traceLayout: GPUBindGroupLayout;
  private readonly updateLayout: GPUBindGroupLayout;
  private readonly publish: SdfGiPublishRuntime;
  private slots: SdfGiGpuSlots | undefined;
  private readonly bakeCache = createSdfSceneBakeCache();
  private lastBakedRevision = Number.NaN;
  private dispatchedWindows = 0;
  private metricsSnapshot: SdfGiMetrics = { sdfGiBakes: 0, sdfGiBakesGpu: 0, sdfGiBakeCells: 0,
    sdfGiProbeCount: 0, sdfGiProbesUpdated: 0, sdfGiProbeWindowOffset: 0,
    sdfGiSkyTraceDispatches: 0, sdfGiPublishDispatches: 0 };
  private pendingSnapshot: SdfGiPacketSnapshot | undefined;
  private lastLattice: readonly (readonly number[])[] | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession,
    private readonly options: SdfGiRuntimeOptions = {}) {
    if (options && typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("SDF GI runtime options must be an object.");
    }
    const device = session.device;
    this.traceLayout = device.createBindGroupLayout({ label: "Deep SDF GI sky trace layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform",
          minBindingSize: SDF_SKY_VISIBILITY_PARAMS_BYTES } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ] });
    this.updateLayout = device.createBindGroupLayout({ label: "Deep SDF GI probe update layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform",
          minBindingSize: SDF_GI_PROBE_UPDATE_PARAMS_BYTES } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ] });
    const traceModule = device.createShaderModule({ label: "Deep SDF GI sky trace WGSL",
      code: DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL });
    const updateModule = device.createShaderModule({ label: "Deep SDF GI probe update WGSL",
      code: DEEP_SDF_GI_PROBE_UPDATE_WGSL });
    this.tracePipeline = device.createComputePipeline({ label: "Deep SDF GI sky trace pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.traceLayout] }),
      compute: { module: traceModule, entryPoint: SDF_SKY_VISIBILITY_ENTRY } });
    this.updatePipeline = device.createComputePipeline({ label: "Deep SDF GI probe update pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.updateLayout] }),
      compute: { module: updateModule, entryPoint: SDF_GI_PROBE_UPDATE_ENTRY } });
    this.publish = new SdfGiPublishRuntime(session);
  }

  get metrics(): Readonly<SdfGiMetrics> { return this.metricsSnapshot; }

  /** 当前烘焙的探针格(真机探针/奇偶性对拍与 GPU 同源;未烘焙 = undefined)。 */
  get probePositions(): readonly (readonly number[])[] | undefined { return this.lastLattice; }

  /** 帧循环注入当前包快照(只存引用;烘焙在 encodeFrame 的 revision 变化帧发生)。 */
  syncScene(snapshot: SdfGiPacketSnapshot | undefined): void {
    if (this.disposed) throw new Error("SDF GI runtime is disposed.");
    this.pendingSnapshot = snapshot;
  }

  /**
   * 帧步进:场景 dirty 时烘焙(GPU 距离场优先)+ 追踪派发;随后按预算派发探针 SH
   * 更新窗口;最后物化探针场为 clipmap 采样纹理(消费接线,同 encoder 写后读)。
   * 全部挂调用方 encoder;无静态场景(空包/全透明/全动态)时跳过(fail-visible 不产 NaN)。
   */
  encodeFrame(encoder: GPUCommandEncoder, input: SdfGiFrameInput,
    passTiming?: SdfGiPassTiming): SdfGiFramePlan {
    if (this.disposed) throw new Error("SDF GI runtime is disposed.");
    const timing = sdfGiTimedPassRegistration().registered ? passTiming : undefined;
    let baked = false;
    let bakeReport: SdfSceneBakeReport | undefined;
    let gpuBaked = false;
    if (input.sceneRevision !== this.lastBakedRevision) {
      this.lastBakedRevision = input.sceneRevision;
      const result = this.encodeBake(encoder, timing);
      baked = result.baked;
      bakeReport = result.report;
      gpuBaked = result.gpuBaked;
    }
    const slots = this.slots;
    const window = planSdfGiProbeWindow(slots?.probeCount ?? 0, input.budgetProbes,
      this.dispatchedWindows);
    if (slots && window.count > 0) {
      // 逐帧刷新天空辐射表(动态层输入;生产 = 环境均值 × 强度,方向表 ABI 留逐向余量)。
      this.session.device.queue.writeBuffer(slots.skyRadiance, 0,
        packSdfGiSkyRadianceTable(this.directionCount, input.skyRadianceRgb));
      this.session.device.queue.writeBuffer(slots.updateParams, 0, packSdfGiProbeUpdateParams({
        probeCount: slots.probeCount, directionCount: this.directionCount,
        windowOffset: window.offset, windowCount: window.count,
        alpha: resolveDeepGiTemporalAlpha(this.options.alpha),
        ...(this.options.bounceAlbedo ? { bounceAlbedo: this.options.bounceAlbedo } : {}) }));
      timing?.beginMarker(encoder, "sdf-gi-probe-update");
      const pass = encoder.beginComputePass({ label: "Deep SDF GI probe update" });
      pass.setPipeline(this.updatePipeline);
      pass.setBindGroup(0, slots.updateBindGroup);
      pass.dispatchWorkgroups(Math.ceil(window.count / SDF_GI_PROBE_UPDATE_WORKGROUP_SIZE));
      pass.end();
      timing?.endMarker(encoder, "sdf-gi-probe-update");
      this.dispatchedWindows += 1;
    }
    // 探针消费物化(每帧;update 窗口之后的写后读,≤4096 texel 一次 dispatch)。
    let published = false;
    if (slots && this.publish.published) {
      this.publish.encode(encoder);
      published = true;
      this.metricsSnapshot = { ...this.metricsSnapshot,
        sdfGiPublishDispatches: this.metricsSnapshot.sdfGiPublishDispatches + 1 };
    }
    this.metricsSnapshot = { ...this.metricsSnapshot,
      sdfGiProbesUpdated: window.count, sdfGiProbeWindowOffset: window.offset };
    return { baked, ...(bakeReport ? { bakeReport } : {}),
      probeWindow: Object.freeze({ ...window }), probeCount: slots?.probeCount ?? 0,
      published, gpuBaked };
  }

  /** 主 pass 发布面(setProbeClipmap 参数;场景未烘焙 = undefined 回 F1 fallback)。 */
  get publishBinding(): ProbeClipmapLightingBinding | undefined {
    return this.publish.published;
  }

  /** 真机探针/验收读回:物化纹理与格几何(消费接线对拍面;未就绪 = undefined)。 */
  get publishedTextures(): { readonly volume: GPUTexture; readonly moments: GPUTexture;
    readonly level: ProbeClipmapLevel } | undefined {
    return this.publish.publishedTextures;
  }

  private get directionCount(): number {
    return this.options.directionCount === 32 ? 32 : 16;
  }

  /** 场景 dirty 烘焙:适配包 → GPU compute 距离场(失败/超预算回退 CPU 增量烘焙,
   * 墙钟口径如实报告)→ 天光追踪 dispatch → 物化资源就绪。 */
  private encodeBake(encoder: GPUCommandEncoder, timing?: SdfGiPassTiming):
    { baked: boolean; report?: SdfSceneBakeReport; gpuBaked: boolean } {
    const snapshot = this.pendingSnapshot;
    if (!snapshot) return { baked: false, gpuBaked: false };
    const instances: readonly SdfSceneBakeInstance[] = sdfGiBakeInstancesFromPackets(snapshot);
    if (!instances.length) return { baked: false, gpuBaked: false };
    const domain = this.options.instanceDomain ?? "aabb";
    const cellSize = resolveSdfGiBakeCellSize(instances, this.options.cellSize);
    // GPU compute 距离场(同 encoder 写后读;三角形超预算/不支持返回 undefined)。
    let gpu: ReturnType<typeof encodeSdfSceneBakeGpu>;
    try {
      gpu = encodeSdfSceneBakeGpu(this.session, encoder,
        { instances, cellSize, instanceDomain: domain });
    } catch {
      gpu = undefined;
    }
    if (gpu) {
      this.afterBake(encoder, gpu.grid, gpu.field, timing);
      this.metricsSnapshot = { ...this.metricsSnapshot,
        sdfGiBakesGpu: this.metricsSnapshot.sdfGiBakesGpu + 1 };
      return { baked: true, report: gpu.report, gpuBaked: true };
    }
    const plan = bakeSdfSceneWithRetries(instances, { cellSize, instanceDomain: domain });
    this.afterBake(encoder, plan.bake.grid, undefined, timing);
    return { baked: true, report: plan.bake.report, gpuBaked: false };
  }

  /** 烘焙公共尾:探针格 → GPU 槽位(上传或零拷贝)→ 天光追踪 → 物化资源就绪。 */
  private afterBake(encoder: GPUCommandEncoder,
    rawGrid: SdfGiBakedGrid | import("./sdfSceneBake.js").SdfSceneBakeResult["grid"],
    gpuField: GPUBuffer | undefined, timing?: SdfGiPassTiming): void {
    const grid: SdfGiBakedGrid = { ...rawGrid,
      cells: "cells" in rawGrid ? rawGrid.cells : rawGrid.distances.length };
    const config = resolveSdfSkyVisibilityTraceConfig(grid,
      this.options.traceSteps === undefined ? {} : { steps: this.options.traceSteps });
    // 探针 lattice:内缩半格起采样,避免探针贴面(贴面探针 SDF=0 → 全向假遮蔽)。
    const bounds = probeLatticeBounds(grid);
    const lattice = deriveSdfGiProbeLattice(bounds,
      this.options.probeSpacing ?? Math.max(grid.cellSize * 4, 0.25), this.options.maxProbes ?? 4096);
    // GPU 槽位装配(上传或零拷贝直用;失败回滚自持,旧槽位保留语义与 M2 一致)。
    const candidate = gpuField
      ? buildSdfGiSlots({ session: this.session, grid, positions: lattice.positions,
        config, gpuField, traceLayout: this.traceLayout, updateLayout: this.updateLayout,
        directionCount: this.directionCount })
      : buildSdfGiSlots({ session: this.session, grid, positions: lattice.positions,
        config, traceLayout: this.traceLayout, updateLayout: this.updateLayout,
        directionCount: this.directionCount });
    this.releaseSlots();
    this.slots = candidate;
    this.lastLattice = lattice.positions;
    const slots = this.slots!;
    timing?.beginMarker(encoder, "sdf-gi-sky-trace");
    const pass = encoder.beginComputePass({ label: "Deep SDF GI sky trace" });
    pass.setPipeline(this.tracePipeline);
    pass.setBindGroup(0, slots.traceBindGroup);
    pass.dispatchWorkgroups(Math.ceil((slots.probeCount * this.directionCount)
      / SDF_SKY_VISIBILITY_WORKGROUP_SIZE));
    pass.end();
    timing?.endMarker(encoder, "sdf-gi-sky-trace");
    this.dispatchedWindows = 0;
    // 消费物化资源就绪(格几何/记录 buffer 就位;内容每帧 encode 覆写)。
    this.publish.prepare(sdfGiPublishLevel(lattice.positions[0]!, lattice.spacing,
      lattice.dimensions), slots.records);
    this.metricsSnapshot = { ...this.metricsSnapshot,
      sdfGiBakes: this.metricsSnapshot.sdfGiBakes + 1, sdfGiBakeCells: slots.cells,
      sdfGiProbeCount: slots.probeCount,
      sdfGiSkyTraceDispatches: this.metricsSnapshot.sdfGiSkyTraceDispatches + 1 };
  }

  private releaseSlots(): void {
    const slots = this.slots;
    if (!slots) return;
    for (const buffer of sdfGiSlotBuffers(slots)) this.session.release(buffer);
    this.slots = undefined;
  }

  /** 真机探针/验收读回:探针记录快照(96B ABI × probeCount)。 */
  readRecords(): Promise<Float32Array<ArrayBuffer>> {
    if (!this.slots) throw new Error("SDF GI runtime has no baked scene.");
    return readbackStorageBuffer(this.session, this.slots.records);
  }

  /** 真机探针/验收读回:天光可见度快照(probeCount × directionCount)。 */
  readVisibilities(): Promise<Float32Array<ArrayBuffer>> {
    if (!this.slots) throw new Error("SDF GI runtime has no baked scene.");
    return readbackStorageBuffer(this.session, this.slots.visibilities);
  }

  /** 真机验收读回:探针场距离场快照(GPU 烘焙帧与 CPU 帧同口径,f32/cell)。 */
  readField(): Promise<Float32Array<ArrayBuffer>> {
    if (!this.slots) throw new Error("SDF GI runtime has no baked scene.");
    return readbackStorageBuffer(this.session, this.slots.field);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseSlots();
    this.publish.dispose();
  }
}
