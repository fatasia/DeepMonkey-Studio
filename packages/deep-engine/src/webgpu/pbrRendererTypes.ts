import type { WorldClusteredLights } from "../lighting/worldLights.js";
import type { LodFrameBudget } from "../spatial/lodTypes.js";
import type { CascadedShadowResourceOptions } from "./cascadedShadowResources.js";
import type { PbrFrameUniformView } from "./pbrFrameUniforms.js";
import type { PbrRendererFeatureOptions } from "./pbrRendererFeatures.js";
import type { PbrEnvironmentSource } from "./pbrEnvironmentSource.js";
import type { EditorOverlaySnapshot } from "./editorOverlayTypes.js";
import type { AuthorGridView } from "./authorGridTypes.js";
import type { PbrTransientTexturePoolStats } from "./pbrTransientTexturePool.js";
import type { DeviceResourceMemorySnapshot } from "./deviceResourceMemory.js";
import type { PbrFrameCaptureOptions } from "./pbrFrameCapture.js";
import type { AdaptiveQualityHotspotSummary, AdaptiveQualityOptions, AdaptiveQualityState } from "./adaptiveQuality.js";
import type { PbrAutoExposureFrameMetrics, PbrAutoExposureOptions } from "./pbrAutoExposure.js";
import type { ProbeClipmapRuntimeOptions } from "./probeClipmapRuntime.js";
import type { GpuParticleEmitter, GpuParticleEmitterRuntimeOptions } from "./gpuParticleEmitters.js";
import type { VirtualTextureOptions } from "../virtualTextures/virtualTextureOptions.js";
import type { DeviceRecoveryOptions } from "./deviceRecovery.js";
import type { GpuParticleFlowField } from "./gpuParticleFlowFieldTypes.js";

export interface RenderView extends PbrFrameUniformView {
  /** Optional replayable curl field for existing particleEmitters; omission uses the original kernel. */
  readonly particleFlow?: GpuParticleFlowField;
  readonly authorGrid?: AuthorGridView | undefined;
  readonly editorOverlay?: EditorOverlaySnapshot;
  /**
   * P2 投影纹理光(three r186 ProjectorLight gobo 纹理半部;opt-in features.projectedTextures
   * 且本字段供给时生效):单投影器视锥纹理直接光,帧内解析为视空间矩阵后进后链加性层
   * (SSR 前)。未供给/校验失败 = 该帧无投影器贡献(后者经 FrameMetrics.projectedTextures
   * fallbackReason 披露),帧逐位零变化。
   */
  readonly projectedTextures?: import("../postprocess/projectedTextureTypes.js").ProjectedTextureLight;
  /**
   * 多投影器灯池(≤4,2026-10-06 后继切片):供给时覆盖单投影器字段(池语义,
   * 逐灯解析后核内槽序累加);超 4 灯 fail-closed 丢弃该帧灯池并披露。灯池内单灯
   * 校验失败仅剔除该灯(fallbackReason 如实),其余灯照常贡献。
   */
  readonly projectedTextureLights?: readonly import("../postprocess/projectedTextureTypes.js").ProjectedTextureLight[];
  readonly width: number; readonly height: number; readonly pixelRatio: number;
  readonly lights?: WorldClusteredLights; readonly lodBudget?: LodFrameBudget;
}

/** 首帧管线引导时序：不改变管线集合内容，只改变“发布前等待哪些变体”。
 * 每个开关独立可关，关闭即回到全量等待的旧时序。 */
export interface PbrPipelineBootstrapOptions {
  /** 首帧只等待关键 main 变体；其余 main 变体在 bootstrap 校验作用域关闭后排队。
   * 关键集合由后端从首帧包推导（firstFrameMainKeys）；独立包路径缺省启用，
   * 投影路径在 backend.create 前 CPU 预投影推导（2026-10-07 首帧攻坚），
   * `false` 显式退出回全量等待。 */
  readonly firstFrameSubset?: boolean;
  /** 后端推导出的首帧 main 管线键（由 threeBridge 填充；plain/ccw 恒含）。 */
  readonly firstFrameMainKeys?: readonly string[];
  /** 已知作者包的变形 main 键；缺省沿用 firstFrameMainKeys。 */
  readonly deformationFirstFrameMainKeys?: readonly string[];
  /** 变形变体在 bootstrap 校验作用域关闭后才开始创建；含变形的包在 packet 边界
   * 等待其就绪，首个静态首帧不再为变形编译买单。 */
  readonly deferDeformation?: boolean;
}

