import type { AlphaMode } from "../renderPacket.js";
export { authoredShadowPipelines } from "./authoredShadowPipelines.js";
import { sceneShader, sceneShaderRayTracedShadows, sceneShaderVirtualShadows,
  sceneShaderVirtualShadowsRayTracedShadows, outputShader } from "./pbrShader.js";
import { deformedSceneShader, deformedSceneShaderRayTracedShadows,
  deformedSceneShaderVirtualShadows, deformedSceneShaderVirtualShadowsRayTracedShadows } from "./pbrDeformationShader.js";
import type { MaterialLayouts } from "./materialBindings.js";
import { PBR_DEPTH_FORMAT, PBR_HDR_FORMAT, resolvePbrMsaaSampleCount, PBR_OPAQUE_ATTACHMENT_FORMATS } from "./renderTargets.js";
import { weightedOitColorTargets } from "./weightedOit.js";
import { CASCADED_SHADOW_UNIFORM_BYTES } from "../shadows/cascadedShadowShader.js";
import { createPbrOutputShaderProvenance, type PbrOutputShaderProvenance } from "./pbrOutputShaderProvenance.js";
import { composeTextureArraySceneShader } from "./textureArrayWgsl.js";
import { textureArrayMaterialTableLayoutEntries } from "./textureArrayMaterialTable.js";
import { sharedOutputPipeline } from "./pbrOutputPipelineCache.js";
import { pipelineCompileCacheForDevice, renderPipelineFingerprint } from "./pipelineCache.js";
import type { PipelineCompileRecord } from "./pipelineCache.js";
import { PipelineWarmupQueue } from "./pipelineWarmup.js";
import { browserLocalStorage, loadPipelineWarmupPlan, orderDeferredByWarmupPlan,
  persistPipelineWarmupPlanToBrowser, pipelineWarmupEntriesFromLedger } from "./pipelineCachePersistence.js";
import { composeLayeredMaterialSceneShader } from "./pbrLayeredMaterialShader.js";
import { composeAdvancedMaterialSceneShader } from "./pbrAdvancedMaterialShader.js";
import { layeredMaterialLayoutEntries, LAYERED_MATERIAL_REQUIRED_TEXTURES } from "./pbrLayeredMaterialBindings.js";
// J2-B7-migrate：frame 布局常量切换到 schema 单源生成产物（字节门由 pbrFrameUniforms 测试锁）。
import { FRAME_ABI_TS_BYTES, FRAME_ABI_TS_FIELDS, FRAME_ABI_TS_FLOATS } from "../frameAbi/generated/frameLayout.js";

export const PBR_FRAME_UNIFORM_FLOATS = FRAME_ABI_TS_FLOATS;
export const PBR_FRAME_UNIFORM_BYTES = FRAME_ABI_TS_BYTES;
// 手写键名口径保留（currentViewProjection 是 schema core 字段 viewProjection 的 TS 宿主名），
// 数值全部派生自生成清单——schema 改一处，这里自动跟随。
const TS_FIELD_NAME_BY_SCHEMA: Record<string, string> = { viewProjection: "currentViewProjection" };
export const PBR_FRAME_FLOAT_OFFSETS = Object.freeze(Object.fromEntries(
  FRAME_ABI_TS_FIELDS.map((field) => [TS_FIELD_NAME_BY_SCHEMA[field.name] ?? field.name, field.offset]),
) as Record<string, number>);
/** Previous per-object model rows consumed by motion-vector PBR variants. */
export const PBR_PREVIOUS_INSTANCE_BUFFER_LAYOUT = Object.freeze({ arrayStride: 48, stepMode: "instance", attributes: [
  { shaderLocation: 13, offset: 0, format: "float32x4" }, { shaderLocation: 14, offset: 16, format: "float32x4" },
  { shaderLocation: 15, offset: 32, format: "float32x4" },
] } as const satisfies GPUVertexBufferLayout);

export interface Pipelines {
  /** 地面使用的 plain/opaque/ccw 管线。 */
  readonly main: GPURenderPipeline;
  readonly displayMain?: GPURenderPipeline;
  /** solid/opaque/ccw 阴影管线。 */
  readonly shadow: GPURenderPipeline;
  readonly mainPipelines: ReadonlyMap<string, GPURenderPipeline>;
  /** Opaque pipelines that tone-map directly into the presentation surface. */
  readonly displayPipelines: ReadonlyMap<string, GPURenderPipeline>;
  readonly displayDirectionalPipelines: ReadonlyMap<string, GPURenderPipeline>;
  readonly displayDirectionalMain?: GPURenderPipeline;
  readonly shadowPipelines: ReadonlyMap<string, GPURenderPipeline>;
  /** B1 Brief-VSM 虚拟阴影页物化管线(键与 shadowPipelines 同形,片元写 r32float 光深)。 */
  readonly pageShadowPipelines: ReadonlyMap<string, GPURenderPipeline>;
  readonly output: GPURenderPipeline;
  readonly outputShaderProvenance?: PbrOutputShaderProvenance | undefined;
  readonly materialLayout: MaterialLayouts;
  readonly cascadedShadowLayout: GPUBindGroupLayout;
  /** M2 光追阴影:group(2) 追加 binding(3) r32float mask 槽(仅 features.rayTracedShadows
   *  构建档为 true;CascadedShadowResources 据此追加第 4 条 bind group entry 并支持运行时换 view)。 */
  readonly rayTracedShadowMaskBinding: boolean;
  readonly deformationPlainLayout?: GPUBindGroupLayout;
  /** Conventional D2 variant used by materials that cannot enter an array. */
  readonly textureArrayFallback?: Pipelines;
}

