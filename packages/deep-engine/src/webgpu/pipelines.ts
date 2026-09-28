import type { AlphaMode } from "../renderPacket.js";
export { authoredShadowPipelines } from "./authoredShadowPipelines.js";
import { sceneShader, outputShader } from "./pbrShader.js";
import { deformedSceneShader } from "./pbrDeformationShader.js";
import type { MaterialLayouts } from "./materialBindings.js";
import { PBR_DEPTH_FORMAT, PBR_HDR_FORMAT, PBR_MAIN_SAMPLE_COUNT, PBR_OPAQUE_ATTACHMENT_FORMATS } from "./renderTargets.js";
import { weightedOitColorTargets } from "./weightedOit.js";
import { CASCADED_SHADOW_UNIFORM_BYTES } from "../shadows/cascadedShadowShader.js";
import { createPbrOutputShaderProvenance, type PbrOutputShaderProvenance } from "./pbrOutputShaderProvenance.js";
import { composeTextureArraySceneShader } from "./textureArrayWgsl.js";
import { textureArrayMaterialTableLayoutEntries } from "./textureArrayMaterialTable.js";
import { sharedOutputPipeline } from "./pbrOutputPipelineCache.js";

export const PBR_FRAME_UNIFORM_FLOATS = 96;
export const PBR_FRAME_UNIFORM_BYTES = PBR_FRAME_UNIFORM_FLOATS * 4;
export const PBR_FRAME_FLOAT_OFFSETS = Object.freeze({ currentViewProjection: 0, previousViewProjection: 16,
  worldToView: 32, lightViewProjection: 48, eye: 64, background: 68, floor: 72, lightDirection: 76,
  tuning: 80, sunColor: 84, output: 88 } as const);
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
  readonly output: GPURenderPipeline;
  readonly outputShaderProvenance?: PbrOutputShaderProvenance | undefined;
  readonly materialLayout: MaterialLayouts;
  readonly cascadedShadowLayout: GPUBindGroupLayout;
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
export function mainPipelineKey(mode: MainMaterialMode, transparent: boolean, raster: RasterMode): string {
  return `${mode}/${transparent ? "blend" : "depth"}/${raster}`;
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
  const profileVariant = `${deformation ? "deformation" : "static"}-${textureArrays ? "array" : "fallback"}`;
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
  const source = deformation ? deformedSceneShader : sceneShader;
  const module = device.createShaderModule({ label: textureArrays ? "Deep PBR texture arrays" : "Deep PBR",
    code: textureArrays ? composeTextureArraySceneShader(source) : source });
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
    ] });
  const emptyMaterialLayout = device.createBindGroupLayout({ label: "Deep plain material group 1", entries: poseEntries });
  const cascadedShadowLayout = device.createBindGroupLayout({ label: "Deep cascaded shadow group 2", entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: CASCADED_SHADOW_UNIFORM_BYTES } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "depth", viewDimension: "2d-array" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
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
  const mainFactories: Array<{ readonly key: string; readonly create: () => Promise<GPURenderPipeline> }> = [];
  for (const mode of ["plain", "material", "normal"] as const) for (const transparent of [false, true]) {
    for (const raster of ["ccw", "cw", "double"] as const) {
      const key = mainPipelineKey(mode, transparent, raster), doubleSided = raster === "double";
      const targets: readonly GPUColorTargetState[] = transparent ? weightedOitColorTargets()
        : (writeGeometryBuffers ? PBR_OPAQUE_ATTACHMENT_FORMATS : [PBR_HDR_FORMAT]).map(format => ({ format }));
      const opaqueEntry = mode === "plain" ? "fragmentMain" : "fragmentMaterial";
      mainFactories.push({ key, create: () => device.createRenderPipelineAsync({
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
        multisample: { count: PBR_MAIN_SAMPLE_COUNT },
      }) });
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
  const criticalMainReady = Promise.all(criticalMains.map(({ key, create }) => track(mainPipelines, key, create())))
    .then(value => { markPipeline(`critical-main${value.length}-ready`); return value; });
  const displayPipelines = new Map<string, GPURenderPipeline>(), pendingDisplay: Array<Promise<GPURenderPipeline>> = [];
  const pendingDisplayKeys: string[] = [];
  if (!writeGeometryBuffers) for (const mode of ["plain", "material", "normal"] as const) {
    for (const raster of ["ccw", "cw", "double"] as const) {
      const key = mainPipelineKey(mode, false, raster), doubleSided = raster === "double";
      pendingDisplayKeys.push(key); pendingDisplay.push(track(displayPipelines, key, device.createRenderPipelineAsync({
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
        multisample: { count: PBR_MAIN_SAMPLE_COUNT },
      })));
    }
  }
  const displayDirectionalPipelines = new Map<string, GPURenderPipeline>();
  const pendingDirectional: Array<Promise<GPURenderPipeline>> = [], pendingDirectionalKeys: string[] = [];
  if (!writeGeometryBuffers && directDisplayNoEffects && directDisplayOneCascade) {
    for (const raster of ["ccw", "cw", "double"] as const) {
      const key = mainPipelineKey("plain", false, raster), doubleSided = raster === "double";
      pendingDirectionalKeys.push(key); pendingDirectional.push(track(displayDirectionalPipelines, key, device.createRenderPipelineAsync({
        label: `Deep direct directional PBR ${key}`, layout: directionalPlainLayout,
        vertex: { module, entryPoint: "vertexDirectDisplay", buffers },
        fragment: { module, entryPoint: "fragmentMainDisplayDirectional", targets: [{ format }] },
        primitive: { topology: "triangle-list", cullMode: doubleSided ? "none" : "back",
          frontFace: raster === "cw" ? "cw" : "ccw" },
        depthStencil: { format: PBR_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
        multisample: { count: PBR_MAIN_SAMPLE_COUNT },
      })));
    }
  }
  const shadowFrameLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
  ] });
  const shadowPlainLayout = device.createPipelineLayout({ bindGroupLayouts: deformation
    ? [shadowFrameLayout, emptyMaterialLayout] : [shadowFrameLayout] });
  const shadowMaterialLayout = device.createPipelineLayout({ bindGroupLayouts: [shadowFrameLayout, material] });
  const shadowPipelines = new Map<string, GPURenderPipeline>(), pendingShadow: Array<Promise<GPURenderPipeline>> = [], pendingShadowKeys: string[] = [];
  for (const authored of directDisplayOneCascade ? [false, true] : [false]) for (const mode of ["solid", "maskPlain", "maskMaterial"] as const) for (const raster of ["ccw", "cw", "double"] as const) {
    const key = (authored ? "author/" : "") + shadowPipelineKey(mode, raster), doubleSided = raster === "double";
    pendingShadowKeys.push(key);
    pendingShadow.push(track(shadowPipelines, key, device.createRenderPipelineAsync({
      label: `Deep shadow ${key}`, layout: mode === "maskMaterial" ? shadowMaterialLayout : shadowPlainLayout,
      vertex: { module, entryPoint: deformation ? mode === "solid" ? "shadowDeformed" : "shadowMaskDeformed"
        : mode === "solid" ? "shadowMain" : "shadowMaskMain",
        buffers: mode === "solid" ? shadowBuffers : shadowMaskBuffers },
      ...(mode === "solid" ? {} : { fragment: { module, entryPoint: mode === "maskPlain" ? "shadowMaskPlain" : "shadowMaskTextured", targets: [] } }),
      primitive: { topology: "triangle-list", cullMode: doubleSided ? "none" : authored ? "front" : "back", frontFace: raster === "cw" ? "cw" : "ccw" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: authored ? 0 : 1, depthBiasSlopeScale: authored ? 0 : 1 },
    })));
  }
  const output = sharedOutput.renderPipeline();
  markPipeline(`queued-main${mainFactories.length}-display${pendingDisplay.length}-directional${pendingDirectional.length}-shadow${pendingShadow.length}-output1`);
  const displayReady = Promise.all(pendingDisplay).then(value => { markPipeline("display-ready"); return value; });
  const directionalReady = Promise.all(pendingDirectional).then(value => { markPipeline("directional-ready"); return value; });
  const shadowReady = Promise.all(pendingShadow).then(value => { markPipeline("shadow-ready"); return value; });
  const outputPipelineReady = output.then(value => { markPipeline("output-ready"); return value; });
  const criticalReady = Promise.all([criticalMainReady, displayReady, directionalReady, shadowReady, outputPipelineReady])
    .then(() => { markPipeline("critical-ready"); });
  // 剩余主材质变体必须在调用方关闭 bootstrap 校验作用域之后才允许排队，
  // 否则 popErrorScope 会再次等待它们，首帧关键路径的收益归零。
  let releaseDeferredQueues: (() => void) | undefined;
  const releaseGate = new Promise<void>(resolve => { releaseDeferredQueues = resolve; });
  const deferredMainReady = criticalMainReady.then(async () => {
    await releaseGate;
    const value = await Promise.all(deferredMains.map(({ key, create }) => track(mainPipelines, key, create())));
    markPipeline("main-ready");
    return value;
  });
  if (deferredMains.length === 0) releaseDeferredQueues?.();
  const ready = Promise.all([deferredMainReady, displayReady, directionalReady, shadowReady, outputPipelineReady])
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
    mainPipelines, displayPipelines, displayDirectionalPipelines, shadowPipelines,
    get output() { return outputPipeline!; },
    get outputShaderProvenance() { return outputProvenance; },
    materialLayout: { material }, cascadedShadowLayout,
    ...(deformation ? { deformationPlainLayout: emptyMaterialLayout } : {}),
  };
  // 对象展开会立即求值访问器，条件可选字段必须用 defineProperty 挂 getter，
  // 让读取时机推迟到管线真正就绪之后。
  if (pendingDisplay.length) Object.defineProperty(pipelines, "displayMain",
    { get: () => displayPipelines.get(passMainKey)!, enumerable: true, configurable: true });
  if (pendingDirectional.length) Object.defineProperty(pipelines, "displayDirectionalMain",
    { get: () => displayDirectionalPipelines.get(passMainKey)!, enumerable: true, configurable: true });
  return { pipelines, criticalReady, ready, releaseDeferredQueues: releaseDeferredQueues! };
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
