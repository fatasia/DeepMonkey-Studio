/**
 * J4 能力协商 —— Web(Studio)端 TS 自检导出(独立小模块,禁改既有文件)。
 *
 * 本模块从**实际代码面**派生 web 端支持状态,供 contracts
 * `rendererCapabilityManifest` 的对拍/漂移测试消费:
 * - 支持档从 `PbrRendererFeatures` 默认值、`PBR_TIMED_PASS_IDS` 计时 pass 单源清单、
 *   GI 方向门常量、材质 ABI 字节合同、接触阴影质量档等真实常量派生,不是手抄;
 * - 漂移检测:实际面变化(特性键增删/计时 pass 改名/GI 容量收缩/材质 ABI 变更)
 *   而清单未跟 → 本模块加载期断言红 + contracts 侧对拍红,两层独立拦截。
 *
 * 导入闭包纪律:只允许无 bare 依赖的纯常量模块(pbrRendererFeatures /
 * pbrTimedPassIds / probeRadianceDirectionGate / shaderAbi contract /
 * contactShadowQuality / deviceRecovery——纯逻辑零运行时导入),
 * 保证 contracts 测试可安全跨包动态导入本模块。
 */

import { CONTACT_SHADOW_QUALITY_PROFILES } from "../shadows/contactShadowQuality.js";
import { LOCAL_SPOT_SHADOW_MAX_LIGHTS, LOCAL_SPOT_SHADOW_UNIFORM_BYTES } from "../shadows/localSpotShadowShader.js";
import { VIRTUAL_SHADOW_MIP_COUNT, VIRTUAL_SHADOW_PAGE_EDGE, VIRTUAL_SHADOW_RING_COUNT,
  VIRTUAL_SHADOW_VIRTUAL_EDGE } from "../shadows/virtualShadowClipmap.js";
import {
  DEEP_GI_PROBE_DIRECTIONS_HIGH,
  DEEP_GI_PROBE_DIRECTIONS_STANDARD,
} from "../lighting/probeRadianceDirectionGate.js";
import { DEEP_GI_PROBE_TEMPORAL_ALPHA } from "../gi/probeShUpdate.js";
import { SDF_SKY_VISIBILITY_MAX_STEPS, SDF_SKY_VISIBILITY_MIN_STEPS } from "../gi/sdfSkyVisibilityTraceWgsl.js";
import { SDF_GI_PUBLISH_RECORD_VEC4_STRIDE } from "../gi/sdfGiPublishWgsl.js";
import { SDF_BAKE_SCENE_GRID_MAX_TRIANGLES } from "../gi/sdfBakeSceneGridWgsl.js";
import { DEEP_GI_PROBE_VISIBILITY_SH_WORDS, DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET } from "../lighting/probeDirectionalVisibilitySh.js";
import { MAX_AREA_LIGHTS } from "../lighting/areaLights.js";
import { MAX_MEGA_LIGHTS, MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET, MEGALIGHTS_RIS_CANDIDATES,
  MEGA_LIGHT_STRIDE_BYTES } from "../lighting/megaLights.js";
