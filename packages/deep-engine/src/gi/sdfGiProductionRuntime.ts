/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { createAdmittedBuffer } from "../webgpu/resourceAdmission.js";
import { uploadBuffer } from "../webgpu/meshBuffers.js";
import { bakeSdfSceneGrid, createSdfSceneBakeCache,
  type SdfSceneBakeInstance, type SdfSceneBakeReport } from "./sdfSceneBake.js";
import { resolveSdfSkyVisibilityTraceConfig, SDF_SKY_VISIBILITY_ENTRY,
  SDF_SKY_VISIBILITY_PARAMS_BYTES, SDF_SKY_VISIBILITY_WORKGROUP_SIZE,
  DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL } from "./sdfSkyVisibility.js";
import { resolveDeepGiTemporalAlpha } from "./probeShUpdate.js";
import { DEEP_SDF_GI_PROBE_UPDATE_WGSL, SDF_GI_PROBE_UPDATE_ENTRY,
  SDF_GI_PROBE_UPDATE_PARAMS_BYTES, SDF_GI_PROBE_UPDATE_WORKGROUP_SIZE,
  SDF_GI_PROBE_RECORD_VEC4_STRIDE } from "./sdfGiProbeUpdateWgsl.js";
import { deriveSdfGiProbeLattice, sdfGiBakeInstancesFromPackets,
  type SdfGiPacketSnapshot } from "./sdfGiSceneAdapter.js";
import { packInitialSdfGiRecords, packSdfGiDirectionTable, packSdfGiProbePositions,
  packSdfGiProbeUpdateParams, packSdfGiSkyRadianceTable, packSdfGiSkyTraceParams,
  planSdfGiProbeWindow, sdfGiTimedPassRegistration } from "./sdfGiPacking.js";
import { readbackStorageBuffer } from "./sdfGiReadback.js";
import { instanceMaxExtent } from "./sdfGiSceneAdapter.js";
import type { SdfGiFrameInput, SdfGiFramePlan, SdfGiGpuSlots, SdfGiMetrics, SdfGiPassTiming,
  SdfGiRuntimeOptions } from "./sdfGiRuntimeTypes.js";

/**
 * Brief-GI M2 生产 dispatch 运行时:把 M1 引擎侧通路(bakeSdfSceneGrid → 天光圆锥
 * 追踪 → 探针 SH 更新)接进 pbrRendererFrames 帧循环。帧合同类型见
 * sdfGiRuntimeTypes.ts,纯函数/预算窗口/计时登记暂存见 sdfGiPacking.ts 文件头。
 *
 * - 烘焙(静态层,场景 dirty 一次):CPU 增量烘焙 → 上传 → 天光追踪真 dispatch;
 * - SH 更新(动态层,每帧):ddgiUpdateBudget 同族滑动窗口分摊,天空辐射表逐帧刷新;
 * - 开关:features.sdfGi(默认关 = 不构建,既有帧逐位零变化)。SSGDI 动态直接层
 *   的 GPU 核消费属后续切片(如实声明,当前不接入)。
 */

// WebGPU usage 规范数值(rayTracing/shadowRayPass.ts 同款先例):node/vitest stub
// 环境无 GPUBufferUsage 全局,模块顶层禁止求值 GPU 全局(否则 host.test 等
// pbrRenderer→host 单链 suite 级炸)。
const USAGE_STORAGE = 0x80, USAGE_COPY_DST = 0x8, USAGE_COPY_SRC = 0x4, USAGE_UNIFORM = 0x40;
const USAGE_MAP_READ = 0x1;
const STORAGE_READ = USAGE_STORAGE | USAGE_COPY_DST;
const STORAGE_RW = USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC;

