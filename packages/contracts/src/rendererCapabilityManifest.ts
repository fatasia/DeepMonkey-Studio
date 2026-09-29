/**
 * J4 渲染能力协商合同 —— 渲染能力登记表(单源清单,shared by Studio and native hosts)。
 *
 * == 为什么需要这张表 ==
 * 过渡期(单源化铺完前)每个新渲染能力必须在"任一端"落地的同时在 capacities 登记
 * **双端状态**。缺少这张表时,能力经常只在一端实现而另一端静默缺失/降级,验收
 * 只看实现端就会误报"完成"。本清单把"悄悄只做一边"变成结构化可测事实:
 * 每个 capability id 必须同时给出 web(Studio/TS)与 native(deep-engine-native/Rust)
 * 的支持档 + 原因码 + 文件证据。
 *
 * == 词汇 ==
 * - 支持档:`supported / degraded / unavailable`(封闭集,与 native
 *   `host_capabilities/rt_probe.rs::RtSupport` 的"支持档+原因档+记录式理由"先例同构)。
 * - 原因码:封闭集,见 `RENDERER_CAPABILITY_REASON_CODES`;每档有合法配对集
 *   (`reasonPairsForSupport`),配对非法视为清单损坏。
 * - 质量档词汇沿用既有跨端合同:DeepGiQuality = performance|balanced|quality
 *   (deep-engine probeClipmapPlan.ts,注释明示 shared by Studio and native hosts);
 *   native quality_profile.rs 把作者档 quality 解析为 High 并在遥测写回 quality。
 *
 * == 纪律(强制) ==
 * 1. 新能力落地(任一端)必须在 `RENDERER_CAPABILITY_MANIFEST` 登记双端状态与原因;
 *    只做一端 = 清单漂移,会被对拍/覆盖率测试打红。
 * 2. 状态变化必须同步更新证据(evidence 指向真实文件,测试断言文件存在)。
 * 3. TS 侧实际面自检导出:`deep-engine/src/webgpu/rendererCapabilitySelfCheck.ts`
 *    (从 PbrRendererFeatures/计时 pass 清单/GI 方向门等实际代码面派生);
 *    Rust 侧同形声明:`deep-engine-native/src/renderer_capability_manifest.rs`。
 *    双端与金样 `fixtures/renderer-capability-manifest.json` 三方对拍。
 * 4. 结构先例:deep-engine pbrTimedPassIds.ts(冻结 id 数组+构建期漂移校验)、
 *    native rt_probe(支持+原因+理由)、probeRadianceDirectionGate(能力常量+加载期断言)。
 */

/** 支持档封闭词汇。 */
export const RENDERER_CAPABILITY_SUPPORT_VOCABULARY = Object.freeze([
  "supported",
  "degraded",
  "unavailable",
] as const);

export type RendererCapabilitySupport = (typeof RENDERER_CAPABILITY_SUPPORT_VOCABULARY)[number];

/** 原因码封闭词汇(kebab-case,与 native serde rename_all="kebab-case" 逐词一致)。 */
export const RENDERER_CAPABILITY_REASON_CODES = Object.freeze([
  /** 该端完整实现,语义达到能力定义。 */
  "full",
  /** 完整实现但默认关闭(opt-in),开启即得完整语义。 */
  "opt-in-default-off",
  /** 该端仅验收/参考 harness(CPU 参考或金样对拍),非运行时通路。 */
  "harness-only",
  /** 有实现,但范围/档位低于能力定义(降级存在,原因必须写进 evidence)。 */
  "reduced-tier",
  /** 该端没有实现。 */
  "absent",
  /** 底层 API 缺席(如 wgpu 30 不暴露 ray tracing),与实现无关。 */
  "api-missing",
  /** 能力按设计只属于某类宿主(如 WebGPU 时间历史 vs native 直出通路)。 */
  "host-specific",
] as const);

export type RendererCapabilityReasonCode = (typeof RENDERER_CAPABILITY_REASON_CODES)[number];

/** 支持档 → 合法原因码集合。双端校验与 native 端镜像必须逐词一致。 */
export const REASON_PAIRS_FOR_SUPPORT: Readonly<Record<RendererCapabilitySupport, readonly RendererCapabilityReasonCode[]>> = Object.freeze({
  supported: Object.freeze(["full", "opt-in-default-off", "harness-only"] as const),
  degraded: Object.freeze(["opt-in-default-off", "harness-only", "reduced-tier"] as const),
  unavailable: Object.freeze(["absent", "api-missing", "host-specific"] as const),
});

