/**
 * Brief-GI M2 生产 SDF GI 的帧合同类型(与 GPU 运行时分离,守 300 行体量门)。
 * 这些类型是 pbrRendererFrames 帧循环 ↔ SdfGiProductionRuntime 的唯一接口面。
 */

export interface SdfGiRuntimeOptions {
  /** 场景 SDF 体素边长(米);缺省 = 场景最长边/64(钳 [0.05,1],cells 超预算确定性倍增)。 */
  readonly cellSize?: number;
  /** 探针格间距(米);缺省 = max(cellSize×4, 0.25),预算不足确定性倍增。 */
  readonly probeSpacing?: number;
  /** 探针预算上限;缺省 4096(96B ABI → 384KiB 记录存储)。 */
  readonly maxProbes?: number;
  /** 每探针方向数(16 标准/32 高档);缺省 16。 */
  readonly directionCount?: number;
  /** 逐资产烘焙域;缺省 "aabb"(内存安全档)。 */
  readonly instanceDomain?: "aabb" | "scene";
  /** 时域滤波 α;缺省 0.1(resolveDeepGiTemporalAlpha 解析)。 */
  readonly alpha?: number;
  /** 静态 1 bounce 均匀反照率(线性 RGB ∈[0,1]);缺省关(与 CPU 域一致)。 */
  readonly bounceAlbedo?: readonly [number, number, number];
  /** 圆锥追踪步数(8..16);缺省 8。 */
  readonly traceSteps?: number;
}

export interface SdfGiFrameInput {
  /** 当前包场景 revision(packets.visibilityRevision;变化即触发重烘焙)。 */
  readonly sceneRevision: number;
  /** 本帧天空辐射(线性 RGB;生产 = 环境均值 × environmentIntensity)。 */
  readonly skyRadianceRgb: readonly [number, number, number];
  /** 本帧探针更新预算(knobs.ddgiUpdateBudget 同族;≤0 视作本帧跳过更新)。 */
  readonly budgetProbes: number;
}

export interface SdfGiFramePlan {
  /** 本帧执行了场景烘焙 + 天光追踪(静态层刷新)。 */
  readonly baked: boolean;
  /** 烘焙报告(baked 帧携带;遥测/验收证据链)。 */
  readonly bakeReport?: import("./sdfSceneBake.js").SdfSceneBakeReport;
  /** 本帧派发的探针更新窗口(offset/count;count 0 = 跳过)。 */
  readonly probeWindow: Readonly<{ offset: number; count: number }>;
  /** 已就绪探针数(0 = 场景未烘焙,更新跳过)。 */
  readonly probeCount: number;
  /** 本帧探针场已物化为 clipmap 采样纹理(宿主据此 setProbeClipmap 发布)。 */
  readonly published: boolean;
  /** 本帧 GPU 烘焙执行(compute 距离场;false = CPU 增量路径或无烘焙)。 */
  readonly gpuBaked: boolean;
}

export interface SdfGiMetrics {
  sdfGiBakes: number;
  /** GPU compute 距离场烘焙次数(sdfSceneBakeGpu;CPU 回退帧不计入)。 */
  sdfGiBakesGpu: number;
  sdfGiBakeCells: number;
  sdfGiProbeCount: number;
  sdfGiProbesUpdated: number;
  sdfGiProbeWindowOffset: number;
  sdfGiSkyTraceDispatches: number;
  /** 探针消费物化 dispatch 次数(主 pass clipmap 纹理每帧覆写)。 */
  sdfGiPublishDispatches: number;
}

/** passTiming marker 括夹面(与 GpuTimer.beginPasses 的 marker 对齐;登记前不括夹)。 */
export interface SdfGiPassTiming {
  beginMarker(encoder: GPUCommandEncoder, passId: string): void;
  endMarker(encoder: GPUCommandEncoder, passId: string): void;
}

/** GPU 槽位(烘焙产物;运行时内部状态,导出仅为体量门下的类型单源)。 */
export interface SdfGiGpuSlots {
  readonly field: GPUBuffer;
  readonly probePositions: GPUBuffer;
  readonly directions: GPUBuffer;
  readonly visibilities: GPUBuffer;
  readonly records: GPUBuffer;
  readonly skyRadiance: GPUBuffer;
  readonly traceParams: GPUBuffer;
  readonly updateParams: GPUBuffer;
  readonly traceBindGroup: GPUBindGroup;
  readonly updateBindGroup: GPUBindGroup;
  readonly probeCount: number;
  readonly cells: number;
}