/** Brief-GI M2 生产 dispatch 运行时(帧循环 host 持有;features.sdfGi 开启才构造)。 */
export class SdfGiProductionRuntime {
  private readonly tracePipeline: GPUComputePipeline;
  private readonly updatePipeline: GPUComputePipeline;
  private readonly traceLayout: GPUBindGroupLayout;
  private readonly updateLayout: GPUBindGroupLayout;
  private slots: SdfGiGpuSlots | undefined;
  private readonly bakeCache = createSdfSceneBakeCache();
  private lastBakedRevision = Number.NaN;
  private dispatchedWindows = 0;
  private metricsSnapshot: SdfGiMetrics = { sdfGiBakes: 0, sdfGiBakeCells: 0, sdfGiProbeCount: 0,
    sdfGiProbesUpdated: 0, sdfGiProbeWindowOffset: 0, sdfGiSkyTraceDispatches: 0 };
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
   * 帧步进:场景 dirty 时烘焙 + 上传 + 派发天光追踪;随后按预算派发探针 SH 更新窗口。
   * 全部挂调用方 encoder;无静态场景(空包/全透明/全动态)时跳过(fail-visible 不产 NaN)。
   */
  encodeFrame(encoder: GPUCommandEncoder, input: SdfGiFrameInput,
    passTiming?: SdfGiPassTiming): SdfGiFramePlan {
    if (this.disposed) throw new Error("SDF GI runtime is disposed.");
    const timing = sdfGiTimedPassRegistration().registered ? passTiming : undefined;
    let baked = false;
    let bakeReport: SdfSceneBakeReport | undefined;
    if (input.sceneRevision !== this.lastBakedRevision) {
      this.lastBakedRevision = input.sceneRevision;
      const result = this.encodeBake(encoder, timing);
      baked = result.baked;
      bakeReport = result.report;
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
    this.metricsSnapshot = { ...this.metricsSnapshot,
      sdfGiProbesUpdated: window.count, sdfGiProbeWindowOffset: window.offset };
    return { baked, ...(bakeReport ? { bakeReport } : {}),
      probeWindow: Object.freeze({ ...window }), probeCount: slots?.probeCount ?? 0 };
  }

  private get directionCount(): number {
    return this.options.directionCount === 32 ? 32 : 16;
  }

  /** 场景 dirty 烘焙:适配包 → CPU 增量烘焙 → 上传 → 天光追踪 dispatch;
   * cells 超规模墙时确定性倍增 cellSize 重试(六次仍超 fail-visible 上抛,不静默降质)。 */
  private encodeBake(encoder: GPUCommandEncoder, timing?: SdfGiPassTiming):
    { baked: boolean; report?: SdfSceneBakeReport } {
    const snapshot = this.pendingSnapshot;
    if (!snapshot) return { baked: false };
    const instances: readonly SdfSceneBakeInstance[] = sdfGiBakeInstancesFromPackets(snapshot);
    if (!instances.length) return { baked: false };
    const domain = this.options.instanceDomain ?? "aabb";
    const maxExtent = instanceMaxExtent(instances);
    let cellSize = clampFinite(this.options.cellSize, 0.05, 1,
      clampFinite(maxExtent / 64, 0.05, 1, 0.25));
    let bake: ReturnType<typeof bakeSdfSceneGrid> | undefined;
    try {
      bake = bakeSdfSceneGrid(instances, { cellSize, cache: this.bakeCache, instanceDomain: domain });
    } catch (error) {
      let lastError: unknown = error;
      for (let attempt = 0; attempt < 6 && bake === undefined; attempt++) {
        cellSize = Math.min(cellSize * 2, 8);
        try {
          bake = bakeSdfSceneGrid(instances, { cellSize, cache: this.bakeCache, instanceDomain: domain });
        } catch (retryError) { lastError = retryError; }
      }
      if (!bake) throw lastError;
    }
    const grid = bake.grid;
    const config = resolveSdfSkyVisibilityTraceConfig(grid,
      this.options.traceSteps === undefined ? {} : { steps: this.options.traceSteps });
    // 探针 lattice:内缩半格起采样,避免探针贴面(贴面探针 SDF=0 → 全向假遮蔽)。
    const inset = Math.max(grid.cellSize * 0.5, 1e-3);
    const bounds = {
      min: [grid.origin[0]! + inset, grid.origin[1]! + inset, grid.origin[2]! + inset] as const,
      max: [grid.origin[0]! + (grid.dimensions[0]! - 1) * grid.cellSize - inset,
        grid.origin[1]! + (grid.dimensions[1]! - 1) * grid.cellSize - inset,
        grid.origin[2]! + (grid.dimensions[2]! - 1) * grid.cellSize - inset] as const,
    };
    const lattice = deriveSdfGiProbeLattice(bounds,
      this.options.probeSpacing ?? Math.max(grid.cellSize * 4, 0.25),
      this.options.maxProbes ?? 4096);
    this.uploadSlots(grid, lattice.positions, config);
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
    this.metricsSnapshot = { ...this.metricsSnapshot,
      sdfGiBakes: this.metricsSnapshot.sdfGiBakes + 1, sdfGiBakeCells: slots.cells,
      sdfGiProbeCount: slots.probeCount,
      sdfGiSkyTraceDispatches: this.metricsSnapshot.sdfGiSkyTraceDispatches + 1 };
    return { baked: true, report: bake.report };
  }

  /** 重建 GPU 槽位并上传静态层输入(烘焙帧;失败时新建资源回滚,旧槽位保留)。 */
  private uploadSlots(grid: { origin: readonly [number, number, number]; cellSize: number;
    dimensions: readonly [number, number, number]; distances: Float32Array<ArrayBuffer> },
    positions: readonly (readonly number[])[],
    config: { steps: number; coneTan: number; maxDistance: number }): void {
    const directionCount = this.directionCount;
    const probeCount = positions.length;
    const field = uploadBuffer(this.session, "Deep SDF GI scene field", grid.distances, STORAGE_READ);
    const probePositions = uploadBuffer(this.session, "Deep SDF GI probe positions",
      packSdfGiProbePositions(positions), STORAGE_READ);
    const directions = uploadBuffer(this.session, "Deep SDF GI directions",
      packSdfGiDirectionTable(directionCount), STORAGE_READ);
    const visibilities = createAdmittedBuffer(this.session, { label: "Deep SDF GI sky visibility",
      size: Math.max(16, probeCount * directionCount * 4), usage: STORAGE_RW });
    // 记录行 = 24 float = 96B/探针(SDF_GI_PROBE_RECORD_VEC4_STRIDE=6 vec4 × 16B)。
    const records = createAdmittedBuffer(this.session, { label: "Deep SDF GI probe records",
      size: Math.max(16, probeCount * SDF_GI_PROBE_RECORD_VEC4_STRIDE * 16), usage: STORAGE_RW });
    const skyRadiance = createAdmittedBuffer(this.session, { label: "Deep SDF GI sky radiance",
      size: Math.max(16, directionCount * 16), usage: STORAGE_READ });
    const traceParams = uploadBuffer(this.session, "Deep SDF GI trace params",
      new Float32Array(SDF_SKY_VISIBILITY_PARAMS_BYTES / 4), USAGE_UNIFORM);
    const updateParams = uploadBuffer(this.session, "Deep SDF GI update params",
      new Float32Array(SDF_GI_PROBE_UPDATE_PARAMS_BYTES / 4), USAGE_UNIFORM);
    const created = [field, probePositions, directions, visibilities, records, skyRadiance,
      traceParams, updateParams];
    try {
      this.session.device.queue.writeBuffer(traceParams, 0, packSdfGiSkyTraceParams({
        origin: grid.origin, cellSize: grid.cellSize, dimensions: grid.dimensions,
        steps: config.steps, coneTan: config.coneTan, maxDistance: config.maxDistance,
        directionCount, probeCount }));
      this.session.device.queue.writeBuffer(records, 0,
        packInitialSdfGiRecords(probeCount, config.maxDistance));
      const traceBindGroup = this.session.device.createBindGroup({
        label: "Deep SDF GI sky trace bindings", layout: this.traceLayout, entries: [
          { binding: 0, resource: { buffer: traceParams } },
          { binding: 1, resource: { buffer: field } },
          { binding: 2, resource: { buffer: probePositions } },
          { binding: 3, resource: { buffer: directions } },
          { binding: 4, resource: { buffer: visibilities } },
        ] });
      const updateBindGroup = this.session.device.createBindGroup({
        label: "Deep SDF GI probe update bindings", layout: this.updateLayout, entries: [
          { binding: 0, resource: { buffer: updateParams } },
          { binding: 1, resource: { buffer: visibilities } },
          { binding: 2, resource: { buffer: skyRadiance } },
          { binding: 3, resource: { buffer: records } },
        ] });
      this.releaseSlots();
      this.slots = { field, probePositions, directions, visibilities, records, skyRadiance,
        traceParams, updateParams, traceBindGroup, updateBindGroup, probeCount,
        cells: grid.distances.length };
      this.lastLattice = positions;
    } catch (error) {
      for (const buffer of created.reverse()) this.session.release(buffer);
      throw error;
    }
  }

  private releaseSlots(): void {
    const slots = this.slots;
    if (!slots) return;
    for (const buffer of [slots.field, slots.probePositions, slots.directions, slots.visibilities,
      slots.records, slots.skyRadiance, slots.traceParams, slots.updateParams]) {
      this.session.release(buffer);
    }
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseSlots();
  }
}

function clampFinite(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