export type MainMaterialMode = "plain" | "material" | "normal";
export type RasterMode = "ccw" | "cw" | "double";
export type ShadowMode = "solid" | "maskPlain" | "maskMaterial";

export function rasterMode(mirrored: boolean, doubleSided: boolean): RasterMode {
  return doubleSided ? "double" : mirrored ? "cw" : "ccw";
}
export function mainPipelineKey(mode: MainMaterialMode, transparent: boolean, raster: RasterMode, alphaToCoverage = false): string {
  // AA-M2:a2c 条件后缀 —— 非 a2c key 字节不变(管线缓存/预热计划稳定);a2c 变体
  // 仅在 MSAA≥4 主 pass 档存在(见 createPipelinesBuild),1x 集合查 a2c key 即 miss。
  return `${mode}/${transparent ? "blend" : "depth"}/${raster}${alphaToCoverage ? "/a2c" : ""}`;
}
export function shadowPipelineKey(mode: ShadowMode, raster: RasterMode): string { return `${mode}/${raster}`; }

const buffers: GPUVertexBufferLayout[] = [
  { arrayStride: 40, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" },
    { shaderLocation: 10, offset: 24, format: "float32x4" }] },
  { arrayStride: 144, stepMode: "instance", attributes: [
    ...Array.from({ length: 8 }, (_, i) => ({ shaderLocation: i + 2, offset: i * 16, format: "float32x4" as const })),
    { shaderLocation: 12, offset: 128, format: "float32x4" },
  ] },
];
const tangentBuffer: GPUVertexBufferLayout = {
  arrayStride: 16, attributes: [{ shaderLocation: 11, offset: 0, format: "float32x4" }],
};
const shadowBuffers: GPUVertexBufferLayout[] = [
  { arrayStride: 40, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
  { arrayStride: 144, stepMode: "instance", attributes: [0, 1, 2].map(index =>
    ({ shaderLocation: index + 2, offset: index * 16, format: "float32x4" as const })) },
];
const shadowMaskBuffers: GPUVertexBufferLayout[] = [
  { arrayStride: 40, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 10, offset: 24, format: "float32x4" }] },
  { arrayStride: 144, stepMode: "instance", attributes: [
    ...[0, 1, 2].map(index => ({ shaderLocation: index + 2, offset: index * 16, format: "float32x4" as const })),
    { shaderLocation: 9, offset: 112, format: "float32x4" }, { shaderLocation: 12, offset: 128, format: "float32x4" }] },
];

export interface PipelinesBuildOptions {
  readonly deformation?: boolean;
  readonly textureArrays?: boolean;
  readonly layeredMaterials?: boolean;
  /** sheen / iridescence / clearcoat IBL / 体积透射着色变体(材质 uniform 240B);与 layered、textureArrays 互斥。 */
  readonly advancedMaterials?: boolean;
  /** M2 方向光 RT 阴影(opt-in):主 shader 换 sceneShaderRayTracedShadows 变体,group(2)
   *  追加 binding(3) r32float mask 槽。默认关 —— 与默认构建逐管线逐字节一致。 */
  readonly rayTracedShadows?: boolean;
  /**
   * B1 Brief-VSM 虚拟阴影档(opt-in,shadowMode="virtual" 构建期推导):主 shader 保留
   * 虚拟阴影采样库与 params2.x 门行(sceneShaderVirtualShadows 家族)。缺省关 = 默认档
   * 剥离该库(级联档 params2.x 恒 0 时整库不可达;首帧 critical main 编译墙实测大头
   * 之一,剥离斜率 fragmentMaterial -341ms / fragmentMain -93ms)。绑定面(group 0
   * binding 12..14)在两档 bind group layout 中恒存在,装配路径零变化。
   */
  readonly virtualShadowPages?: boolean;
  /**
   * AA-M1 主 pass 采样数(能力解析后的生效值,1 或 4):只作用于 HDR 主 opaque 管线
   * (mainPipelines)与主 pass 内绘制的全景背景/簇级 bundle;直出 display 管线渲染进
   * 1x swapchain,恒 1;阴影图集管线恒 1。缺省 = 请求常量(4),由调用方(bootstrap
   * 能力探针)决定是否降为 1。
   */
  readonly mainSampleCount?: number;
  /** Main pipeline keys required by the first published frame. They are queued
   * (and awaited) before every other main variant; the remaining mains are only
   * queued once the critical subset resolves, so the bootstrap validation scope
   * can settle without waiting for the full variant matrix. Shadow, display,
   * directional and output pipelines always stay in the critical scope. */
  readonly firstFrameMainKeys?: readonly string[];
}