export interface PbrRendererOptions {
  /** One explicit fixed-topology, untextured, single-instance CPU vertex stream. Off by default.
   * Publish before command encoding; this does not supply previous-vertex TAA history. */
  readonly vertexStreamingGeometry?: string;
  /** Explicit physical display opt-in; omitted preserves the existing SDR surface. */
  readonly hdrDisplay?: import("./hdrDisplayOutput.js").HdrDisplayRequest;
  /** 显式的同设备托管资源估算上限；未知布局拒绝，非驱动物理 VRAM 上限。 */
  readonly deviceMemoryBudgetBytes?: number;
  /** 帧内目标的估算字节上限；不包含 history、阴影或流式几何。默认 512 MiB。 */
  readonly transientTextureBudgetBytes?: number;
  /** T07 动态内部分辨率策略；提供即启用帧时反馈的内部缩放（1 = 关闭等效上限）。 */
  readonly resolutionScalePolicy?: import("../postprocess/resolutionScaler.js").ResolutionScalePolicy;
  readonly meshlets?: boolean;
  /**
   * Cluster PBR replacement (opt-in): packet sections retain their material,
   * texture, instance and motion streams. Unsupported sections draw normally.
   * Attribute-rich topology stays exact; constant-normal plain surfaces simplify.
   * stageClusterLodScene remains a separate position-only diagnostic interface.
   */
  readonly clusterLod?: boolean;
  /** Explicitly allocates GPU pose-stream pipelines; author support is negotiated separately. */
  readonly deformation?: boolean;
  readonly shadows?: CascadedShadowResourceOptions;
  /** C10 接触阴影资源配置;features.contactShadows 打开时生效,默认(不带)关闭。 */
  readonly contactShadows?: import("../shadows/contactShadowResources.js").ContactShadowResourceOptions;
  /** Brief-GI M2 SDF GI 运行时配置;features.sdfGi 打开时生效,默认(不带)关闭。 */
  readonly sdfGi?: import("../gi/sdfGiRuntimeTypes.js").SdfGiRuntimeOptions;
  /**
   * M2 方向光 RT 阴影场景供给(opt-in,features.rayTracedShadows):调用方打包的
   * TLAS 场景(rayTracing/tlasLayout.packTlasScene 产物)。缺省 = 构造期 fail-closed
   * 回级联(features 快照的 RT 位清 0,原因经 rayTracedShadowStatus 披露,不静默假开);
   * 后续场景更新经 stageRayTracedShadowScene 注入(一帧后生效)。
   */
  readonly rayTracedShadowScene?: import("../rayTracing/tlasLayout.js").TlasPackedScene;
  /** M2 RT 阴影 f16 压缩节点档(需 adapter "shader-f16";缺省 false)。 */
  readonly rayTracedShadowF16?: boolean;
  /**
   * F3 虚拟纹理采样接线(opt-in,缺省关闭 = 零行为变化):`enabled:true` 时安装
   * 页 atlas 预算驻留控制器,渲染循环逐帧 反馈采集 → 预算驻留 → atlas 独立绑定组,
   * 并以独立 WGSL tile-lookup compute pass 消费采样(pbrShader 主 pass 接入留后续)。
   * 驻留失败(atlas 创建/session 未就绪)fail-closed 回整纹理路径,原因经
   * FrameMetrics.virtualTextures.fallbackReason 显式披露。
   */
  readonly virtualTextures?: VirtualTextureOptions;
  readonly features?: PbrRendererFeatureOptions;
  /**
   * 选择性材质变体(opt-in,缺省 false = 管线 WGSL 与原版逐字节一致):编译 sheen / iridescence /
   * clearcoat IBL / 体积透射(three r185 语义),材质 uniform 为 240B;与 layeredMaterials、textureArrays
   * 管线互斥(texture-array 批次对含 advanced 参数的材质回退常规路径)。
   */
  readonly advancedMaterials?: boolean;
  /** Optional compiled lobe mask; absent retains all advanced features. Missing lobes reject before upload. */
  readonly advancedMaterialFeatures?: number;
  readonly environment?: PbrEnvironmentSource;
  /** Optional R12 capture transaction; omitted on normal production frames. */
  readonly frameCapture?: PbrFrameCaptureOptions;
  /** Off by default; uses bounded local telemetry and never disables scene content or interaction. */
  readonly adaptiveQuality?: AdaptiveQualityOptions;
  /** Omitted keeps probe GI off; present installs the DDGI/surface-cache runtime into the PBR loop. */
  readonly probeClipmap?: ProbeClipmapRuntimeOptions;
  /**
   * GI 探针方向数配置（G3-S1 门控）：`undefined` = 保持已发布默认 32（零配置画质口径）；
   * "standard"/16 与 "high"/32 显式选档；非法值经门 fail-closed 回 16。
   */
  readonly probeDirections?: import("../lighting/probeRadianceDirectionGate.js").DeepGiProbeDirectionPreset
    | import("../lighting/probeRadianceDirectionGate.js").DeepGiProbeDirectionCount;
  /** Optional GPU particle emitters; simulation runs one frame ahead and renders indirectly. */
  readonly particleEmitters?: readonly GpuParticleEmitter[];
  readonly particleRuntime?: GpuParticleEmitterRuntimeOptions;
  /**
   * F8 自动曝光(opt-in,缺省关闭 = 零行为变化):环境 mip 亮度静态代理(零 GPU
   * readback)→ ±EV 包络(默认 ±2)→ 时域平滑(时间常数参数化,帧间收敛上限
   * 防闪烁)。无可靠环境亮度(studio 程序环境 / 无源 / mip 解码失败)时 fail-closed
   * 回调用方 view.exposure 固定启发式,原因经 FrameMetrics.autoExposure 显式披露。
   * 默认切换(Z1 提案 P0)与桥接线(threeBridge renderer 字面量、rendererCapabilities
   * 快照白名单)留主线,模式同 t25-gpu-pass-timing。
   */
  readonly autoExposure?: PbrAutoExposureOptions;
  /** 首帧管线引导时序开关；缺省全部关闭 = 全量等待的旧时序。 */
  readonly pipelines?: PbrPipelineBootstrapOptions;
  /**
   * F1 逐 pass GPU 计时(opt-in 诊断):开启即启用诊断采样,并在每个 executed
   * mapped pass 上用 timestamp marker 括夹测量。设备不支持 timestamp-query、槽池
   * 耗尽或读回未完成时优雅降级(FrameMetrics.gpuPassTimings 显式 unavailable,
   * 帧级三段计时照旧),不报错、不伪零。
   */
  readonly gpuPassTiming?: boolean;
  /**
   * F7b 局部光阴影图集档位(opt-in,缺省 "standard" = 已发布默认逐值不变):
   * "multi-light" 以每灯分辨率换阴影灯容量(1024 图集 4×4 tile,16 灯全覆盖,
   * F7a 真机 RMSE 0.042 vs 默认档 0.165)。分辨率/容量随 spot uniform ABI
   * (16 条目/1536B)放行;宿主显式 limits 更小时解析器 fail-closed。
   */
  readonly localSpotShadowAtlasTier?: import("../shadows/localSpotShadowAtlasQuality.js").LocalSpotShadowAtlasTier;
  /**
   * B1 Brief-VSM 主阴影档(opt-in,缺省 undefined = 级联,与 displayContract.shadow.mode
   * 缺字段=级联同口径):"virtual" 时主方向光阴影走三环 clipmap 虚拟阴影
   * (16k² 等效虚拟分辨率,页表物化 + 着色端页表查询 + PCSS + 缺页回退上一环);
   * 级联资源保留为回退档(虚拟构造失败 fail-closed 回级联,原因随遥测披露)。
   * author 阴影(scene primary.shadow)存在时不生效(回级联,显式不静默)。
   */
  readonly shadowMode?: "virtual" | "cascaded";
  /** B1 Brief-VSM 虚拟阴影资源配置(shadowMode="virtual" 时生效;缺省全默认)。 */
  readonly virtualShadow?: import("./virtualShadowResources.js").VirtualShadowResourceOptions;
  /**
   * AA-M1 主 pass MSAA 采样数请求(仅 1/4 合法,缺省 4 = 默认开):设备不支持 4x
   * (depth32float 多采样缺失等)时 bootstrap 探针 fail-closed 回 1x,原因经
   * FrameMetrics.msaa.fallbackReason 显式披露。附属目标(线性深度/view-normal/OIT)
   * 恒 1x;直出 display 快路径不参与 MSAA。
   */
  readonly msaaSampleCount?: 1 | 4;
  /** C13 typed device recovery; omitted keeps the legacy immediate-loss behavior. */
  readonly recovery?: DeviceRecoveryOptions;
}

