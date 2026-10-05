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
      evidence: "packages/deep-engine/src/lighting/probeRadianceDirectionGate.ts:DEEP_GI_PROBE_DIRECTIONS_STANDARD/HIGH(16/32;内核容量 32;生产默认 32) + F5 方案A:96B record words[12..23]=RGB L1 SH 方向可见度(probeDirectionalVisibilitySh.ts CPU 参考,channel-major l0/l1m-1/l1m0/l1m1;捕获核 moments lane1..3;镜面消费 deepGiSpecularDirectionalVisibility=clamp(luma(SH重建(reflection))/luma(env),0,1),SH缺失探针标量门fallback;白炉均匀场dipole精确零gate≡1逐位负控;合同 docs/specs/f5-directional-l1-implementation-20261003.md)",
    },
    native: {
      support: "degraded", reason: "reduced-tier",
      evidence: "packages/deep-engine-native/src/renderer/native_gi_producer.rs:produce_direct_irradiance(确定性直光种子 producer + probe_gi_abi.rs 96B 布局合同;无 32 方向辐射内核/clipmap 采样通路) + probe_gi_abi.rs reserved[12] 声明升级为 words[12..23]=RGB L1 SH 方向可见度(与 Web 同形;native producer 仍发全零 reserved=SH缺失语义,消费端按同族标量 fallback,启用消费走 cargo 线)",
    },
    sharedQualityVocabulary: true,
  },
  {
    id: "sdf-gi",
    title: "静态 SDF 遮蔽 + 探针混合 GI M3 探针消费 + GPU 烘焙(Brief-GI)",
    webFeatureKeys: ["sdfGi"],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:sdfGi(默认 false,opt-in;关闭 = 运行时不构建,既有帧逐位零变化) + gi/sdfSceneBake.ts:bakeSdfSceneGrid(CPU 增量烘焙,保留为回退与验收参考) + gi/sdfSceneBakeGpu.ts + wgsl/sdfBakeSceneGrid.wgsl(M3 GPU compute 距离场:每 lane=场景 cell 点到三角形精确距离 min + +X 射线奇偶定号,CPU 同式;实例烘焙域逐三角形携带 round 舍入界;距离场 storage buffer 直供天光追踪零拷贝;真机 60,192 cells 稳态烘焙帧墙钟 4.4ms vs CPU 584.8ms,距离抽样 mean 误差 1.6e-4/max 0.15(一格距,域界 round 差异)/符号翻转 0.28%(退化射线,无排序去重,如实) + gi/sdfGiSkyVisibility 同 M2 天光圆锥追踪 + wgsl/sdfGiProbeUpdate.wgsl 同 M2 探针 SH 更新(96B ABI,F5 words[12..23] 绝不写) + gi/sdfGiPublish.ts + wgsl/sdfGiPublish.wgsl(M3 探针消费物化核:每帧 update 窗口后把探针场物化为主 pass 探针 clipmap 采样纹理(volume=rgba16float[dx,dy,dz] texel=record vec4[0];moments=rgba32float[dx,dy,dz×4] lane0=vec4[1].xyz+valid,lane1..3 恒零=SH 缺失;metadata=packProbeLevels 单层),pbrRendererFrames 同步 setProbeClipmap 发布 + F1 clipmap 停驱——pbrShader ambient 项 mix(environmentIrradiance,gi.rgb,gi.a) 真实消费探针记录;真机对拍 volume texel vs CPU 记录镜像零失配(f16 量化内 max 6.1e-5)、moments lane0 逐位零失配;像素验收开启后 changedCount=6100>0(变化区空间集中,质心画面内,中心行采样 0.08→0.02 门内暗化可见);M3 仍 degraded 子项如实:变化区为探针域内子域而非全场景(分区 darkened 计数未命中,候选根因 realMoments 判据/Chebyshev 权重域,见 docs/handoffs/gi-depth-handoff.md),逐 pass 计时登记(PBR_TIMED_PASS_IDS 原子 diff)仍暂存,SSGDI 动态直接层 GPU 核不消费(CPU 域保留) + gi/sdfGiDayNight.ts 昼夜 harness(逐帧 p99≤3/255)",
    },
    native: {
      support: "unavailable", reason: "absent",
      evidence: "packages/deep-engine-native/src/lib.rs(无场景 SDF 烘焙/圆锥追踪/探针 SH 更新通路;probe_gi_abi.rs 仅 96B 布局合同+直光种子 producer)",
    },
    sharedQualityVocabulary: true,
  },
  {
    id: "contact-shadows",
    title: "屏幕空间接触阴影(C10)",
    webFeatureKeys: ["contactShadows"],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:contactShadows(默认 true,Z2/Z3.5 质感默认;shadows/contactShadowQuality.ts 三档质量档)",
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
    native: {
      // 视觉三件套批(2026-10-06):CPU 仲裁实现入库(TS f64 golden 对拍);
      // 曝光消费接线属后继切片——如实 harness-only。
      support: "supported", reason: "harness-only",
      evidence: "packages/deep-engine-native/src/postprocess/auto_exposure.rs:estimate_luminance_from_equirect/from_prefiltered_mip(等距柱纬度加权/IBL 最粗 mip 立体角加权)+ target_exposure_from_luminance(±EV 包络)+ PbrAutoExposureRuntime(EV 平滑+率硬顶,fail-closed)",
    },
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
    id: "debug-full-render",
    title: "全量渲染对照开关(排查工具)",
    webFeatureKeys: ["debugForceFullRender"],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/webgpu/pbrPostProcessChain.ts:encodeFinal/encodeUpscale(debugForceFullRender 时 TAA/TSR 每帧 reset 历史,pass 结构不变;Studio 桥 debug-full-render URL 开关,studioDeepWebGpuBridgeFeatureToggles.debugFullRenderEnabled)",
    },
    native: { support: "unavailable", reason: "absent", evidence: "packages/deep-engine-native/src/lib.rs(排查开关仅 web 链路)" },
  },
  {
    id: "ray-traced-shadows",
    title: "方向光 RT 阴影(帧内联 BVH)",
    webFeatureKeys: ["rayTracedShadows"],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/rayTracing/shadowRayFrameKernel.ts(两级 TLAS→BLAS 遮挡射线核,GBuffer depth 重建着色点,r32float mask 供直接光采样;场景缓冲持久+增量 TLAS;无 readback;需调用方供给 TlasPackedScene;帧资源管理另见同目录 shadowRayFramePass.ts)",
    },
    native: {
      // F2 登记修正(2026-10-06):native 实际有硬件 RT 方向阴影管线族
      // (commit 227958ca 早于基线),按真实状态重登记,不虚报 full。
      support: "degraded", reason: "reduced-tier",
      evidence: "packages/deep-engine-native/src/pipeline/rt.rs:RtMeshPipelines(F2 RT fragment 方向阴影 Ray Query 管线族:仅静态 opaque/MASK 批次,BLEND 族不在 TLAS 驻留;失败 error-scope fail-closed 回退栅格;renderer/rt_residency.rs 驻留+pixel_pipelines 生产消费;renderer/rt_pixel_gpu_tests.rs、rt_raster_parity_gpu_tests.rs 真机 GPU 门;与 web compute BVH 全帧档为不同实现档)",
    },
  },
  {
    // B3 光追双通道·reflection 二通道(2026-10-06 生产帧挂载):PbrRendererFeatures
    // rayTracedReflections 键 + pbrRendererFrames 帧内懒构造(场景复用 RT 阴影 staging
    // 通道)+ FrameMetrics.rtReflections 披露。如实登记:命中记录的生产消费(SSR 屏外
    // 合成/环境采样族)未接线——当前开关只挂载管线与 dispatch,画面零变化;URL 开关
    // (ray-traced-reflections=1)待桥 features 字面量单行接线(桥文件本批禁碰);
    // 真机对拍门 scripts/reflectionRayGpuTest.mjs PASSED(test-output/reflection-ray-gpu-*)。
    id: "ray-traced-reflections",
    title: "反射 closest-hit 帧通道(帧内联 BVH;B3 光追双通道)",
    webFeatureKeys: ["rayTracedReflections"],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/rayTracing/rayTraceClosestFrameKernel.ts(depth 重建着色点+深度差分法线,沿镜面反射方向两级 TLAS→BLAS closest-hit,rgba32float [t,normal.xyz] 记录,miss=[-1,0,0,0];执行器同目录 rayTraceClosestFramePass.ts 场景五缓冲持久+增量 TLAS+bind LRU;pbrRendererFrames 帧内懒构造+瞬态命中纹理,场景复用 rtShadows.packedScene;真机门 scripts/reflectionRayGpuTest.mjs)",
    },
    native: { support: "unavailable", reason: "absent", evidence: "packages/deep-engine-native/src/lib.rs(native 无 compute BVH 反射通道;与 ray-traced-shadows 同口径)" },
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
      evidence: "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts:toneMapping(three-aces-r185 默认 | deep-aces 显式可选)",
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
      // 渐晕启用批(2026-10-06):vignette 槽位接活——wire 可选 vignetteDarkness
      // 双端同合同,WGSL 分支先于分级(TS 同序),随运行包声明 opt-in。
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine-native/src/author_grading.rs:new_with_vignette/apply_at(vignette_darkness ∈ [0,3] fail-fast;CPU 参考与 TS applyPbrAuthorColorEffects f32 容差对拍)+ runtime_package/solid_environment.rs AuthorColorGrading.vignette_darkness 解码 + assets/shaders/native_output_color.wgsl(vignette 分支,四变体调用点传 screen uv)",
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
    title: "主阴影双档:级联 CSM(默认档)+ 三环 clipmap 虚拟阴影(回退可切档)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/src/shadows/cascadedShadowPlanner.ts:cascadedShadowPlanner(cascadedShadowShader/资源规划默认档) + packages/deep-engine/src/shadows/virtualShadowClipmap.ts:planVirtualShadowClipmap(virtual 档:三环 clipmap 虚拟 16384²/页 128²,物化 2048²×4 页池,shadows/virtualShadowPages.ts 投影误差 Top-K+动态页掩码,webgpu/virtualShadowResources.ts 页渲染+页表绑定,webgpu/virtualShadowSampling.ts 着色端页表查询+PCSS+缺页回退上一环;合同 displayContract.shadow.mode,缺字段=级联)",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/cascaded_shadow.rs:cascaded_shadow(cascaded_shadow_math.rs;renderer shadow_map.rs CascadedShadowGpuMetrics;native 直出通路按设计走级联档,虚拟档属 web opt-in)",
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
    native: {
      // 视觉三件套批(2026-10-06):FXAA 逐式移植,真机 GPU 对拍 ≤2/255;
      // OutputPass 出片链接线属后继切片——如实 harness-only。
      support: "supported", reason: "harness-only",
      evidence: "packages/deep-engine-native/src/postprocess/spatial_aa.rs:resolve_spatial_aa_cpu(TS resolveSpatialAaCpu 逐位 golden)+ spatial_aa_shader/create_spatial_aa_pipeline(显示域 unorm 目标,全屏三角)+ tests/spatial_aa_gpu.rs(真机对拍门)",
    },
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
      // F2 登记修正(2026-10-06):wgpu 30 实际暴露 EXPERIMENTAL_RAY_QUERY
      // 且 native 有像素消费管线族,原 api-missing 前提不成立。
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine-native/src/gpu_context.rs:EXPERIMENTAL_RAY_QUERY(适配器含该特性才请求;不足保留软件 BVH/栅格路径)+ src/pipeline/rt.rs(enable wgpu_ray_query 像素消费管线族,失败 error-scope fail-closed)+ src/hardware_ray_query.rs(ray_query_device_ready 双面合同)+ host_capabilities/rt_probe.rs(实验特性探测矩阵)",
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
    id: "material-layered-304b",
    title: "分层材质 304B 层块(TS packLayeredSurfaceBlock ↔ native pbr_layered.rs 逐字节镜像)",
    // 证据纪律修正(2026-10-06):原证据非 .ts 路径(对拍网红),改指真实实现;
    // layeredMaterials 开关键让位给 material-clearcoat 行,本行是布局 ABI 能力。
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/shader/materialLayeredSurface.ts:packLayeredSurfaceBlock(304B = header 16B + 2×144B 行,16B 对齐 uniform;LAYERED_SURFACE_ABI_VERSION=1 与 native 互钉;活动层清漆复用 T08 核;layered_*_gpu_tests)",
    },
    native: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine-native/src/pbr_layered.rs(LAYERED_SURFACE_BLOCK_BYTES=304 逐字节镜像 TS 布局;求值响应级混合 CPU 参考;layered_*_gpu_tests;pbr_layered_contract_tests)",
    },
  },
  {
    id: "material-clearcoat",
    title: "清漆层与扩展材质带(C9)",
    webFeatureKeys: ["layeredMaterials"],
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
    id: "material-advanced",
    title: "高级材质 sheen / iridescence / 体积透射 / clearcoat IBL(advancedMaterials 变体)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/webgpu/pbrAdvancedMaterialShader.ts:composeAdvancedMaterialSceneShader(PbrRendererOptions.advancedMaterials 缺省 false→场景 WGSL 字节不变;启用后材质 uniform 192→240B,materialAdvancedParameters.ts 12 float 带)+packages/deep-engine/scripts/advancedMaterialGpuTest.mjs(球白炉/解析直射对拍 CPU)+advancedMaterialThreeParityTest.mjs(真 three r185 对拍)+apps/web/src/viewer/StudioDeepWebGpuBridge.ts(场景含激活 lobe 时按需启用,编辑中新激活则受控重建一次)",
    },
    native: {
      support: "unavailable", reason: "absent",
      evidence: "packages/deep-engine/src/runtimePackage/renderPacket.ts:native profile 的 material 可选字段不含 advancedParameters(闭合材质 profile 拒绝)+packages/deep-engine-native/src/mesh_abi.rs:MATERIAL_UNIFORM_FLOATS(=40 核心块,无 advanced 带与 sheen/薄膜/体积着色路径)",
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
  {
    id: "atmosphere-sky",
    title: "物理大气散射天空(Bruneton 类预计算表,opt-in)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/environment/atmosphereSkyGate.ts:resolveAtmosphereSkyMode(fail-closed 门,默认 neutral;atmosphereSky.ts 预计算表采样+equirect 环境图走 radiance-hdr 权威 IBL 链能量链零改动;quality 档映射 atmosphereSkyPresetForQuality)",
    },
    native: {
      support: "unavailable", reason: "absent",
      evidence: "packages/deep-engine-native/src/lib.rs(native 直出光栅化无环境源通路,无大气散射模块;天空源按设计属 web PbrRenderer 的 radiance-hdr/studio 环境)",
    },
  },
  {
    id: "hdr-display-output",
    title: "HDR 显示输出(HDR10/PQ 直出显示链,I-C21,opt-in)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/webgpu/hdrDisplayOutput.ts:resolveHdrDisplayPolicy(检测→策略匹配→canvas rgba16float+extended 配置描述符;fail-closed 原因码封闭集默认关;pbrOutputBindings.applyHdrDisplay HDR present 变体直出+hdr-pipeline-failed 显式回退;pbrHdrDisplayWgsl PQ/HLG/headroom 编码核与 pbrHdrDisplay CPU 镜像同源)",
    },
    native: {
      support: "unavailable", reason: "absent",
      evidence: "packages/deep-engine-native/src/lib.rs(无 HDR 显示输出模块;native 离屏直出经 output-transform ACES SDR,显示 surface 链按设计属 web 宿主)",
    },
  },
  {
    id: "object-outline",
    title: "对象级/选择描边(render packet 实例 outline 位 → 掩码+边缘+合成)",
    webFeatureKeys: [],
    web: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine/lab/instanceOutlineProbe.ts:Deep PbrRenderer 与 three OutlinePass 同布局 GPU 对拍探针(scripts/instanceOutlineProbeServer.mjs;1920x1080 证据 docs/reports/deep-outline-20261003);实现 postprocess/instanceOutline.ts InstanceOutlinePass(无描边实例时不构造,空闲 createAsync 预热)+ webgpu/packetOutline.ts;账本 materialEffectLedger bit 256 对账;独立包实时翻转 DeepWebGpuBackend.setOutlinedModels(仅 updateInstances);测试 instanceOutline.test.ts / instanceOutlinePass.test.ts / DeepWebGpuBackend.outline.test.ts / packetBuffers.test.ts / materialEffectLedger.test.ts;变形(pose)与 meshlet 批次暂不进掩码,FrameMetrics.outline.skippedBatches 上报",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/outline_pass.rs:OutlinePass(native_outline_composite_v1.wgsl 掩码+合成;forward_targets OUTLINE_MASK_FORMAT/OUTLINE_DEPTH_FORMAT;contract/types.rs 实例 outline 字段,与 web 共用 surface flag bit 256)",
    },
  },
  {
    // B2 Brief-Nanite M3(2026-10-04):DAG 页调度 + indirect 按页分组。交付 CPU 侧
    // 完整调度通路(页表/屏幕误差割/驻留预算/绘制集解析/命令打包,单测链路全绿),
    // GPU 上传与 pbrRenderer 主 pass 接线属后续切片——web 如实登记 harness-only
    // (与 sdf-gi/megalights M1 同口径);非 DAG 资产继续走现有 HLOD 通路不受影响。
    id: "virtual-geometry",
    title: "流式虚拟几何(meshlet DAG 页调度 + indirect 按页分组;Nanite 路线)",
    webFeatureKeys: [],
    web: {
      support: "degraded", reason: "harness-only",
      evidence: "packages/deep-engine/src/virtualGeometryDagPages.ts:compileVirtualGeometryDagPages(MeshletDag→调度页表:页=簇,误差/球界/字节成本/父子链接,M2 -1 哨兵孤儿按根处理)+virtualGeometryScheduling.ts(屏幕误差割:投影口径与 spatial/lodValidation 同源,割反链+祖先补给请求,绘制集解析=最细已驻留祖先且回退互斥)+virtualGeometryResidency.ts(VirtualGeometryDagResidency:硬字节预算+祖先链前缀准入+LRU 最久未见驱逐(细层先于粗层)+父页级联驱逐+事务 commit/rollback,冻结相机零抖动)+virtualGeometryIndirect.ts(每驻留绘制页一条 drawIndexedIndirect 5×u32 命令,实例经 instanceCount 合批,draw 数与实例规模解耦);单测链路 DAG→页表→驻留→绘制全绿(virtualGeometryDagPages/Residency/Indirect/DagChain.test.ts)",
    },
    native: {
      support: "unavailable", reason: "absent",
      evidence: "packages/deep-engine-native/src/lib.rs(无 meshlet DAG 页调度/驻留/indirect 分组运行时;Brief-Nanite 离线工具链 geometry_dag 属独立切片)",
    },
    sharedQualityVocabulary: true,
  },
  {
    // B2 Brief-MegaLights M2(2026-10-04):生产 dispatch 接线达成(原 M1 harness-only
    // 升 opt-in-default-off)。features.megaLights 默认关 = 帧控制器不构建,帧逐位
    // 零变化;开启后路径决策单源 resolveDirectLightingPath —— ≤64 本地灯仍走既有
    // 簇光快路径(逐位既有路径),超预算或显式强制才落 帧内表面重建 + RIS 两趟
    // (M1 单源核)+ 加性合成进 HDR(loadOp load,one+one,alpha 逐位不变)。
    // fail-closed:灯数超 MAX_MEGA_LIGHTS(65535)拒绝;生产通路未供给 IES 表时带
    // iesSpotIndex 灯拒绝(不静默错光)。如实 degraded 项:表面法线 depth 差分、
    // 材质中性起步档(GBuffer 消费属 pbrShader 域后续切片);直出 display 快路径
    // 不接(合成语义依赖 HDR 链)。真机帧时门:5000 灯 1080p RIS compute
    // p95≤20ms(lab/megaLightsGpuProbe.ts,headless Chrome WebGPU)。
    id: "megalights",
    title: "万灯直接光 RIS 随机采样(MegaLights;面积光上限 8→64 同批)",
    webFeatureKeys: ["megaLights"],
    web: {
      support: "supported", reason: "opt-in-default-off",
      evidence: "packages/deep-engine/src/lighting/megaLights.ts:MEGA_LIGHT_STRIDE_BYTES(64B/灯 union 灯池;DEEP_AREA_LIGHT_MAX 8→64 同批扩容)+megaLightsRuntime.ts(M1 RIS compute 运行时;M2 加 surfacesBuffer 供给面)+megaLightsFrameController.ts(M2 帧控制器:路径决策+depth 重建表面+RIS dispatch+加性合成;懒构造于 pbrRendererFrames)+megaLightsFrameWgsl.ts(重建/合成宿主私有核)+wgsl/megaLightsRis.wgsl(K=32→M=1 RIS 核,checksum 门);真机证据 packages/deep-engine/lab/megaLightsGpuProbe.ts + scripts/megaLightsGpuTest.mjs",
    },
    native: {
      support: "unavailable", reason: "absent",
      evidence: "packages/deep-engine-native/src/lib.rs(无 MegaLights 模块;native clustered_lighting.rs 为逐灯簇光路径,非 RIS 采样)",
    },
  },
  {
    // deep2D 线刀 1(2026-10-05,ef7d46b7):GPUI 视觉三命令。wire 层 Paint
    // 模型扩展(solid 数组保持 legacy 字节兼容)+ 片段级解析 SDF;CPU 镜像
    // paint_data.rs 与 WGSL 逐式一致,真 GPU readback 对拍内部零分歧。
    // web 端如实 absent:TS 显示列表合同(deep2dDisplayList.ts)的 path fill
    // 仅实心 Deep2dColor,无 gradient/cornerRadius/shadow 字段,TS 端也无
    // deep2d 渲染通路——三命令是 native 渲染域能力。
    id: "deep2d-visual-trio",
    title: "deep2D 视觉三命令:渐变/圆角矩形/箱阴影(GPUI 对齐,解析 SDF)",
    webFeatureKeys: [],
    web: {
      support: "unavailable", reason: "absent",
      evidence: "packages/deep-engine/src/deep2dDisplayList.ts(Deep2dCommand path 变体 fill 仅 Deep2dColor 实心;wire 无 gradient/cornerRadius/shadow 字段;web 无 deep2d 渲染通路)",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/deep2d/command_types.rs(PathCommand.cornerRadius/shadow + Deep2dPaint linear/radial,legacy 实心 wire 逐字节兼容)+ deep2d/paint_data.rs(WGSL 逐式 CPU 镜像:sd_rounded_box/gradient_stops_color/quad_fragment)+ assets/shaders/native_deep2d_v1.wgsl v2(片段级求值)+ src/deep2d_paint_gpu_tests.rs(真 GPU readback 对拍:内部零分歧、通道差 ≤8)",
    },
  },
  {
    // deep2D 线刀 2(2026-10-05,c330c3f7):组件布局引擎。taffy(MIT/Apache
    // 双许可,固定版本+SHA-256)flex solve,零新增 Deep2dCommand 变体——
    // 布局叶结点直接产出 quad/视觉命令喂既有管线。web 端 absent:布局求解
    // 属 native deep2d 引擎缝(app::deep2d_context::layout_content)。
    id: "deep2d-component-layout",
    title: "deep2D 组件布局引擎(taffy flex solve → quad/视觉命令产出)",
    webFeatureKeys: [],
    web: {
      support: "unavailable", reason: "absent",
      evidence: "packages/deep-engine/src/index.ts(无布局 solve 导出;TS 侧无 flex 引擎;组件布局属 native deep2d 域)",
    },
    native: {
      support: "supported", reason: "full",
      // 证据为单文件路径(对拍器要求 .ts/.rs 单文件;目录型证据不合规)。
      evidence: "packages/deep-engine-native/src/deep2d/layout/solve.rs(taffy flex row/column/wrap/justify/align → 每个 leaf 产出 quad 几何喂 runtime_quad,零新增命令变体;tree/style/commands 同目录)+ app::deep2d_context::layout_content 引擎缝接线 + src/deep2d_layout_gpu_tests.rs(圆角卡片+渐变头+图标/文本占位 flex 排布真 GPU 逐像素对拍:内部零分歧)",
    },
  },
  {
    // deep2D 线刀 3(2026-10-05):stencil-then-cover 动态路径实时填充。
    // 分路是纯运行时决策(滑窗变更计数阈值,无用户开关,wire schema 零变化):
    // 静态路径继续 CPU 细分+缓存;动态路径 CPU 只剩展平+fence 发射,填充
    // 三连(clear→cover→fill)在 GPU stencil 上完成。能力定义限定 fill:
    // 动态命令的 stroke 维持 CPU 描边展开(如实);边缘 AA 为硬边(1× 采样,
    // 与既有静态路径管线一致,非本刀扩大面)。CPU oracle
    // (paint_reference dynamic 分支)与 GPU 同语义(半开区间中心采样)。
    // 模板技法:nonzero 前向 IncWrap/背向 DecWrap(朝向约定颠倒只造成全局
    // 符号翻转,≠0 判定不变);evenodd 双向 Invert 翻转 LSB、fill 测
    // LSB==1——双向 Increment 在多重覆盖区(洞正下方 3 次覆盖)奇偶失效,
    // 真机实测 4 像素内部分歧后修正。
    id: "deep2d-dynamic-path-fill",
    title: "deep2D 动态路径 stencil-then-cover 实时填充(滑窗自动分路;fill 域)",
    webFeatureKeys: [],
    web: {
      support: "unavailable", reason: "absent",
      evidence: "packages/deep-engine/src/deep2dDisplayList.ts(wire schema 无动态性标注;静态/动态分路是 native 运行时决策,wire 零变化;web 无 deep2d 渲染通路)",
    },
    native: {
      support: "supported", reason: "full",
      evidence: "packages/deep-engine-native/src/deep2d/painter_dynamic.rs(滑窗 8 帧内 ≥3 次内容变更自动分路;stencil 资格 gate:有 fill/非解析 quad/无多边形剪刀;预算超限回落静态并计数)+ deep2d/painter_cache_prepare.rs(路由记账与缓存共存)+ assets/shaders/native_deep2d_dynamic_cover_v1.wgsl + src/deep2d_dynamic_gpu.rs(clear→cover→fill 三连管线,Stencil8;nonzero 前向增/背向减,evenodd 双向 Invert LSB)+ deep2d/paint_reference.rs(oracle 同语义:fence 边带 winding/parity 中心采样)+ src/deep2d_dynamic_gpu_tests.rs(N 帧序列/fill-rule donut/渐变/scissor 裁剪/静态+动态混帧/composite 层真 GPU 对拍:内部零分歧,逐像素 worst=0)",
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