export interface PipelinesBuild {
  readonly pipelines: Pipelines;
  /** Resolves once every planned pipeline is resident; rejects when any fails. */
  readonly ready: Promise<void>;
  /** Resolves once the first-frame critical subset is resident. */
  readonly criticalReady: Promise<void>;
  /** Lets background main variants enter the caller's released error scope. */
  readonly releaseDeferredQueues: () => void;
  /** C26 量化口径:本 device 的逐管线编译耗时清单(WGSL 指纹 + 耗时 + 命中)。 */
  readonly pipelineCompileRecords: () => readonly PipelineCompileRecord[];
  /** 首帧关键子集的管线指纹(关键 main + 全部阴影/display/directional);
   * 跨会话预热计划据此把 last-session 关键管线标为 first-frame 优先级。 */
  readonly criticalFingerprints: readonly string[];
}

export async function createPipelines(device: GPUDevice, format: GPUTextureFormat,
  forwardPlusLayout: GPUBindGroupLayout, writeGeometryBuffers = true,
  directDisplayNoEffects = false, directDisplayOneCascade = false,
  options: PipelinesBuildOptions = {}): Promise<Pipelines> {
  const build = await createPipelinesBuild(device, format, forwardPlusLayout, writeGeometryBuffers,
    directDisplayNoEffects, directDisplayOneCascade, options);
  build.releaseDeferredQueues();
  await build.ready;
  return build.pipelines;
}