export interface FrameMetrics {
  /**
   * 常规帧图回执(每帧,非 timing):pass 序/本帧实际编码集/未映射槽位。逐 pass
   * GPU 毫秒不在此,经 gpuPassTimings 滞后发布;samples 对缺测 pass 保持显式
   * unavailable(原因注明「异步发布/未请求」),不伪零。
   */
  readonly frameGraphReceipt?: import("./pbrFramePlanExecutor.js").PbrFrameExecutionReceipt;
  /**
   * F1 真实执行 coverage(每帧):帧图登记 pass 集与本帧实际编码集的差集读数
   * (量,非时);执行集合来自编码分支,禁止从图成员推断。
   */
  readonly frameExecutionCoverage?: import("./pbrFrameExecutionCoverage.js").PbrFrameExecutionCoverage;
  /**
   * F1 可见绘制量读出(每帧,量非时):主 pass 包体(packets.draw)的 CPU 编码
   * drawCalls/triangles 与该帧剔除批计数。GPU 逐实例幸存数需读回(=新同步),
   * 不提供;T01 visibleInstances 保持 null,不把该读数伪称逐实例。
   */
  readonly visibleDraws?: { readonly drawCalls: number; readonly triangles: number;
    readonly frustumCulledBatches: number; readonly hiZOccludedBatches: number };
  /**
   * F1 逐 pass GPU 计时(opt-in,`gpuPassTiming`):最新完成读回的一帧逐 pass
   * 毫秒数据。GPU 读回滞后 1-2 帧,实测帧号在 `frame` 字段内,不得当成本帧;
   * `gpuPassTiming` 未开启时整字段缺省(面板显示「未开启」)。
   */
  readonly gpuPassTimings?: import("./pbrFrameReceipt.js").PbrFramePassTimings;
  /**
   * F8 自动曝光遥测(`autoExposure` 开启时出现):active=本帧实际生效;降级帧给
   * fallbackReason(studio 程序环境/无源/解码失败),不伪零。未开启时整字段缺省。
   */
  readonly autoExposure?: PbrAutoExposureFrameMetrics;
  readonly meshletPasses?: number;
  readonly meshletDispatches?: number;
  readonly meshletFallbackReasons?: readonly string[];
  /**
   * G1-S1 簇级槽位遥测（`clusterLod` 开启且已 stage 时出现）：draws = 前沿 indirect
   * 命令数（GPU 真实绘制命令；bundle 本身在 drawCalls 计 1 次 executeBundles）。
   * stale = 选层在途（bundle 相对相机滞后 ≤1 帧）；warming = 尚无可用 bundle；
   * fallbackReason = fail-closed 原因（sticky，重 stage 恢复）。
   */
  readonly clusterLod?: import("./clusterLodRenderSlot.js").ClusterLodSlotMetrics;
  readonly clusterLodProduction?: ReturnType<import("./packetClusterLodResources.js").PacketClusterLodResources["metrics"]>;
  /**
   * B3 RT 阴影自动选路遥测(features.rayTracedShadows + 场景已供给的帧出现):
   * channel = 本帧实际生效通道;cascade 帧附 reason(controller:* / 自适应档 / 滞回)。
   */
  readonly rtShadowRoute?: import("./rtShadowScheduling.js").RtShadowRouteMetrics;
  readonly frame: number; readonly cpuSubmitMs: number;
  readonly drawCalls: number; readonly triangles: number;
  readonly width: number; readonly height: number; readonly resources: number;
  /**
   * AA-M1 主 pass MSAA 状态(每帧):requested = 请求档(缺省 4),active = 能力探针
   * 解析后的生效档;设备不支持 4x 回退 1x 时 fallbackReason 携带探针验证错误原文。
   */
  readonly msaa?: { readonly requested: 1 | 4; readonly active: 1 | 4; readonly fallbackReason?: string };
  /**
   * A2C-P1 运行时 a2c 有效性探针(一次性,首个含 a2c 批次的 MSAA 主 pass 帧后结算,
   * 读回异步 → 披露滞后测量帧 ≥1;结算后每帧披露):a2c 采样掩码在本机是否真实生效。
   * verdict=inconclusive 为 fail-open(不可判定时保持 a2c);渲染器只披露不决策,
   * 降级决策在宿主。edgeDitherThreshold 是取证场景校准值(8·W),场景自适应判据属后续,
   * 见 test-output/A2C-P1-HANDOFF.md 诚实边界。
   */
  readonly a2cProbe?: import("./a2cFrameProbe.js").A2cProbeMetrics;
  /**
   * B1 Brief-VSM 虚拟阴影遥测(shadowMode="virtual" 档每帧):物化/驻留/动态失效/
   * 预算利用率;fallbackReason = 构造或启用失败的原因(fail-closed 回级联,不伪零)。
   */
  readonly virtualShadow?: {
    readonly mode: "virtual" | "cascaded";
    readonly fallbackReason?: string;
    readonly materializedPages?: number;
    readonly requestPages?: number;
    readonly deferredByBudget?: number;
    readonly dynamicInvalidated?: number;
    readonly residentPages?: number;
    readonly evictedPages?: number;
    readonly estimatedCostMs?: number;
    readonly budgetUtilization?: number;
    readonly pageDrawCalls?: number;
    readonly pageRenderPasses?: number;
  };
  /** B1 Brief-VSM 主阴影档(virtual 档构造成功时出现;级联档缺省零行为)。 */
  readonly shadowMode?: "virtual";
  /** B1 Brief-VSM 虚拟页池几何遥测(virtual 档构造成功时出现)。 */
  readonly virtualShadowPages?: {
    readonly residentPages: number;
    readonly allocatedSlots: number;
    readonly physicalPages: number;
    readonly atlasEdge: number;
    readonly atlasLayers: number;
    readonly pageEdge: number;
    readonly mipCount: number;
  };
  /** Real RenderTargets allocation/reuse counters after this frame's queue submission. */
  readonly transientTextures?: PbrTransientTexturePoolStats;
  /** 同一 device 的已托管分配；已包含 transient，二者不能相加。 */
  readonly deviceResourceMemory?: DeviceResourceMemorySnapshot;
  readonly shadowUpdated: boolean; readonly cameraCut: boolean;
  /** C10 接触阴影遥测(opt-in 才存在)。 */
  readonly contactShadowTier?: "performance" | "balanced" | "quality";
  readonly contactShadowMaskBytes?: number;
  /**
   * F3 虚拟纹理遥测(`virtualTextures.enabled` 时出现):驻留/上传/反馈/采样消费
   * 逐帧快照;fallbackActive 时采样方走整纹理路径,原因在 fallbackReason。
   */
  readonly virtualTextures?: import("./virtualTextureFrameBridge.js").VirtualTextureFrameMetrics;
  /**
   * B2 MegaLights M2 遥测(features.megaLights 开启且控制器已构建时出现):
   * dispatchedFrames 累计、lastLightCount/lastReason 为最近一次路径决策依据
   * (≤64 灯帧 reason=within-cluster-budget 且零 dispatch)。visibilitySource 披露
   * 胜者可见性射线供给:rt-shadow-tlas = 复用 RT 阴影 staging 场景且本帧 trace
   * dispatch;off = 无供给(fail-closed 可见性恒 1,原因查 rayTracedShadowStatus);
   * unsupported = 可见性档构建失败(visibilityFallbackReason 如实披露,不重试)。
   */
  readonly megaLights?: import("../lighting/megaLightsFrameController.js").MegaLightsFrameMetrics;
  /**
   * B3 RT 反射 closest-hit 帧通道遥测(features.rayTracedReflections 开启时出现):
   * dispatched=false 携带 reason(场景未 staging/构造失败,如实披露);dispatched=true
   * 为本帧 dispatch 形状。命中记录的生产消费未接线,画面零变化(下一切片)。
   */
  readonly rtReflections?: { dispatched: boolean; reason?: string;
    width?: number; height?: number; dispatchX?: number; dispatchY?: number;
    /**
     * P1 RT specular GI 一次反弹 indirection 本帧状态:true = 已 dispatch 且 indirection
     * 已供给 SSR 合成后屏外填充;false = fail-closed(缺失 reason 如实披露),填充不
     * 发生,SSR 输出逐位透传。字段缺省 = 特性关或本帧无 closest-hit 通道。
     */
    indirectDispatched?: boolean; indirectReason?: string };
  /**
   * P2 投影纹理光遥测(features.projectedTextures 开启且 RenderView 供给投影器时出现):
   * active=本帧实际进后链加性层;active=false 为 fail-closed(校验失败,缺失
   * fallbackReason 如实披露,不伪零)。场景未供给投影器时整字段缺省。
   */
  readonly projectedTextures?: { readonly active: boolean; readonly projectors: number;
    readonly fallbackReason?: string };
  readonly postProcessPasses: number; readonly weightedOit: boolean;
  readonly hiZMipLevels: number; readonly occlusionCulling: boolean;
  readonly frustumCulledBatches: number; readonly hiZOccludedBatches: number; readonly lodSelectionBatches: number; readonly lodIndirectDraws: number;
  readonly lightCount: number; readonly lightClusters: number; readonly shadowTier: string; readonly shadowDepthBytes: number;
  /** Required evidence for exact-profile consumers; optional for older preset runtimes. */
  readonly shadowMapSize?: number;
  readonly shadowCascadeCount?: number;
  /** Actual author LOD compute work for main, refreshed directional cascades, and local spots. */
  readonly authorFrustumPasses?: number;
  readonly authorFrustumDispatches?: number;
  readonly adaptiveQuality?: AdaptiveQualityState;
  readonly resolutionScale?: (import("../postprocess/resolutionScaler.js").InternalResolutionReport & { revision: number }) | undefined;
  /**
   * F4 时域超分遥测(temporalUpscale 特性 + scale<1 激活时出现):display 尺寸=画布,
   * historyUsed=false 表示该帧历史失效退化为纯 Catmull-Rom(fail-closed,不残留)。
   */
  readonly temporalUpscale?: { readonly displayWidth: number; readonly displayHeight: number;
    readonly historyUsed: boolean; readonly invalidation: string };
  /** 对象级描边遥测(仅 packet 含 outline 实例的帧出现);skippedBatches>0 表示变形/meshlet 批次未进入掩码。 */
  readonly outline?: { readonly drawCalls: number; readonly skippedBatches: number };
  readonly adaptiveHotspots?: readonly AdaptiveQualityHotspotSummary[];
  /**
   * A2 内存专项(刀2)重建周期账目:每次 renderer dispose 落一条「释放估算」入进程级
   * 有界台账(最近 16 条;total 单调含已逐出)。`ordinal` = 本实例序号(0 起),
   * `total` = 已完成重建总数,`last` = 最近一次重建账目。逐帧不重复展开 —— 只在
   * total 变化后的第一帧携带,消费方以 total 变化为准;分配侧看同帧
   * deviceResourceMemory,两侧相减即单周期净增量。backend 切换风暴(release-soak
   * 实测 39 次/11min)的每次增量据此可对账,供后续水位门取数。
   */
  readonly rendererRebuilds?: {
    readonly ordinal: number;
    readonly total: number;
    readonly last?: import("./pbrRendererRebuildAccounting.js").RendererRebuildAccountingEntry;
  };
}
