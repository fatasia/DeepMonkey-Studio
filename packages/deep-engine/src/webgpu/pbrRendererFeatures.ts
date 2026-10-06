export type PbrToneMapping = "deep-aces" | "three-aces-r185";

export interface PbrRendererFeatureOptions {
  readonly environment?: boolean;
  readonly fog?: boolean;
  /** Built-in solid preview ground; disable when the author scene owns its floor. */
  readonly groundPlane?: boolean;
  readonly groundGrid?: boolean;
  readonly ambientOcclusion?: boolean;
  /** E04 first slice: screen-space reflection trace+composite ahead of temporal AA; off by default. */
  readonly screenSpaceReflection?: boolean;
  /** G7 half-resolution participating medium march + HDR composite; opt-in to preserve existing visuals. */
  readonly volumetricFog?: boolean;
  readonly temporalAa?: boolean;
  /** Display-domain edge AA, independent of temporal history. */
  readonly spatialAa?: boolean;
  /** P0-2 visibility-buffer slice for static opaque meshlet batches; off keeps the forward path byte-identical. */
  readonly visibilityBuffer?: boolean;
  /** 追平-Nanite 后备：超误差 cluster 微三角软光栅写可见性三缓冲；仅 visibilityBuffer 开启时生效。 */
  readonly softRasterizeFallback?: boolean;
  /** 波次5 bindless 级 1：材质纹理 texture_2d_array 数组化；off 保持常规 per-material bind group。 */
  readonly textureArrays?: boolean;
  readonly layeredMaterials?: boolean;
  readonly occlusionCulling?: boolean;
  /** C10 屏幕空间接触阴影;opt-in,Z 默认档不带(质量档位见 shadows/contactShadowQuality)。 */
  readonly contactShadows?: boolean;
  /**
   * F4 时域上采样(opt-in,默认关闭):动态分辨率降档时低分辨率主帧经 Catmull-Rom+
   * 时域重投影核重建为全分辨率输出,替代 surface 直缩+浏览器拉伸。需要
   * resolutionScalePolicy 同时开启;scale=1 时零介入逐字节直通。
   */
  readonly temporalUpscale?: boolean;
  readonly bloom?: boolean;
  readonly vignette?: boolean;
  readonly toneMapping?: PbrToneMapping;
  /**
   * 排查对照开关:时域 pass(TAA/TSR)结构照常运行,但历史每帧强制失效,
   * 输出退化为纯当前帧结果——用于二分"伪影来自时域复用还是上游 pass"。
   * 不改变 pass 拓扑与带宽,关闭后逐字节回到常规路径。
   */
  readonly debugForceFullRender?: boolean;
  /**
   * 方向光 RT 阴影(opt-in,默认关):主帧 depth 重建着色点沿光源方向发射
   * 两级 BVH 遮挡射线,写 r32float mask 纹理供直接光采样,替代/混合级联阴影。
   * 需调用方提供 TlasPackedScene;关闭时渲染管线零变化。
   */
  readonly rayTracedShadows?: boolean;
  /**
   * Brief-GI M2 生产 SDF GI(opt-in,默认关):场景 SDF 烘焙 + 天光遮蔽圆锥追踪 +
   * 探针 SH 更新的帧循环 dispatch。关闭时运行时不构建,既有帧逐位零变化。
   */
  readonly sdfGi?: boolean;
  /**
   * B2 MegaLights M2 万灯直接光 RIS(opt-in,默认关):本地灯超簇光预算(64)或
   * 显式强制时,帧内表面重建 + RIS 两趟 + 加性合成进 HDR;预算内仍走既有簇光
   * 快路径(逐位既有路径)。关闭时控制器不构建,帧逐位零变化。
   */
  readonly megaLights?: boolean;
  /**
   * B3 RT 反射 closest-hit 帧通道(opt-in,默认关):主帧 depth 重建着色点沿镜面
   * 反射方向发射两级 BVH closest-hit,rgba32float 命中记录写入瞬态纹理。帧编排内
   * 懒构造,场景复用 RT 阴影 staging 通道(rtShadows.packedScene);关闭时运行时
   * 不构建,既有帧逐位零变化。命中记录的生产消费(SSR 屏外合成/环境采样族)属
   * 下一切片——开启本键当前只挂载管线与帧计时,不改变画面。
   */
  readonly rayTracedReflections?: boolean;
  /**
   * P2 六引擎对标 SSGI(opt-in,默认关):屏空间漫射一次反弹后链加性层(半分辨率
   * 余弦半球采样 + 全分辨率加性合成,输出在 SSR/TAA 前,TAA 顺带做时域平滑)。
   * 与 probe/sdf GI 分工见 screenSpaceGiTypes.ts 裁决:探针 ambient(shader 内)
   * + SSGI 反弹(post 链)叠加无双计。关闭时运行时不构建,既有帧逐位零变化。
   */
  readonly ssgi?: boolean;
  /**
   * P2 六引擎对标 three r186 ProjectorLight 投影纹理(gobo 纹理半部;opt-in,默认关):
   * 单投影器(位置/目标/FOV/强度/贴图)视锥纹理直接光后链加性层,输出插在 SSGI 之后、
   * SSR 之前——SSR composite 在命中 UV 采色即携带投影贡献(反射链路命中点的投影纹理
   * 贡献,projectedTextureChain 测试钉死)。场景未供给投影器时帧逐位零变化;关闭时
   * 运行时不构建。
   */
  readonly projectedTextures?: boolean;
}