export async function createPipelinesBuild(device: GPUDevice, format: GPUTextureFormat,
  forwardPlusLayout: GPUBindGroupLayout, writeGeometryBuffers = true,
  directDisplayNoEffects = false, directDisplayOneCascade = false,
  options: PipelinesBuildOptions = {}): Promise<PipelinesBuild> {
  const deformation = options.deformation === true;
  const textureArrays = options.textureArrays === true;
  const layeredMaterials = options.layeredMaterials === true;
  const advancedMaterials = options.advancedMaterials === true;
  // M2 方向光 RT 阴影(opt-in):主 shader 走 RT 变体(deepPrimaryShadow 的 mask 采样
  // 分支 + group(2) binding(3));默认关时 moduleCode 与历史逐字节一致。
  const rayTracedShadows = options.rayTracedShadows === true;
  // B1 Brief-VSM 虚拟阴影档(opt-in):shadowMode="virtual" 构建期推导,保留虚拟采样库。
  const virtualShadowPages = options.virtualShadowPages === true;
  // AA-M1:主 pass 采样数在构建期定死(渲染器构造期已按设备能力解析),undefined = 请求常量。
  const mainSampleCount = resolvePbrMsaaSampleCount(options.mainSampleCount);
  if (advancedMaterials && (layeredMaterials || textureArrays)) throw new Error("Advanced materials cannot combine with layered or texture-array pipelines.");
  if (layeredMaterials && textureArrays) throw new Error("Layered materials use the D2 material pipeline; array batches retain their existing profile.");
  if (layeredMaterials && device.limits.maxSampledTexturesPerShaderStage < LAYERED_MATERIAL_REQUIRED_TEXTURES)
    throw new Error("PBR capability layered-materials/texture-limit: requires 19 sampled textures.");
  const profileVariant = `${deformation ? "deformation" : "static"}-${textureArrays ? "array" : "fallback"}${layeredMaterials ? "-layered" : ""}${advancedMaterials ? "-advanced" : ""}`;
  const markPipeline = (phase: string): void => {
    if (typeof performance !== "undefined" && typeof performance.mark === "function") {
      performance.mark(`deep-webgpu:pipeline-${profileVariant}-${phase}`);
    }
  };
  markPipeline("start");
  if (deformation && !writeGeometryBuffers) throw new Error("Deformation pipelines require geometry buffers for motion history.");
  /** Pipeline maps fill incrementally, so a first-frame subset becomes drawable
   * while background variants are still compiling. */
  const track = (map: Map<string, GPURenderPipeline>, key: string,
    promise: Promise<GPURenderPipeline>): Promise<GPURenderPipeline> => {
    void promise.then(pipeline => { map.set(key, pipeline); });
    return promise;
  };
  const poseEntries: GPUBindGroupLayoutEntry[] = deformation ? [11, 12].map(binding => ({
    binding, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage", minBindingSize: 48 },
  })) : [];
  const source = deformation
    ? (virtualShadowPages
      ? (rayTracedShadows ? deformedSceneShaderVirtualShadowsRayTracedShadows : deformedSceneShaderVirtualShadows)
      : (rayTracedShadows ? deformedSceneShaderRayTracedShadows : deformedSceneShader))
    : (virtualShadowPages
      ? (rayTracedShadows ? sceneShaderVirtualShadowsRayTracedShadows : sceneShaderVirtualShadows)
      : (rayTracedShadows ? sceneShaderRayTracedShadows : sceneShader));
  const moduleCode = textureArrays ? composeTextureArraySceneShader(source)
    : layeredMaterials ? composeLayeredMaterialSceneShader(source)
      : advancedMaterials ? composeAdvancedMaterialSceneShader(source) : source;
  // C26:逐管线编译走指纹缓存(WGSL 源哈希 + 描述符指纹),命中复用并记录
  // 逐管线编译耗时清单;WGSL 源或描述符变更即指纹漂移,陈旧条目自动失效。
  const compileCache = pipelineCompileCacheForDevice(device, { now: () => performance.now() });
  const createPipeline = (descriptor: GPURenderPipelineDescriptor): Promise<GPURenderPipeline> =>
    compileCache.create([moduleCode], descriptor, () => device.createRenderPipelineAsync(descriptor));
  // 首帧关键子集的指纹登记:跨会话预热计划据此识别"上次哪些管线是首帧必需"。
  const createCriticalPipeline = (descriptor: GPURenderPipelineDescriptor): Promise<GPURenderPipeline> => {
    criticalFingerprints.push(renderPipelineFingerprint([moduleCode], descriptor));
    return createPipeline(descriptor);
  };
  const module = device.createShaderModule({ label: textureArrays ? "Deep PBR texture arrays" : "Deep PBR",
    code: moduleCode });
  const sharedOutput = sharedOutputPipeline(device, format);
  const [sceneInfo] = await Promise.all([module.getCompilationInfo(), sharedOutput.validated]);
  const errors = sceneInfo.messages.filter(message => message.type === "error");
  if (errors.length) throw new Error(errors.map(message => `WGSL ${message.lineNum}: ${message.message}`).join("\n"));
  markPipeline("shaders-validated");  const frameLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: PBR_FRAME_UNIFORM_BYTES } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
    ...[3, 4].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "cube" as const } })),
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 64 } },
    { binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 32 } },
    ...[9, 10].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "cube" as const } })),
    { binding: 11, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 128 } },
    // B1 Brief-VSM:虚拟阴影页表 meta/layers(storage)与页 atlas(unfilterable float
    // 2d-array)挂 frame 组 0 尾部(仅 virtual 档消费;级联档由 mainBindings 以占位
    // 16B buffer/4×4 纹理填充,params2.x=0 时着色端不读)。
    { binding: 12, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 13, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 14, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } },
  ] });
  const material = device.createBindGroupLayout({ entries: textureArrays
    ? [...textureArrayMaterialTableLayoutEntries(), ...poseEntries]
    : [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ...poseEntries,
      ...(layeredMaterials ? layeredMaterialLayoutEntries() : []),
    ] });
  const emptyMaterialLayout = device.createBindGroupLayout({ label: "Deep plain material group 1", entries: poseEntries });
  const cascadedShadowLayout = device.createBindGroupLayout({ label: "Deep cascaded shadow group 2", entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: CASCADED_SHADOW_UNIFORM_BYTES } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "depth", viewDimension: "2d-array" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
    // M2 光追阴影:mask 槽仅 RT 构建档存在(默认 3 条,与历史 layout 逐条目一致);
    // r32float 不可过滤 → sampleType 必须 "unfilterable-float"(WGSL textureLoad 无需
    // 过滤器,但 layout 合同必须匹配纹理格式)。
    ...(rayTracedShadows ? [{ binding: 3, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float" as const, viewDimension: "2d" as const } }] : []),
  ] });
  const plainLayout = device.createPipelineLayout({
    bindGroupLayouts: [frameLayout, emptyMaterialLayout, cascadedShadowLayout, forwardPlusLayout],
  });
  const materialPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [frameLayout, material, cascadedShadowLayout, forwardPlusLayout],
  });
  const directionalPlainLayout = device.createPipelineLayout({
    bindGroupLayouts: [frameLayout, emptyMaterialLayout, cascadedShadowLayout],
  });
  const mainPipelines = new Map<string, GPURenderPipeline>();
  const criticalFingerprints: string[] = [];
  const mainFactories: Array<{ readonly key: string; readonly descriptor: GPURenderPipelineDescriptor;
    readonly create: () => Promise<GPURenderPipeline> }> = [];
  for (const mode of ["plain", "material", "normal"] as const) for (const transparent of [false, true]) {
    for (const raster of ["ccw", "cw", "double"] as const) {
      const doubleSided = raster === "double";
      // AA-M2:a2c 变体仅在多采样主 pass 档构建(WebGPU validation:alphaToCoverageEnabled
      // 要求 sampleCount>1);透明(OIT,恒 1x)与 1x 集合不建 —— 1x 渲染器绘制 a2c 批次
      // 在 packetDraw 显式报错,不静默降级。a2c 分支仅追加 alphaToCoverageEnabled:
      // G-buffer target0 的 alpha 通道由 coverage() 的 a2c 位直通材质 alpha(采样掩码
      // 来源),editorOverlay 的 alpha 强度语义随之对 a2c 材质变为真实覆盖率。
      const a2cVariants: readonly boolean[] = transparent || mainSampleCount === 1 ? [false] : [false, true];
      for (const alphaToCoverage of a2cVariants) {
        const key = mainPipelineKey(mode, transparent, raster, alphaToCoverage);
        const targets: readonly GPUColorTargetState[] = (transparent ? weightedOitColorTargets()
          : (writeGeometryBuffers ? PBR_OPAQUE_ATTACHMENT_FORMATS : [PBR_HDR_FORMAT]).map(format => ({ format })))
          .map((target, index) => index === 0 && alphaToCoverage ? { ...target, alphaToCoverageEnabled: true } : target);
        const opaqueEntry = mode === "plain" ? "fragmentMain" : "fragmentMaterial";
        const descriptor: GPURenderPipelineDescriptor = {
          label: `Deep forward PBR ${key}`,
          layout: mode === "plain" ? plainLayout : materialPipelineLayout,
          vertex: { module, entryPoint: deformation ? mode === "normal" ? "vertexDeformedNormalMapped" : "vertexDeformed"
            : mode === "normal" ? "vertexNormalMapped" : "vertexMain",
            buffers: mode === "normal" && !deformation ? [...buffers, PBR_PREVIOUS_INSTANCE_BUFFER_LAYOUT, tangentBuffer]
              : [...buffers, PBR_PREVIOUS_INSTANCE_BUFFER_LAYOUT] },
          fragment: { module, entryPoint: transparent
            ? mode === "plain" ? "fragmentMainTransparent" : "fragmentMaterialTransparent"
            : writeGeometryBuffers ? opaqueEntry : `${opaqueEntry}Color`, targets },
          primitive: { topology: "triangle-list", cullMode: doubleSided ? "none" : "back", frontFace: raster === "cw" ? "cw" : "ccw" },
          depthStencil: { format: PBR_DEPTH_FORMAT, depthWriteEnabled: !transparent, depthCompare: "less" },
          // 透明(blend/OIT)变体恒 1x:绘制目标是 1x OIT 累积 pass(主方案纪律:
          // 混合链不进 MSAA 主目标,加权 OIT 的逐片元权重无多采样语义)。
          multisample: { count: transparent ? 1 : mainSampleCount },
        };
        mainFactories.push({ key, descriptor, create: () => createPipeline(descriptor) });
      }
    }
  }
  // 首帧关键子集立即排队（plain/ccw 恒含）；其余 main 变体等 release 后再排队。
  const passMainKey = mainPipelineKey("plain", false, "ccw");
  const firstFrameKeys = options.firstFrameMainKeys;
  const criticalMains = firstFrameKeys
    ? mainFactories.filter(({ key }) => key === passMainKey || firstFrameKeys.includes(key))
    : mainFactories;
  const deferredMains = firstFrameKeys
    ? mainFactories.filter(({ key }) => key !== passMainKey && !firstFrameKeys.includes(key))
    : [];
  const criticalMainReady = Promise.all(criticalMains.map(({ key, descriptor }) =>
    track(mainPipelines, key, createCriticalPipeline(descriptor))))
    .then(value => { markPipeline(`critical-main${value.length}-ready`); return value; });
  const displayPipelines = new Map<string, GPURenderPipeline>(), pendingDisplay: Array<Promise<GPURenderPipeline>> = [];
  const pendingDisplayKeys: string[] = [];
  if (!writeGeometryBuffers) for (const mode of ["plain", "material", "normal"] as const) {
    for (const raster of ["ccw", "cw", "double"] as const) {
      const key = mainPipelineKey(mode, false, raster), doubleSided = raster === "double";
      pendingDisplayKeys.push(key); pendingDisplay.push(track(displayPipelines, key, createCriticalPipeline({
        label: `Deep direct display PBR ${key}`,
        layout: mode === "plain" ? plainLayout : materialPipelineLayout,
        vertex: { module, entryPoint: mode === "plain" ? "vertexDirectDisplay"
          : mode === "normal" ? "vertexNormalMaterialDirectDisplay" : "vertexMaterialDirectDisplay",
          buffers: mode === "normal" ? [...buffers, tangentBuffer] : buffers },
        fragment: { module, entryPoint: mode === "plain"
          ? directDisplayNoEffects ? directDisplayOneCascade
            ? "fragmentMainDisplayNoEffectsOneCascade" : "fragmentMainDisplayNoEffects" : "fragmentMainDisplay"
          : "fragmentMaterialDisplay",
          targets: [{ format }] },
        primitive: { topology: "triangle-list", cullMode: doubleSided ? "none" : "back", frontFace: raster === "cw" ? "cw" : "ccw" },
        depthStencil: { format: PBR_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
        // 直出 display 管线渲染进 1x swapchain 视图,恒不参与 MSAA(AA-M1)。
        multisample: { count: 1 },
      })));
    }
  }
  const displayDirectionalPipelines = new Map<string, GPURenderPipeline>();
  const pendingDirectional: Array<Promise<GPURenderPipeline>> = [], pendingDirectionalKeys: string[] = [];
  if (!writeGeometryBuffers && directDisplayNoEffects && directDisplayOneCascade) {
    for (const raster of ["ccw", "cw", "double"] as const) {
      const key = mainPipelineKey("plain", false, raster), doubleSided = raster === "double";
      pendingDirectionalKeys.push(key); pendingDirectional.push(track(displayDirectionalPipelines, key, createCriticalPipeline({
        label: `Deep direct directional PBR ${key}`, layout: directionalPlainLayout,
        vertex: { module, entryPoint: "vertexDirectDisplay", buffers },
        fragment: { module, entryPoint: "fragmentMainDisplayDirectional", targets: [{ format }] },
        primitive: { topology: "triangle-list", cullMode: doubleSided ? "none" : "back",
          frontFace: raster === "cw" ? "cw" : "ccw" },
        depthStencil: { format: PBR_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
        multisample: { count: 1 },
      })));
    }
  }
  const shadowFrameLayout = device.createBindGroupLayout({ label: "Deep shadow frame group 0", entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
  ] });
  const shadowPlainLayout = device.createPipelineLayout({ label: "Deep shadow plain layout",
    bindGroupLayouts: deformation ? [shadowFrameLayout, emptyMaterialLayout] : [shadowFrameLayout] });
  const shadowMaterialLayout = device.createPipelineLayout({ label: "Deep shadow material layout",
    bindGroupLayouts: [shadowFrameLayout, material] });
  const shadowPipelines = new Map<string, GPURenderPipeline>(), pendingShadow: Array<Promise<GPURenderPipeline>> = [], pendingShadowKeys: string[] = [];
  for (const authored of directDisplayOneCascade ? [false, true] : [false]) for (const mode of ["solid", "maskPlain", "maskMaterial"] as const) for (const raster of ["ccw", "cw", "double"] as const) {
    const key = (authored ? "author/" : "") + shadowPipelineKey(mode, raster), doubleSided = raster === "double";
    pendingShadowKeys.push(key);
    pendingShadow.push(track(shadowPipelines, key, createCriticalPipeline({
      label: `Deep shadow ${key}`, layout: mode === "maskMaterial" ? shadowMaterialLayout : shadowPlainLayout,
      vertex: { module, entryPoint: deformation ? mode === "solid" ? "shadowDeformed" : "shadowMaskDeformed"
        : mode === "solid" ? "shadowMain" : "shadowMaskMain",
        buffers: mode === "solid" ? shadowBuffers : shadowMaskBuffers },
      ...(mode === "solid" ? {} : { fragment: { module, entryPoint: mode === "maskPlain" ? "shadowMaskPlain" : "shadowMaskTextured", targets: [] } }),
      primitive: { topology: "triangle-list", cullMode: doubleSided ? "none" : authored ? "front" : "back", frontFace: raster === "cw" ? "cw" : "ccw" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: authored ? 0 : 1, depthBiasSlopeScale: authored ? 0 : 1 },
    })));
  }
  // B1 Brief-VSM 虚拟阴影页物化管线:与级联阴影同顶点/同键位,片元额外把线性光深
  // (builtin z,WebGPU 0..1)写进 r32float 页 atlas;depth32float 附件仍承担近者胜。
  // 恒 1x(页池非 MSAA 附件),不入首帧关键集(虚拟档 opt-in)。
  const pageShadowPipelines = new Map<string, GPURenderPipeline>();
  const pendingPageShadow: Array<Promise<GPURenderPipeline>> = [];
  // 分级重上前置②(2026-10-06):非虚拟档的 4 条页管线创建推迟到 release 后(backgroundQueue
  // 同队列)——此前构造期即发起 createRenderPipelineAsync,validate 提前时与其 pending 形成
  // 并发窗口,popErrorScope 合法等待(scoped operations 未结算)曾致首帧卡死(见
  // validatePbrFrame 超时守卫注释)。虚拟档(virtualShadowPages)页物化是核心路径,保持立即。
  const deferredPageShadowFactories: Array<{ readonly key: string; readonly create: () => Promise<GPURenderPipeline> }> = [];
  // 与 main 分级同开关:仅 subset 路径(外部承诺 release)推迟;直调路径保持立即创建,
  // 否则无人放水死锁(deferredMainReady 等 releaseGate,release 只由 backend 成功后调)。
  const pageShadowDeferred = !virtualShadowPages && firstFrameKeys !== undefined;
  const enqueuePageShadow = (key: string, create: () => Promise<GPURenderPipeline>) => {
    if (pageShadowDeferred) { deferredPageShadowFactories.push({ key, create }); return; }
    pendingPageShadow.push(track(pageShadowPipelines, key, create()));
  };
  // 页矩形清屏管线(虚拟阴影专用;loadOp load 下每页重绘前把页矩形归位 far=1.0;
  // 零绑定布局 —— draw 不设任何 bind group)。
  enqueuePageShadow("clear", () => device.createRenderPipelineAsync({
    label: "Deep virtual shadow page clear",
    layout: device.createPipelineLayout({ label: "Deep virtual shadow page clear layout",
      bindGroupLayouts: [] }),
    vertex: { module, entryPoint: "shadowPageClear" },
    fragment: { module, entryPoint: "shadowPageClearDepth", targets: [{ format: "r32float" }] },
    primitive: { topology: "triangle-strip" },
    depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "always" },
    multisample: { count: 1 },
  }));
  // 页管线仅 solid 档 × 3 raster + clear:masked 材质经 packetDraw 的 solid 回退按实心
  // 投影(documented 简化,见 pbrShader.ts 页物化注释)。
  for (const raster of ["ccw", "cw", "double"] as const) {
    const key = shadowPipelineKey("solid", raster), doubleSided = raster === "double";
    enqueuePageShadow(key, () => device.createRenderPipelineAsync({
      label: `Deep virtual shadow page ${key}`,
      layout: shadowPlainLayout,
      vertex: { module, entryPoint: deformation ? "shadowDeformed" : "shadowMain", buffers: shadowBuffers },
      fragment: { module, entryPoint: "shadowPageDepth", targets: [{ format: "r32float" }] },
      primitive: { topology: "triangle-list", cullMode: doubleSided ? "none" : "back", frontFace: raster === "cw" ? "cw" : "ccw" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: 1, depthBiasSlopeScale: 1 },
      multisample: { count: 1 },
    }));
  }
  const output = sharedOutput.renderPipeline();
  markPipeline(`queued-main${mainFactories.length}-display${pendingDisplay.length}-directional${pendingDirectional.length}-shadow${pendingShadow.length}-pageShadow${pendingPageShadow.length}-output1`);
  const displayReady = Promise.all(pendingDisplay).then(value => { markPipeline("display-ready"); return value; });
  const directionalReady = Promise.all(pendingDirectional).then(value => { markPipeline("directional-ready"); return value; });
  const shadowReady = Promise.all(pendingShadow).then(value => { markPipeline("shadow-ready"); return value; });
  // B1 Brief-VSM:页物化管线随 ready 结算(opt-in 能力,不占首帧关键集)。
  const pageShadowReady = Promise.all(pendingPageShadow).then(value => { markPipeline("page-shadow-ready"); return value; });
  const outputPipelineReady = output.then(value => { markPipeline("output-ready"); return value; });
  const criticalReady = Promise.all([criticalMainReady, displayReady, directionalReady, shadowReady, outputPipelineReady])
    .then(() => { markPipeline("critical-ready"); });
  // 剩余主材质变体必须在调用方关闭 bootstrap 校验作用域之后才允许排队，
  // 否则 popErrorScope 会再次等待它们，首帧关键路径的收益归零。
  // C26:放行后背景变体经预热队列(并发上限 2)让路,不再无界并发压设备——
  // 单个变体失败不阻断其余变体,拒绝经由各自 promise 传入 ready。
  const backgroundQueue = new PipelineWarmupQueue({ concurrency: 2 });
  let releaseDeferredQueues: (() => void) | undefined;
  const releaseGate = new Promise<void>(resolve => { releaseDeferredQueues = resolve; });
  const deferredMainReady = criticalMainReady.then(async () => {
    await releaseGate;
    // 入队全部后才放水:首帧关键子集结算前队列保持暂停,背景变体零启动。
    // C26 跨会话预热:上会话持久化计划把实测最耗时的背景变体排最前(并发 2 下
    // 最长编译最早起步);无计划/指纹未命中保持原序(fail-open,不抛)。
    const warmupStorage = browserLocalStorage();
    const warmupPlan = warmupStorage ? loadPipelineWarmupPlan(warmupStorage) : undefined;
    const orderedDeferredMains = orderDeferredByWarmupPlan(deferredMains, warmupPlan,
      ({ descriptor }) => renderPipelineFingerprint([moduleCode], descriptor));
    const pending = orderedDeferredMains.map(({ key, descriptor, create }) =>
      track(mainPipelines, key, backgroundQueue.enqueue({
        fingerprint: renderPipelineFingerprint([moduleCode], descriptor),
        label: descriptor.label ?? key, priority: "background", create,
      })));
    backgroundQueue.resume();
    // 分级重上前置②:非虚拟档页管线(release 前零启动)在此补齐——不走预热队列
    // (仅 4 条,无排序需求),release 后并发创建即可。
    const pendingPages = deferredPageShadowFactories.map(({ key, create }) =>
      track(pageShadowPipelines, key, create()));
    const value = (await Promise.all(pending)).length;
    await Promise.all(pendingPages);
    markPipeline("main-ready");
    // C26 跨会话预热计划回写:本次实测编译样本入 localStorage(fail-open;
    // 缓存命中/失败样本经 pipelineWarmupEntriesFromLedger 排除,浏览器外静默跳过)。
    try {
      const target = browserLocalStorage();
      if (target) persistPipelineWarmupPlanToBrowser(
        pipelineWarmupEntriesFromLedger(compileCache.records, criticalFingerprints, Date.now()), target);
    } catch { /* fail-open */ }
    return value;
  });
  if (deferredMains.length === 0 && deferredPageShadowFactories.length === 0) releaseDeferredQueues?.();
  // B1 Brief-VSM:页物化管线失败同样让 ready 拒绝(不静默;虚拟档 opt-in 构造即需可用)。
  const ready = Promise.all([deferredMainReady, displayReady, directionalReady, shadowReady, pageShadowReady, outputPipelineReady])
    .then(() => { markPipeline("ready"); });
  let outputPipeline: GPURenderPipeline | undefined;
  let outputProvenance: PbrOutputShaderProvenance | undefined;
  void outputPipelineReady.then(value => {
    outputPipeline = value;
    outputProvenance = createPbrOutputShaderProvenance(value, outputShader);
  }).catch(() => { /* criticalReady/ready 传播失败；此处只避免未处理拒绝 */ });
  const pipelines: Pipelines = {
    get main() { return mainPipelines.get(passMainKey)!; },
    get shadow() { return shadowPipelines.get(shadowPipelineKey("solid", "ccw"))!; },
    mainPipelines, displayPipelines, displayDirectionalPipelines, shadowPipelines, pageShadowPipelines,
    get output() { return outputPipeline!; },
    get outputShaderProvenance() { return outputProvenance; },
    materialLayout: { material, ...(layeredMaterials ? { layeredMaterials: true } : {}), ...(advancedMaterials ? { advancedMaterials: true } : {}) }, cascadedShadowLayout,
    rayTracedShadowMaskBinding: rayTracedShadows,
    ...(deformation ? { deformationPlainLayout: emptyMaterialLayout } : {}),
  };
  // 对象展开会立即求值访问器，条件可选字段必须用 defineProperty 挂 getter，
  // 让读取时机推迟到管线真正就绪之后。
  if (pendingDisplay.length) Object.defineProperty(pipelines, "displayMain",
    { get: () => displayPipelines.get(passMainKey)!, enumerable: true, configurable: true });
  if (pendingDirectional.length) Object.defineProperty(pipelines, "displayDirectionalMain",
    { get: () => displayDirectionalPipelines.get(passMainKey)!, enumerable: true, configurable: true });
  return { pipelines, criticalReady, ready, releaseDeferredQueues: releaseDeferredQueues!,
    pipelineCompileRecords: () => compileCache.records, criticalFingerprints };
}