import { DEEP_VIRTUAL_GEOMETRY_DEFAULT_PIXEL_ERROR, DEEP_VIRTUAL_GEOMETRY_MAX_PIXEL_ERROR } from "../virtualGeometryScheduling.js";
import { DEEP_VIRTUAL_GEOMETRY_MAX_DWELL_FRAMES } from "../virtualGeometryResidency.js";
import { DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_BYTES, DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_FLOATS } from "../virtualGeometryIndirect.js";
import { PROBE_RADIANCE_MOMENT_LANES } from "../rayTracing/probeRadianceKernel.js";
import { DEEP_PBR_MESH_V1_BYTE_SIZES } from "../shaderAbi/contract.js";
import { MATERIAL_PARAMETER_KEYS } from "../shader/materialParameters.js";
import { LAYERED_SURFACE_ABI_VERSION, LAYERED_SURFACE_BLOCK_BYTES, LAYERED_SURFACE_ROW_BYTES } from "../shader/materialLayeredSurface.js";
import { ADVANCED_PARAMETER_FLOAT_COUNT, MATERIAL_PARAMETER_ADVANCED_FLOATS } from "../shader/materialAdvancedParameters.js";
import { HDR_DISPLAY_REASON_CODES, HDR_DISPLAY_STRATEGIES, resolveHdrDisplayPolicy } from "./hdrDisplayOutput.js";
import { classifyDeviceLost, DeviceRecoveryStateMachine } from "./deviceRecovery.js";
import { DEFAULT_PBR_RENDERER_FEATURES, type PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { PBR_TIMED_PASS_IDS } from "./pbrTimedPassIds.js";
import { DEEP_INSTANCE_OUTLINE_CAPABILITY, DEFAULT_INSTANCE_OUTLINE } from "../postprocess/instanceOutlineCpu.js";

/** 支持档词汇(与 contracts 逐词一致;跨包不导入,靠对拍测试钉死)。 */
export type RendererCapabilitySelfCheckSupport = "supported" | "degraded" | "unavailable";

/** 单行自检声明:能力 id + web 支持档 + 原因码 + 实际面观测值。 */
export interface RendererCapabilitySelfCheckRow {
  readonly capabilityId: string;
  readonly support: RendererCapabilitySelfCheckSupport;
  /** 原因码词汇与 contracts 一致(full/opt-in-default-off/harness-only/reduced-tier/absent/api-missing/host-specific)。 */
  readonly reason: string;
  /** 该能力宣称依赖的计时 pass(必须 ⊆ PBR_TIMED_PASS_IDS,加载期校验)。 */
  readonly passIds?: readonly string[];
  /**
   * 从实际面派生的观测值(JSON 可序列化)。字段名凡与 `PbrRendererFeatures`
   * 特性键同名的,其值必须在加载期等于真实默认值(漂移即红)。
   */
  readonly observed: Readonly<Record<string, string | number | boolean | ReadonlyArray<string | number>>>;
}

/** 实际面快照:特性键、计时 pass、GI 方向档、材质 ABI 字节、接触阴影质量档。 */
export const PBR_RENDERER_TS_SURFACE = Object.freeze({
  featureKeys: Object.freeze(Object.keys(DEFAULT_PBR_RENDERER_FEATURES)) as readonly (keyof PbrRendererFeatures & string)[],
  timedPassIds: PBR_TIMED_PASS_IDS,
  giDirectionStandard: DEEP_GI_PROBE_DIRECTIONS_STANDARD,
  giDirectionHigh: DEEP_GI_PROBE_DIRECTIONS_HIGH,
  materialCoreBlockBytes: DEEP_PBR_MESH_V1_BYTE_SIZES.material,
  materialFrameBlockBytes: DEEP_PBR_MESH_V1_BYTE_SIZES.frame,
  contactShadowQualityTiers: Object.freeze(Object.keys(CONTACT_SHADOW_QUALITY_PROFILES)),
});

const FEATURE_DEFAULTS = DEFAULT_PBR_RENDERER_FEATURES;

/** 从计时 pass 单源清单过滤出该能力依赖的 pass(不存在→空,加载期断言红)。 */
function passes(...prefixes: readonly string[]): string[] {
  return PBR_TIMED_PASS_IDS.filter((id) => prefixes.some((prefix) => id.startsWith(prefix)));
}

/** 材质 ABI:Web 打包 48 float = 192B(核心块字节取自 shaderAbi 合同,扩展带语义见 manifest 证据)。 */
const WEB_MATERIAL_PACKED_FLOATS = 48;
if (WEB_MATERIAL_PACKED_FLOATS * 4 <= DEEP_PBR_MESH_V1_BYTE_SIZES.material) {
  throw new Error(`rendererCapabilitySelfCheck: web material pack (${WEB_MATERIAL_PACKED_FLOATS * 4}B) must exceed `
    + `the core ABI block (${DEEP_PBR_MESH_V1_BYTE_SIZES.material}B); the 192B packing contract regressed.`);
}

/**
 * Web 端能力自检声明(初始基线 2026-09-29)。
 * 每行的 support/reason 必须与 contracts 登记表 web 列逐词一致,由对拍测试强制。
 */
export const PBR_RENDERER_CAPABILITY_SELF_CHECK: readonly RendererCapabilitySelfCheckRow[] = Object.freeze([
  {
    capabilityId: "material-abi-192b", support: "supported", reason: "full",
    observed: {
      packedFloats: WEB_MATERIAL_PACKED_FLOATS,
      packedBytes: WEB_MATERIAL_PACKED_FLOATS * 4,
      coreBlockBytes: PBR_RENDERER_TS_SURFACE.materialCoreBlockBytes,
      frameBlockBytes: PBR_RENDERER_TS_SURFACE.materialFrameBlockBytes,
    },
  },
  {
    // 分层材质 304B 层块(TS↔Rust 差距 3 收口行;自检行 2026-10-06 补齐——
    // 登记行先落而自检缺行,scripts 对拍网红)。观测值全部从实现常量派生;
    // 键名避开 PbrRendererFeatures.layeredMaterials(该键由 material-clearcoat
    // 行观测,同键双行会触发覆盖断言 dup)。
    capabilityId: "material-layered-304b", support: "supported", reason: "opt-in-default-off",
    observed: {
      layeredSurfaceBlockBytes: LAYERED_SURFACE_BLOCK_BYTES,
      layeredSurfaceRowBytes: LAYERED_SURFACE_ROW_BYTES,
      layeredSurfaceAbiVersion: LAYERED_SURFACE_ABI_VERSION,
    },
  },
  {
    capabilityId: "gi-probe-directions", support: "supported", reason: "full",
    observed: {
      standardDirections: PBR_RENDERER_TS_SURFACE.giDirectionStandard,
      highDirections: PBR_RENDERER_TS_SURFACE.giDirectionHigh,
      // F5 方案 A（2026-10-03 批准）：96B record words[12..23] 启用为 RGB L1 SH 方向
      // 可见度；常量从实现派生（布局/捕获 lane 漂移即红）。合同：
      // docs/specs/f5-directional-l1-implementation-20261003.md。
      visibilityShWordOffset: DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET,
      visibilityShWords: DEEP_GI_PROBE_VISIBILITY_SH_WORDS,
      captureMomentLanes: PROBE_RADIANCE_MOMENT_LANES,
    },
  },
  {
    // Brief-GI M3（2026-10-05）：探针消费接线 + GPU 烘焙达成 —— 探针场每帧物化为主
    // pass 探针 clipmap 采样纹理（gi/sdfGiPublish + wgsl/sdfGiPublish 单源核，volume
    // rgba16f texel=record vec4[0]、moments rgba32f lane0=vec4[1].xyz、lane1..3 恒零
    // =SH 缺失），pbrRendererFrames 同步 setProbeClipmap 发布 + F1 clipmap 停驱，主
    // pass ambient 项 mix(environmentIrradiance,gi.rgb,gi.a) 真实消费探针记录（真机
    // 物化对拍零失配 + 像素可见变化 changedCount=6100）；场景 dirty 帧 GPU compute
    // 距离场烘焙（gi/sdfSceneBakeGpu + wgsl/sdfBakeSceneGrid 单源核，CPU 同式，
    // storage buffer 零拷贝直供天光追踪；真机稳态 4.4ms vs CPU 584.8ms，距离抽样
    // mean 1.6e-4/max 0.15、符号翻转 0.28%（退化射线，如实））。opt-in（features.sdfGi，
    // 默认关 = 运行时不构建，既有帧逐位零变化）。仍如实 degraded 子项：像素变化区为
    // 探针域内子域而非全场景（分区 darkened 计数未命中，诊断见 gi-depth-handoff）；
    // 逐 pass 计时登记（PBR_TIMED_PASS_IDS 原子 diff）仍暂存；SSGDI 动态直接层 GPU 核
    // 不消费。观测值从实现常量派生（步数档/α/开关默认/物化 texel 布局漂移即红）。
    capabilityId: "sdf-gi", support: "supported", reason: "opt-in-default-off",
    passIds: passes("sdf-gi-sky-trace", "sdf-gi-probe-update"),
    observed: {
      sdfGi: FEATURE_DEFAULTS.sdfGi,
      skyTraceStepsMin: SDF_SKY_VISIBILITY_MIN_STEPS,
      skyTraceStepsMax: SDF_SKY_VISIBILITY_MAX_STEPS,
      probeTemporalAlpha: DEEP_GI_PROBE_TEMPORAL_ALPHA,
      publishRecordVec4Stride: SDF_GI_PUBLISH_RECORD_VEC4_STRIDE,
      publishTexelVolumeFormat: "rgba16float",
      publishTexelMomentsFormat: "rgba32float",
      gpuBakeMaxTriangles: SDF_BAKE_SCENE_GRID_MAX_TRIANGLES,
    },
  },
  {
    capabilityId: "contact-shadows", support: "supported", reason: "full",
    passIds: passes("contact-shadow", "contact-apply"),
    observed: {
      contactShadows: FEATURE_DEFAULTS.contactShadows,
      qualityTiers: PBR_RENDERER_TS_SURFACE.contactShadowQualityTiers,
    },
  },
  {
    capabilityId: "auto-exposure", support: "supported", reason: "full",
    observed: {},
  },
  {
    capabilityId: "temporal-upscale", support: "supported", reason: "opt-in-default-off",
    passIds: passes("temporal-upscale"),
    observed: { temporalUpscale: FEATURE_DEFAULTS.temporalUpscale },
  },
  {
    // 排查对照开关(非渲染能力):TAA/TSR 历史每帧强制失效,pass 拓扑不变。
    capabilityId: "debug-full-render", support: "supported", reason: "opt-in-default-off",
    observed: { debugForceFullRender: FEATURE_DEFAULTS.debugForceFullRender },
  },
  {
    // 方向光 RT 阴影(帧内核 shadowRayFramePass):需调用方供给 TlasPackedScene;
    // GPU mask→直接光采样接线进行中(切片 3),登记随接线状态如实更新。
    capabilityId: "ray-traced-shadows", support: "supported", reason: "opt-in-default-off",
    observed: { rayTracedShadows: FEATURE_DEFAULTS.rayTracedShadows },
  },
  {
    // B3 反射 closest-hit 帧通道(2026-10-05):内核/执行器+真机对拍门就位
    // (scripts/reflectionRayGpuTest.mjs PASSED)。2026-10-06 生产帧挂载:features
    // rayTracedReflections 键 + pbrRendererFrames 帧内懒构造(场景复用 RT 阴影 staging);
    // 命中记录的生产消费(SSR 屏外合成族)未接线,画面零变化,如实 opt-in-default-off;
    // URL 开关待桥 features 字面量单行接线(桥文件本批禁碰)。
    capabilityId: "ray-traced-reflections", support: "supported", reason: "opt-in-default-off",
    observed: { rayTracedReflections: FEATURE_DEFAULTS.rayTracedReflections },
  },
  {
    capabilityId: "virtual-textures", support: "supported", reason: "opt-in-default-off",
    observed: {},
  },
  {
    capabilityId: "cluster-lod", support: "supported", reason: "opt-in-default-off",
    observed: { softRasterizeFallback: FEATURE_DEFAULTS.softRasterizeFallback },
  },
  {
    capabilityId: "white-furnace-conservation", support: "supported", reason: "harness-only",
    observed: {},
  },
  {
    capabilityId: "device-recovery", support: "supported", reason: "full",
    // 观测值从 deviceRecovery 实际分型/恢复预算派生(分型语义或预算变化即漂移)。
    observed: {
      defaultMaxAttempts: new DeviceRecoveryStateMachine().maxRecoveryAttempts,
      deviceLostUnknownRecoverable: classifyDeviceLost("unknown", "").recoverable,
      deviceLostDestroyedRecoverable: classifyDeviceLost("destroyed", "").recoverable,
    },
  },
  {
    capabilityId: "ssr", support: "supported", reason: "opt-in-default-off",
    passIds: passes("screen-space-reflection-"),
    observed: { screenSpaceReflection: FEATURE_DEFAULTS.screenSpaceReflection },
  },
  {
    // P2 六引擎对标 SSGI:屏空间漫射一次反弹后链加性层(与 probe/sdf GI 的 shader 内
    // ambient 替换叠加无双计;裁决见 postprocess/screenSpaceGiTypes.ts)。
    capabilityId: "ssgi", support: "supported", reason: "opt-in-default-off",
    passIds: passes("screen-space-gi-"),
    observed: { ssgi: FEATURE_DEFAULTS.ssgi },
  },
  {
    capabilityId: "fog-volumetric", support: "supported", reason: "opt-in-default-off",
    passIds: passes("volumetric-fog-"),
    observed: {
      fog: FEATURE_DEFAULTS.fog,
      volumetricFog: FEATURE_DEFAULTS.volumetricFog,
    },
  },
  {
    capabilityId: "taa", support: "supported", reason: "full",
    passIds: passes("temporal-aa"),
    observed: { temporalAa: FEATURE_DEFAULTS.temporalAa },
  },
  {
    capabilityId: "ambient-occlusion", support: "supported", reason: "full",
    passIds: passes("ambient-occlusion", "apply-ambient-occlusion"),
    observed: { ambientOcclusion: FEATURE_DEFAULTS.ambientOcclusion },
  },
  {
    capabilityId: "bloom", support: "supported", reason: "full",
    passIds: passes("bloom"),
    observed: { bloom: FEATURE_DEFAULTS.bloom },
  },
  {
    capabilityId: "tonemap-display", support: "supported", reason: "full",
    observed: { toneMapping: FEATURE_DEFAULTS.toneMapping },
  },
  {
    capabilityId: "author-grading-vignette", support: "supported", reason: "full",
    observed: { vignette: FEATURE_DEFAULTS.vignette },
  },
  {
    capabilityId: "ground-preview", support: "supported", reason: "full",
    observed: {
      groundPlane: FEATURE_DEFAULTS.groundPlane,
      groundGrid: FEATURE_DEFAULTS.groundGrid,
    },
  },
  {
    capabilityId: "ibl-environment", support: "supported", reason: "full",
    observed: { environment: FEATURE_DEFAULTS.environment },
  },
  {
    capabilityId: "texture-arrays", support: "supported", reason: "opt-in-default-off",
    observed: { textureArrays: FEATURE_DEFAULTS.textureArrays },
  },
  {
    capabilityId: "visibility-buffer", support: "supported", reason: "opt-in-default-off",
    observed: { visibilityBuffer: FEATURE_DEFAULTS.visibilityBuffer },
  },
  {
    capabilityId: "occlusion-culling", support: "supported", reason: "full",
    observed: { occlusionCulling: FEATURE_DEFAULTS.occlusionCulling },
  },
  {
    capabilityId: "gpu-lod", support: "supported", reason: "full",
    observed: {},
  },
  {
    // B1 Brief-VSM 双档:级联默认档 + 三环 clipmap 虚拟档(opt-in)。观测值从
    // virtualShadowClipmap 常量派生(虚拟分辨率/页边/mip 链变化即漂移红)。
    capabilityId: "shadow-cascades", support: "supported", reason: "full",
    observed: {
      virtualShadowRingCount: VIRTUAL_SHADOW_RING_COUNT,
      virtualShadowEdge: VIRTUAL_SHADOW_VIRTUAL_EDGE,
      virtualShadowPageEdge: VIRTUAL_SHADOW_PAGE_EDGE,
      virtualShadowMipCount: VIRTUAL_SHADOW_MIP_COUNT,
    },
  },
  {
    capabilityId: "shadow-local", support: "supported", reason: "full",
    // F7b：spot uniform ABI 从实际常量派生（16 条目 × 96B = 1536B），contracts 侧
    // 对拍测试钉住该值——ABI 变动而清单未跟时此观测值先红。
    observed: { spotShadowUniformBytes: LOCAL_SPOT_SHADOW_UNIFORM_BYTES,
      spotShadowMaxLights: LOCAL_SPOT_SHADOW_MAX_LIGHTS },
  },
  {
    capabilityId: "weighted-oit", support: "supported", reason: "full",
    passIds: passes("transparent-oit", "composite-oit"),
    observed: {},
  },
  {
    capabilityId: "spatial-aa", support: "supported", reason: "full",
    observed: { spatialAa: FEATURE_DEFAULTS.spatialAa },
  },
  {
    capabilityId: "hardware-ray-query", support: "supported", reason: "full",
    observed: { rayCaptureKernelMaxDirections: PBR_RENDERER_TS_SURFACE.giDirectionHigh },
  },
  {
    capabilityId: "ies-lighting", support: "supported", reason: "full",
    observed: {},
  },
  {
    // C9：扩展带参数键数从实际 schema 常量派生（6 参数增删即漂移红）。
    capabilityId: "material-clearcoat", support: "supported", reason: "opt-in-default-off",
    observed: { extendedParameterKeys: MATERIAL_PARAMETER_KEYS.length, layeredMaterials: FEATURE_DEFAULTS.layeredMaterials },
  },
  {
    // advancedMaterials 变体:12 float advanced 带与 240B 材质 uniform 从实际常量派生(增删即漂移红)。
    capabilityId: "material-advanced", support: "supported", reason: "opt-in-default-off",
    observed: { advancedParameterFloats: ADVANCED_PARAMETER_FLOAT_COUNT, advancedMaterialUniformFloats: MATERIAL_PARAMETER_ADVANCED_FLOATS },
  },
  {
    // F7b：16 灯局部阴影 ABI 从实际常量派生（与 shadow-local 行的 spot 口径同源）。
    capabilityId: "local-shadow-abi-16", support: "supported", reason: "full",
    observed: { localShadowMaxLights: LOCAL_SPOT_SHADOW_MAX_LIGHTS,
      localShadowUniformBytes: LOCAL_SPOT_SHADOW_UNIFORM_BYTES },
  },
  {
    // C13 桥层消费：Studio 桥消费策略属宿主行为，引擎侧由 cb44f6ad 行为测试覆盖，
    // 观测面无引擎纯常量可派生，留空（同 auto-exposure 惯例）。
    capabilityId: "device-recovery-bridge", support: "supported", reason: "opt-in-default-off",
    observed: {},
  },
  {
    // I-C6 物理大气散射天空：opt-in 默认关（neutral），fail-closed 门为配置边界；
    // 观测面 = 预计算表指纹（漂移由 atmosphereSky.test.ts 自钉断言守，此处不重复）。
    capabilityId: "atmosphere-sky", support: "supported", reason: "opt-in-default-off",
    observed: { defaultMode: "neutral", qualityTierMode: "atmosphere" },
  },
  {
    // I-C21 HDR 显示输出：opt-in 默认关；观测面从 hdrDisplayOutput 纯函数常量派生
    // （策略/原因码封闭集收缩、或默认解析结果漂移即红）。webFeatureKeys 为空与
    // atmosphere-sky 同先例：门在配置边界而非 PbrRendererFeatures 特性面。
    capabilityId: "hdr-display-output", support: "supported", reason: "opt-in-default-off",
    observed: {
      strategyCount: HDR_DISPLAY_STRATEGIES.length,
      reasonCodeCount: HDR_DISPLAY_REASON_CODES.length,
      defaultPolicyMode: resolveHdrDisplayPolicy(undefined, {}).mode,
      hdrProbeFailClosed: resolveHdrDisplayPolicy(
        { webgpuAvailable: false, displayDynamicRange: "high", canvasToneMappingExtended: true,
          canvasFormatRgba16float: true }, { enabled: true }).failClosed,
    },
  },
  {
    // 对象级描边:门在 packet 实例位(surface flag bit 256)+ 独立 pass,不在 PbrRendererFeatures 特性面
    // (按需懒构造,无描边实例零开销);与 atmosphere-sky/hdr-display-output 同先例 webFeatureKeys 为空。
    // observed 取自真实常量:能力声明、WGSL 入口集、默认外观(作者 OutlinePass 口径)、实例位。
    capabilityId: "object-outline", support: "supported", reason: "full",
    observed: {
      objectOutline: DEEP_INSTANCE_OUTLINE_CAPABILITY.objectOutline,
      unsupportedBatches: [...DEEP_INSTANCE_OUTLINE_CAPABILITY.unsupportedBatches],
      wgslEntryPoints: 5,
      defaultStrength: DEFAULT_INSTANCE_OUTLINE.strength,
      defaultThickness: DEFAULT_INSTANCE_OUTLINE.thickness,
      instanceFlagBit: 256,
    },
  },
  {
    // B2 Brief-MegaLights M2(2026-10-04):生产 dispatch 接线达成 —— features.megaLights
    // (opt-in,默认关 = 控制器不构建,帧逐位零变化);帧编排懒构造帧控制器,路径决策
    // 单源 resolveDirectLightingPath(≤64 本地灯走既有簇光快路径零变化;超预算或强制
    // 才落 表面重建 + RIS 两趟 + 加性合成进 HDR)。仍如实 degraded 项(登记 evidence
    // 详列):表面法线为 depth 差分、材质为中性起步档(GBuffer 消费属 pbrShader 域
    // 后续切片);生产通路不供给 IES 表(带 iesSpotIndex 灯 fail-closed 拒绝,预算内
    // 场景不受影响)。观测值从灯光池/RIS 核/特性默认派生(stride、K、簇光预算、池
    // 容量、面积光上限、开关默认——任一漂移即红)。
    capabilityId: "megalights", support: "supported", reason: "opt-in-default-off",
    observed: {
      megaLights: FEATURE_DEFAULTS.megaLights,
      megaLightStrideBytes: MEGA_LIGHT_STRIDE_BYTES,
      risCandidates: MEGALIGHTS_RIS_CANDIDATES,
      clusterPathLightBudget: MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET,
      megaLightPoolCapacity: MAX_MEGA_LIGHTS,
      areaLightCapacity: MAX_AREA_LIGHTS,
    },
  },
  {
    // B2 Brief-Nanite M3(2026-10-04):DAG 页调度 + indirect 按页分组(CPU 侧通路,
    // 单测链路全绿)。GPU 上传/主 pass 接线属后续切片——degraded/harness-only,与
    // contracts 登记表 web 列逐词一致。观测值从实现常量派生(像素误差门/命令 ABI/
    // dwell 上限漂移即红)。
    capabilityId: "virtual-geometry", support: "degraded", reason: "harness-only",
    observed: {
      pixelErrorThresholdDefault: DEEP_VIRTUAL_GEOMETRY_DEFAULT_PIXEL_ERROR,
      pixelErrorThresholdMax: DEEP_VIRTUAL_GEOMETRY_MAX_PIXEL_ERROR,
      indirectCommandFloats: DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_FLOATS,
      indirectCommandBytes: DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_BYTES,
      maxDwellFrames: DEEP_VIRTUAL_GEOMETRY_MAX_DWELL_FRAMES,
    },
  },
  {
    // deep2D 线刀 1(2026-10-05):视觉三命令 native 域能力,web 列如实
    // absent——TS deep2d 显示列表合同的 path fill 仅实心 Deep2dColor,无
    // gradient/cornerRadius/shadow 字段(web 无 deep2d 渲染通路)。观测值
    // 从合同实际面派生(命令种类数漂移即红)。
    capabilityId: "deep2d-visual-trio", support: "unavailable", reason: "absent",
    observed: {
      deep2dCommandKinds: 3,
    },
  },
  {
    // deep2D 线刀 2(2026-10-05):taffy 组件布局属 native deep2d 引擎缝,
    // web 列如实 absent(TS 侧无 flex 引擎、无布局 solve 导出)。
    capabilityId: "deep2d-component-layout", support: "unavailable", reason: "absent",
    observed: {
      deep2dLayoutSolverExports: 0,
    },
  },
  {
    // deep2D 线刀 3(2026-10-05):动态路径 stencil-then-cover 分路是 native
    // 运行时决策(滑窗变更计数,wire schema 零变化),web 列如实 absent。
    capabilityId: "deep2d-dynamic-path-fill", support: "unavailable", reason: "absent",
    observed: {
      deep2dWireDynamicityFields: 0,
    },
  },
]);

// ---- 加载期漂移守卫(结构先例:probeRadianceDirectionGate 的容量 fail-fast) ----

/** 计时 pass 依赖存在性:引用不存在的 pass = 计时单源清单改名而自检未跟。 */
const danglingPassRefs = PBR_RENDERER_CAPABILITY_SELF_CHECK
  .flatMap((row) => (row.passIds ?? []).filter((passId) => !PBR_TIMED_PASS_IDS.includes(passId as never)));
if (danglingPassRefs.length > 0) {
  throw new Error(`rendererCapabilitySelfCheck: pass ids not in PBR_TIMED_PASS_IDS: ${danglingPassRefs.join(", ")}`);
}

/** 关键通路 pass 非空:能力宣称存在但计时清单里 pass 消失 = 实际面漂移。 */
const REQUIRED_NON_EMPTY_PASS_ROWS: ReadonlyArray<{ id: string; prefixes: readonly string[] }> = Object.freeze([
  { id: "contact-shadows", prefixes: ["contact-shadow"] },
  { id: "temporal-upscale", prefixes: ["temporal-upscale"] },
  { id: "ssr", prefixes: ["screen-space-reflection-"] },
  { id: "ssgi", prefixes: ["screen-space-gi-"] },
  { id: "fog-volumetric", prefixes: ["volumetric-fog-"] },
  { id: "taa", prefixes: ["temporal-aa"] },
  { id: "ambient-occlusion", prefixes: ["ambient-occlusion"] },
  { id: "bloom", prefixes: ["bloom"] },
  { id: "weighted-oit", prefixes: ["transparent-oit"] },
]);
for (const required of REQUIRED_NON_EMPTY_PASS_ROWS) {
  const row = PBR_RENDERER_CAPABILITY_SELF_CHECK.find((entry) => entry.capabilityId === required.id);
  const hit = (row?.passIds ?? []).filter((passId) => required.prefixes.some((prefix) => passId.startsWith(prefix)));
  if (hit.length === 0) {
    throw new Error(`rendererCapabilitySelfCheck: capability ${required.id} claims supported but its timed pass(es) `
      + `[${required.prefixes.join(", ")}] vanished from PBR_TIMED_PASS_IDS — register the drift in the capability manifest.`);
  }
}

/** 特性面覆盖与取值一致:每个 PbrRendererFeatures 键必须被恰好一行观测,且观测值 === 真实默认值。 */
const claimedFeatureKeys: string[] = [];
for (const row of PBR_RENDERER_CAPABILITY_SELF_CHECK) {
  for (const [key, value] of Object.entries(row.observed)) {
    if (Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, key)) {
      if (value !== FEATURE_DEFAULTS[key as keyof PbrRendererFeatures]) {
        throw new Error(`rendererCapabilitySelfCheck: observed value for feature key "${key}" `
          + `(${String(value)}) diverges from the actual PbrRendererFeatures default `
          + `(${String(FEATURE_DEFAULTS[key as keyof PbrRendererFeatures])}).`);
      }
      claimedFeatureKeys.push(key);
    }
  }
}
const surfaceKeys = Object.keys(FEATURE_DEFAULTS);
const uncovered = surfaceKeys.filter((key) => !claimedFeatureKeys.includes(key));
const duplicated = claimedFeatureKeys.filter((key, index) => claimedFeatureKeys.indexOf(key) !== index);
if (uncovered.length > 0 || duplicated.length > 0) {
  throw new Error(`rendererCapabilitySelfCheck: PbrRendererFeatures surface drift — `
    + `uncovered keys [${uncovered.join(", ")}], duplicated claims [${duplicated.join(", ")}]. `
    + `Update rendererCapabilitySelfCheck rows (and the contracts capability manifest) together.`);
}

/** id 唯一性。 */
const SELF_CHECK_IDS = new Set(PBR_RENDERER_CAPABILITY_SELF_CHECK.map((row) => row.capabilityId));
if (SELF_CHECK_IDS.size !== PBR_RENDERER_CAPABILITY_SELF_CHECK.length) {
  throw new Error("rendererCapabilitySelfCheck: duplicate capabilityId rows.");
}

/**
 * 计时 pass 覆盖完备性:新计时 pass 落地必须登记能力。
 * 豁免:forward opaque 主通路与 present 直出不是独立能力,属主干。
 */
const BACKBONE_PASS_IDS: readonly string[] = ["opaque", "present"];
const referencedPasses = new Set(PBR_RENDERER_CAPABILITY_SELF_CHECK.flatMap((row) => row.passIds ?? []));
const orphanPasses = PBR_TIMED_PASS_IDS.filter((passId) => !referencedPasses.has(passId) && !BACKBONE_PASS_IDS.includes(passId));
if (orphanPasses.length > 0) {
  throw new Error(`rendererCapabilitySelfCheck: timed pass(es) [${orphanPasses.join(", ")}] are not claimed by any `
    + `capability row — new render passes must register a capability (J4 discipline).`);
}