export interface PbrRendererFeatures {
  readonly environment: boolean;
  readonly fog: boolean;
  readonly groundPlane: boolean;
  readonly groundGrid: boolean;
  readonly ambientOcclusion: boolean;
  readonly screenSpaceReflection: boolean;
  readonly volumetricFog: boolean;
  readonly temporalAa: boolean;
  readonly spatialAa: boolean;
  readonly visibilityBuffer: boolean;
  readonly softRasterizeFallback: boolean;
  readonly textureArrays: boolean;
  readonly layeredMaterials: boolean;
  readonly occlusionCulling: boolean;
  readonly contactShadows: boolean;
  readonly temporalUpscale: boolean;
  readonly bloom: boolean;
  readonly vignette: boolean;
  readonly toneMapping: PbrToneMapping;
  readonly debugForceFullRender: boolean;
  readonly rayTracedShadows: boolean;
  readonly sdfGi: boolean;
  readonly megaLights: boolean;
  readonly rayTracedReflections: boolean;
  readonly ssgi: boolean;
  readonly projectedTextures: boolean;
}

export const DEFAULT_PBR_RENDERER_FEATURES: PbrRendererFeatures = Object.freeze({
  environment: true, fog: true, groundPlane: true, groundGrid: true, ambientOcclusion: true,
  screenSpaceReflection: false, volumetricFog: false, temporalAa: true, spatialAa: true, visibilityBuffer: false,
  softRasterizeFallback: false,
  textureArrays: false,
  layeredMaterials: false,
  occlusionCulling: true, bloom: true, vignette: true, contactShadows: true, temporalUpscale: false, toneMapping: "three-aces-r185",
  debugForceFullRender: false,
  rayTracedShadows: false,
  sdfGi: false,
  megaLights: false,
  rayTracedReflections: false,
  ssgi: false,
  projectedTextures: false,
});

export function resolvePbrRendererFeatures(options: PbrRendererFeatureOptions = {}): PbrRendererFeatures {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("PBR renderer features must be an object.");
  }
  const boolean = (key: keyof Omit<PbrRendererFeatures, "toneMapping">): boolean => {
    const value = options[key];
    if (value !== undefined && typeof value !== "boolean") throw new TypeError(`PBR feature ${key} must be boolean.`);
    return value ?? DEFAULT_PBR_RENDERER_FEATURES[key];
  };
  const toneMapping = options.toneMapping ?? DEFAULT_PBR_RENDERER_FEATURES.toneMapping;
  if (toneMapping !== "deep-aces" && toneMapping !== "three-aces-r185") throw new RangeError("Unknown PBR tone mapping.");
  const volumetricFog = boolean("volumetricFog");
  // Participating-medium composition replaces the legacy surface fog unless the caller explicitly layers both.
  const fog = options.fog === undefined && volumetricFog ? false : boolean("fog");
  return Object.freeze({ environment: boolean("environment"), fog,
    groundPlane: boolean("groundPlane"),
    groundGrid: boolean("groundGrid"), ambientOcclusion: boolean("ambientOcclusion"),
    screenSpaceReflection: boolean("screenSpaceReflection"),
    volumetricFog,
    temporalAa: boolean("temporalAa"), spatialAa: boolean("spatialAa"), visibilityBuffer: boolean("visibilityBuffer"),
    softRasterizeFallback: boolean("softRasterizeFallback"),
    textureArrays: boolean("textureArrays"),
    layeredMaterials: boolean("layeredMaterials"),
    occlusionCulling: boolean("occlusionCulling"),
    contactShadows: boolean("contactShadows"),
    temporalUpscale: boolean("temporalUpscale"),
    bloom: boolean("bloom"), vignette: boolean("vignette"), toneMapping,
    debugForceFullRender: boolean("debugForceFullRender"),
    rayTracedShadows: boolean("rayTracedShadows"),
    sdfGi: boolean("sdfGi"),
    megaLights: boolean("megaLights"),
    rayTracedReflections: boolean("rayTracedReflections"),
    ssgi: boolean("ssgi"),
    projectedTextures: boolean("projectedTextures") });
}