/** 合同版本:清单结构变化(增删字段/词汇)时递增,金样与 native 端同步。 */
export const RENDERER_CAPABILITY_CONTRACT_VERSION = 1;

/** 单端声明。 */
export interface RendererCapabilityEndDeclaration {
  readonly support: RendererCapabilitySupport;
  readonly reason: RendererCapabilityReasonCode;
  /** 文件证据:仓库根相对路径(可带 `:符号/行` 后缀),指向当前真实实现。 */
  readonly evidence: string;
}

/** 登记表行:一个渲染能力的双端状态。 */
export interface RendererCapabilityManifestEntry {
  readonly id: string;
  readonly title: string;
  /** 该能力覆盖的 Web `PbrRendererFeatures` 特性键(可为空;非特性面能力如材质 ABI)。 */
  readonly webFeatureKeys: readonly string[];
  readonly web: RendererCapabilityEndDeclaration;
  readonly native: RendererCapabilityEndDeclaration;
  /** 质量档词汇是否与跨端合同同词(performance/balanced/quality)。 */
  readonly sharedQualityVocabulary?: boolean;
}

/**
 * evidence 里的仓库路径:截掉 `:符号/行` 与紧跟路径的 `(说明)` 后缀,
 * 只留可用于 fs 存在性断言的仓库相对路径。
 */
export function rendererCapabilityEvidencePath(evidence: string): string {
  const colon = evidence.indexOf(":");
  const base = colon === -1 ? evidence : evidence.slice(0, colon);
  const paren = base.indexOf("(");
  return paren === -1 ? base : base.slice(0, paren);
}

/** 单端声明的结构校验:返回问题列表,空数组=合法。 */
export function rendererCapabilityDeclarationIssues(
  end: RendererCapabilityEndDeclaration, endName: string, id: string): string[] {
  const issues: string[] = [];
  if (!(RENDERER_CAPABILITY_SUPPORT_VOCABULARY as readonly string[]).includes(end.support)) {
    issues.push(`${id}[${endName}] 未知支持档 ${String(end.support)}`);
  }
  if (!(RENDERER_CAPABILITY_REASON_CODES as readonly string[]).includes(end.reason)) {
    issues.push(`${id}[${endName}] 未知原因码 ${String(end.reason)}`);
    return issues;
  }
  const allowed = REASON_PAIRS_FOR_SUPPORT[end.support];
  if (allowed && !allowed.includes(end.reason)) {
    issues.push(`${id}[${endName}] 支持档 ${end.support} 不允许原因码 ${end.reason}(允许:${allowed.join("|")})`);
  }
  if (!end.evidence || !rendererCapabilityEvidencePath(end.evidence).endsWith(".ts")
    && !rendererCapabilityEvidencePath(end.evidence).endsWith(".rs")) {
    issues.push(`${id}[${endName}] 证据必须是 .ts/.rs 仓库路径:${end.evidence}`);
  }
  return issues;
}

/**
 * 渲染能力登记表(初始基线 2026-09-29,按当前代码面逐条填写)。
 * 顺序稳定:金样 JSON 与 native include_str! 消费方依赖该顺序。
 */