/**
 * DE26/C03 透明语义支持矩阵（Web/Native 两端对拍的声明源，Native blend_state 逐项对拍）：
 * - straight（缺省）RGB 直通；premultiplied 的作者 RGB 已按 alpha 预乘，blend RGB 因子为 one。
 * - depthWriteEnabled: false——BLEND 两端恒不写深度（Web weighted OIT 累积 pass、Native 全局排序 blend 同）；
 *   作者请求 true 时桥 fail-closed，不静默丢设置。
 * - side: front/double 支持；double 是单 pass cull-none——weighted OIT 累积可交换，
 *   three.js 的 two-pass DoubleSide 声明折叠为数学等价；back 在矩阵外。
 * - shadow: none——BLEND 不进 shadow pass（Native draw_shadow_indirect 同规则排除）；
 *   MASK 以 alphaCutoff 参与 mask 阴影，OPAQUE 走 solid。
 * - 零 alpha 合法：OIT 权重下限保底但贡献为 0，等价完全不可见；不剔除不拒绝。
 */
export const transparencySupportMatrix = {
  straight: { color: ["src-alpha", "one-minus-src-alpha"], alpha: ["one", "one-minus-src-alpha"] },
  premultiplied: { color: ["one", "one-minus-src-alpha"], alpha: ["one", "one-minus-src-alpha"] },
  depthWriteEnabled: false,
  shadow: "none",
  supportedSides: ["front", "double"],
  zeroAlpha: "fully-invisible",
} as const satisfies {
  readonly straight: { readonly color: readonly GPUBlendFactor[]; readonly alpha: readonly GPUBlendFactor[] };
  readonly premultiplied: { readonly color: readonly GPUBlendFactor[]; readonly alpha: readonly GPUBlendFactor[] };
  readonly depthWriteEnabled: false;
  readonly shadow: "none";
  readonly supportedSides: readonly ("front" | "double")[];
  readonly zeroAlpha: "fully-invisible";
};

/** glTF BLEND 使用 straight-alpha RGB：src-alpha / one-minus-src-alpha；alpha 通道使用 source-over。 */
export const alphaBlendSemantics = transparencySupportMatrix.straight;

export function materialMode(textured: boolean, normalMapped: boolean): MainMaterialMode {
  return normalMapped ? "normal" : textured ? "material" : "plain";
}

export function shadowMode(alphaMode: AlphaMode, textured: boolean): ShadowMode | undefined {
  if (alphaMode === "BLEND") return undefined;
  if (alphaMode === "OPAQUE") return "solid";
  return textured ? "maskMaterial" : "maskPlain";
}