export const RENDERER_CAPABILITY_MANIFEST: readonly RendererCapabilityManifestEntry[] = Object.freeze([
  {
    id: "material-abi-192b",
    title: "材质参数 ABI 块(Web 192B 打包 / native 160B 核心块)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/materialBindings.ts:MATERIAL_PARAMETER_FLOATS(48 float=192B 唯一打包实现;基础块 40 float=160B 与 native 同源)",
    },
    native: {
      support: "degraded", reason: "reduced-tier",
      evidence: "packages/deep-engine-native/src/mesh_abi.rs:MATERIAL_UNIFORM_FLOATS(=40,160B 核心块;Web 扩展带 40..48 由 WGSL extendedShade 零填充回退,native 不消费扩展参数)",
    },
  },
  {
    id: "gi-probe-directions",
    title: "探针 GI 方向档(standard 16 / high 32)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/lighting/probeRadianceDirectionGate.ts:DEEP_GI_PROBE_DIRECTIONS_STANDARD/HIGH(16/32;内核容量 32;生产默认 32)",
    },
    native: {
      support: "degraded", reason: "reduced-tier",
      evidence: "packages/deep-engine-native/src/renderer/native_gi_producer.rs:produce_direct_irradiance(确定性直光种子 producer + probe_gi_abi.rs 96B 布局合同;无 32 方向辐射内核/clipmap 采样通路)",
    },
    sharedQualityVocabulary: true,
  },
  {
    id: "contact-shadows",
    title: "屏幕空间接触阴影(C10)",
    webFeatureKeys: ["contactShadows"],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:contactShadows(opt-in 默认 false;shadows/contactShadowQuality.ts 三档质量档)",
    },
    native: { support: "unavailable", reason: "absent", evidence: "packages/deep-engine-native/src/lib.rs(无 contact shadow 模块;shadow 通路仅 cascaded/local)" },
    sharedQualityVocabulary: true,
  },
  {
    id: "auto-exposure",
    title: "自动曝光(F8)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/pbrAutoExposure.ts:estimateEnvironmentLuminance(环境亮度估计→EV 包络曝光,默认启用)",
    },
    native: { support: "unavailable", reason: "absent", evidence: "packages/deep-engine-native/src/lib.rs(无 auto exposure 模块)" },
  },
  {
    id: "temporal-upscale",
    title: "时域超分上采样(F4)",
    webFeatureKeys: ["temporalUpscale"],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:temporalUpscale(opt-in;temporal-upscale 计时 pass;Catmull-Rom+时域重投影核;reactiveMask 供给消费 postprocess/temporalReactiveMask.ts binding8+flags.y 历史权重衰减,encodeUpscale 透明 OIT/粒子两路与 encodeFinal 同式透传;Studio 桥 f4-temporal-upscale URL 开关,超分需动态分辨率同开)",
    },
    native: { support: "unavailable", reason: "absent", evidence: "packages/deep-engine-native/src/lib.rs(native 按原生分辨率直出,无上采样通路)" },
  },
  {
    id: "virtual-textures",
    title: "虚拟纹理驻留/采样(F3)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/webgpu/virtualTextureResidency.ts:resolveVirtualTextureResidencyBudget(页表驻留+采样+帧桥,经管线开关接入;PbrRendererOptions.virtualTextures 快照白名单+逐帧反馈→驻留 drive+FrameMetrics 遥测;Studio 桥 f3-virtual-textures URL 开关)",
    },
    native: { support: "unavailable", reason: "absent", evidence: "packages/deep-engine-native/src/lib.rs(无 virtual texture 模块)" },
  },
  {
    id: "cluster-lod",
    title: "微多边形簇 LOD + 软光栅后备(G1)",
    webFeatureKeys: ["softRasterizeFallback"],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/webgpu/clusterLodIndirectExecutor.ts:ClusterLodIndirectPlan(indirect 簇绘制;softRasterizeFallback 超误差微三角软光栅,均 opt-in;G1 Studio 桥接线:buildClusterLodAuthorStaging author staging+bake 随包下发,g1ClusterLodEnabled URL 开关传递 clusterLodStaging)",
    },
    native: {
      support: "unavailable", reason: "absent",
      evidence: "packages/deep-engine-native/src/gpu_lod.rs:GpuLod(传统 mesh/实例 LOD,非 meshlet 簇 LOD;无软光栅后备)",
    },
  },
  {
    id: "white-furnace-conservation",
    title: "白炉能量守恒验收(C12)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "harness-only",
      evidence: "packages/deep-engine/src/webgpu/whiteFurnace.ts:FURNACE_TOLERANCES(纯 CPU 参考白炉+相对误差/通道增益/SSR 净零断言)",
    },
    native: {
      support: "supported", reason: "harness-only",
      evidence: "packages/deep-engine-native/src/white_furnace.rs:evaluate_furnace_checks(CPU 判据/容差逐式移植 TS FURNACE_TOLERANCES 且字面量测试锁定;renderer/white_furnace_gpu_tests.rs 球腿+墙腿真机 GPU 门;背景腿为 clear 色链宿主差异、SSR toggle 判据属 web SSR 合成链不在移植面,均如实声明)",
    },
  },
  {
    id: "device-recovery",
    title: "GPU 设备丢失分型与会话内恢复(C13)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/deviceRecovery.ts:classifyDeviceLost(device-lost|uncaptured|recovery 错误码分型 + healthy/degraded/recovering/lost 显式状态机 + 次数预算/指数退避;deviceSession.recovery 会话内重建设备)",
    },
    native: {
      support: "degraded", reason: "reduced-tier",
      evidence: "packages/deep-engine-native/src/app/recovery.rs:handle(DeviceLost→整渲染器重建;UncapturedError→failed+手动 R 重建;无错误分型词汇/恢复阶段机/次数预算)",
    },
  },
  {
    id: "ssr",
    title: "屏幕空间反射(C11 物理化)",
    webFeatureKeys: ["screenSpaceReflection"],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:screenSpaceReflection(E04 opt-in;screen-space-reflection-trace/composite 计时 pass)",
    },
    native: { support: "unavailable", reason: "absent", evidence: "packages/deep-engine-native/src/lib.rs(无 SSR 模块)" },
  },
  {
    id: "fog-volumetric",
    title: "雾(Web 体积雾 march / native 屏幕空间近似)",
    webFeatureKeys: ["fog", "volumetricFog"],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:volumetricFog(G7 半分辨率参与介质 march+HDR 合成 opt-in;表面雾默认开,volumetricFog 开启时替换)",
    },
    native: {
      support: "degraded", reason: "reduced-tier",
      evidence: "packages/deep-engine-native/src/fog.rs:FogSettings.volumetric(受预算约束的屏幕空间固定步线性深度积分,非 froxel/体积光照管线)",
    },
  },
  {
    id: "taa",
    title: "时域抗锯齿(TAA)",
    webFeatureKeys: ["temporalAa"],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:temporalAa(默认开;temporal-aa 计时 pass,时域历史链)",
    },
    native: { support: "unavailable", reason: "absent", evidence: "packages/deep-engine-native/src/lib.rs(native 直出通路无时域历史/TAA)" },
  },
  {
    id: "ambient-occlusion",
    title: "屏幕空间环境光遮蔽",
    webFeatureKeys: ["ambientOcclusion"],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:ambientOcclusion(默认开;ambient-occlusion/apply-ambient-occlusion 计时 pass)",
    },
    native: { support: "unavailable", reason: "absent", evidence: "packages/deep-engine-native/src/lib.rs(无 SSAO/AO 通路)" },
  },
  {
    id: "bloom",
    title: "Bloom 辉光",
    webFeatureKeys: ["bloom"],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:bloom(默认开;bloom 计时 pass)",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/bloom_pipeline.rs:BloomPass(bloom/bloom_pass/bloom_pipeline 三模块;quality_profile.rs 对 Bloom 施加确定性预算)",
    },
  },
  {
    id: "tonemap-display",
    title: "色调映射与显示变换(ACES)",
    webFeatureKeys: ["toneMapping"],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:toneMapping(deep-aces 默认 | three-aces-r185)",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/runtime_package/solid_environment.rs:output-transform(native-aces-v1 / native-aces-light-v2;author_grading.rs 在 ACES 前 HDR 线性域逐式应用六通道)",
    },
    sharedQualityVocabulary: true,
  },
  {
    id: "author-grading-vignette",
    title: "作者色彩分级与暗角",
    webFeatureKeys: ["vignette"],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:vignette(默认开;pbrAuthorColorEffects 六通道 hue/saturation/brightness/contrast/temperature/tint)",
    },
    native: {
      support: "degraded", reason: "reduced-tier",
      evidence: "packages/deep-engine-native/src/author_grading.rs:switches(vignette 槽位保留、本切片恒未启用;六通道分级已与 Web 逐位镜像)",
    },
  },
  {
    id: "ground-preview",
    title: "内置地面/网格预览",
    webFeatureKeys: ["groundPlane", "groundGrid"],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:groundPlane/groundGrid(默认开;作者场景接管地板时关闭)",
    },
    native: {
      support: "unavailable", reason: "absent",
      evidence: "packages/deep-engine-native/src/runtime_package/solid_environment.rs(solid-background-no-ibl/prefiltered-ibl 仅背景底,无内置地面/网格)",
    },
  },
  {
    id: "ibl-environment",
    title: "IBL 环境光照",
    webFeatureKeys: ["environment"],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:environment(默认开;environmentShader/pbrDiffuseIrradiance 漫反射 irradiance 卷积+预滤波镜面)",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/renderer/mod.rs:ibl(GpuIblEnvironment;gpu_ibl.rs+ibl.rs)",
    },
  },
  {
    id: "texture-arrays",
    title: "材质纹理数组化(bindless 级 1)",
    webFeatureKeys: ["textureArrays"],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:textureArrays(波次5 opt-in;textureArrayMaterialTable/ProductionGate/共享表行 224B=192B 材质+32B 索引)",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/texture_array_bindings.rs:MATERIAL_UNIFORM_BINDING(=10;texture_array_packing.rs 打包与 Web 同源)",
    },
  },
  {
    id: "visibility-buffer",
    title: "可见性缓冲(P0-2)",
    webFeatureKeys: ["visibilityBuffer"],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:visibilityBuffer(static opaque meshlet 批;visibilityBufferPass/Encoding/Resolve,opt-in 保持 forward 逐字节不变)",
    },
    native: { support: "unavailable", reason: "absent", evidence: "packages/deep-engine-native/src/lib.rs(无 visibility buffer 通路)" },
  },
  {
    id: "occlusion-culling",
    title: "视锥/遮挡剔除",
    webFeatureKeys: ["occlusionCulling"],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:occlusionCulling(默认开;gpuFrustumCulling GPU 剔除通路)",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/gpu_culling.rs:GpuCulling(gpu_occlusion*.rs+renderer/hi_z_pyramid.rs R4 主视锥 HiZ,opt-in 开关)",
    },
  },
  {
    id: "gpu-lod",
    title: "GPU 驱动 LOD 选择",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/gpuLodSelector.ts:GPU LOD 选择(gpuLodPacking/gpuLodWgsl 同一选择核)",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/renderer/mod.rs:lod(GpuLod;lod_contract.rs 与 Web 合同同源)",
    },
  },
  {
    id: "shadow-cascades",
    title: "级联阴影(CSM)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/shadows/cascadedShadowPlanner.ts:cascadedShadowPlanner(cascadedShadowShader/资源规划默认通路)",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/cascaded_shadow.rs:cascaded_shadow(cascaded_shadow_math.rs;renderer shadow_map.rs CascadedShadowGpuMetrics)",
    },
  },
  {
    id: "shadow-local",
    title: "局部光阴影(聚光/点光)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/shadows/localSpotShadowShader.ts:localSpotShadowShader(F7b spot uniform ABI 16 条目×96B=1536B;localSpotShadowAtlasQuality multi-light 档 16 灯可达;localShadowSoftness 软阴影核)",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/local_shadow.rs:local_shadow(16 spot entries/16-view frame ABI; point light consumes six faces;local_lighting + clustered_lighting 共用)",
    },
  },
  {
    id: "weighted-oit",
    title: "加权有序无关透明(OIT)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/weightedOit.ts:weightedOit(transparent-oit/composite-oit 计时 pass;weightedOitBlendSemantics)",
    },
    native: { support: "unavailable", reason: "absent", evidence: "packages/deep-engine-native/src/lib.rs(无 OIT 模块)" },
  },
  {
    id: "spatial-aa",
    title: "空间域边缘 AA",
    webFeatureKeys: ["spatialAa"],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/spatialAaPresent.ts:spatialAaPresent(显示域边缘 AA,独立于时域历史,默认开)",
    },
    native: { support: "unavailable", reason: "absent", evidence: "packages/deep-engine-native/src/lib.rs(无 FXAA/空间 AA 后处理)" },
  },
  {
    id: "hardware-ray-query",
    title: "硬件光线查询(RT)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/rayTracing/probeRadianceKernel.ts:PROBE_RADIANCE_MAX_DIRECTIONS(硬件 ray query 采集核;适配器 tier 探测见 apps rendererCapabilities)",
    },
    native: {
      support: "unavailable", reason: "api-missing",
      evidence: "packages/deep-engine-native/src/host_capabilities/rt_probe.rs:probe_adapter(wgpu 30 无 RT 特性→Unsupported/BackendLacksRtApi;rt_residency.rs 仅驻留+绑定,不做像素消费)",
    },
  },
  {
    id: "ies-lighting",
    title: "IES 光域网配光(E02)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/lighting/iesSampling.ts:iesSampling(iesProfile 表;E02 16 行参数+361 列归一化表)",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/ies_shading.rs:IES 资源打包(字节布局镜像 WebGPU E02 表)",
    },
  },
  {
    id: "material-clearcoat",
    title: "清漆层与扩展材质带(C9)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/shader/materialParameters.ts:MATERIAL_PARAMETER_KEYS(扩展带 ior/clearcoat/各向异性/透射 6 参数;factor=0 即 KHR_materials_clearcoat 默认无层,缺省零行为=stock PBR;materialBindings.ts MATERIAL_PARAMETER_EXTENDED_BAND_FLOAT_OFFSET=40 六 float 槽 40..46,materialEvaluateWgsl.ts 清漆层叠着色路径+白炉真机守恒 gate)",
    },
    native: {
      support: "unavailable", reason: "absent",
      evidence: "packages/deep-engine-native/src/mesh_abi.rs:MATERIAL_UNIFORM_FLOATS(=40 核心块;native 不消费 Web 扩展带 40..46,无清漆层叠着色路径)",
    },
  },
  {
    id: "local-shadow-abi-16",
    title: "局部阴影 16 灯 ABI 扩容(F7b,点光 6-face 计入 view 预算)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/shadows/localSpotShadowShader.ts:LOCAL_SPOT_SHADOW_MAX_LIGHTS(16 条目×96B=1536B;localSpotShadowRuntime.ts 16 灯帧装配;localSpotShadowAtlasQuality.ts standard|multi-light 两档,multi-light 产品档 16 灯放行)",
    },
    native: {
      support: "degraded", reason: "reduced-tier",
      evidence: "packages/deep-engine-native/src/mesh_abi.rs:FRAME_ABI_ID(deep.native.frame.v8:16 local lights+16 shadow views+16 softness=2384B)+local_shadow.rs MAX_SPOT_SHADOWS=16(点光≤1×6 face 计入 16 view 预算;frame v8 与 TS 侧布局未做跨端逐字节对齐验证,如实降档)",
    },
  },
  {
    id: "device-recovery-bridge",
    title: "设备恢复宿主桥消费(C13 消费接线)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "apps/web/src/viewer/StudioDeepWebGpuBridge.ts:onFatalLoss/onDeviceRecreated(可恢复型 epoch 重建后清同步态重放渲染不整页回退,终态单次交接 WebGL;recovery opt-in 缺省零行为;DeepWebGpuBackend.ts hooks 暴露+deepWebGpuOptions.ts recovery 对象校验+cb44f6ad 桥接行为测试)",
    },
    native: {
      support: "unavailable", reason: "host-specific",
      evidence: "packages/deep-engine-native/src/app/recovery.rs(native 宿主自身的恢复消费已在 device-recovery 行登记;Studio WebGPU 桥消费策略按设计属 web 宿主专属)",
    },
  },
] as const);

/** 能力 id 单源冻结数组(结构先例:pbrTimedPassIds.PBR_TIMED_PASS_IDS)。 */
export const RENDERER_CAPABILITY_IDS = Object.freeze(
  RENDERER_CAPABILITY_MANIFEST.map((entry) => entry.id),
);

/** 按 id 取登记行;未知 id 返回 undefined(调用方必须显式处理,不得静默)。 */
export function findRendererCapabilityEntry(id: string): RendererCapabilityManifestEntry | undefined {
  return RENDERER_CAPABILITY_MANIFEST.find((entry) => entry.id === id);
}

/** 覆盖率缺口结构:每类缺口列出能力 id 与说明。 */
export interface RendererCapabilityCoverageReport {
  readonly missingWeb: readonly string[];
  readonly missingNative: readonly string[];
  readonly invalidDeclarations: readonly string[];
  readonly duplicateIds: readonly string[];
}

/**
 * 清单结构校验:双端声明齐全 + 词汇合法 + id 唯一。
 * 返回空缺口 = 清单自洽;任何非空缺口都应让覆盖率测试红。
 */
export function rendererCapabilityCoverageReport(
  entries: readonly RendererCapabilityManifestEntry[] = RENDERER_CAPABILITY_MANIFEST,
): RendererCapabilityCoverageReport {
  const missingWeb: string[] = [];
  const missingNative: string[] = [];
  const invalidDeclarations: string[] = [];
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) duplicateIds.push(entry.id);
    seen.add(entry.id);
    if (!entry.web) missingWeb.push(entry.id);
    if (!entry.native) missingNative.push(entry.id);
    if (entry.web) invalidDeclarations.push(...rendererCapabilityDeclarationIssues(entry.web, "web", entry.id));
    if (entry.native) invalidDeclarations.push(...rendererCapabilityDeclarationIssues(entry.native, "native", entry.id));
  }
  return Object.freeze({
    missingWeb: Object.freeze(missingWeb),
    missingNative: Object.freeze(missingNative),
    invalidDeclarations: Object.freeze(invalidDeclarations),
    duplicateIds: Object.freeze(duplicateIds),
  });
}

/** 金样 JSON(提交于 fixtures/renderer-capability-manifest.json,native 端 include_str! 消费)。 */
export function rendererCapabilityManifestJson(): string {
  return JSON.stringify({
    contractVersion: RENDERER_CAPABILITY_CONTRACT_VERSION,
    entries: RENDERER_CAPABILITY_MANIFEST,
  }, null, 2) + "\n";
}
