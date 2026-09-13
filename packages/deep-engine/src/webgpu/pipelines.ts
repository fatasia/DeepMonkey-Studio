import type { AlphaMode } from "../renderPacket.js";
import { sceneShader, outputShader } from "./pbrShader.js";
import type { MaterialLayouts } from "./materialBindings.js";
import { PBR_DEPTH_FORMAT, PBR_HDR_FORMAT, PBR_MAIN_SAMPLE_COUNT, PBR_OPAQUE_ATTACHMENT_FORMATS } from "./renderTargets.js";
import { weightedOitColorTargets } from "./weightedOit.js";
import { CASCADED_SHADOW_UNIFORM_BYTES } from "../shadows/cascadedShadowShader.js";

export const PBR_FRAME_UNIFORM_FLOATS = 88;
export const PBR_FRAME_UNIFORM_BYTES = PBR_FRAME_UNIFORM_FLOATS * 4;
export const PBR_FRAME_FLOAT_OFFSETS = Object.freeze({ currentViewProjection: 0, previousViewProjection: 16,
  worldToView: 32, lightViewProjection: 48, eye: 64, background: 68, floor: 72, lightDirection: 76,
  tuning: 80, sunColor: 84 } as const);
/** Previous per-object model rows consumed by motion-vector PBR variants. */
export const PBR_PREVIOUS_INSTANCE_BUFFER_LAYOUT = Object.freeze({ arrayStride: 48, stepMode: "instance", attributes: [
  { shaderLocation: 13, offset: 0, format: "float32x4" }, { shaderLocation: 14, offset: 16, format: "float32x4" },
  { shaderLocation: 15, offset: 32, format: "float32x4" },
] } as const satisfies GPUVertexBufferLayout);

export interface Pipelines {
  /** 地面使用的 plain/opaque/ccw 管线。 */
  readonly main: GPURenderPipeline;
  /** solid/opaque/ccw 阴影管线。 */
  readonly shadow: GPURenderPipeline;
  readonly mainPipelines: ReadonlyMap<string, GPURenderPipeline>;
  readonly shadowPipelines: ReadonlyMap<string, GPURenderPipeline>;
  readonly output: GPURenderPipeline;
  readonly materialLayout: MaterialLayouts;
  readonly cascadedShadowLayout: GPUBindGroupLayout;
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

export async function createPipelines(device: GPUDevice, format: GPUTextureFormat,
  forwardPlusLayout: GPUBindGroupLayout): Promise<Pipelines> {
  const module = device.createShaderModule({ label: "Deep PBR", code: sceneShader });
  const outputModule = device.createShaderModule({ label: "Deep HDR output", code: outputShader });
  for (const shader of [module, outputModule]) {
    const info = await shader.getCompilationInfo();
    const errors = info.messages.filter(message => message.type === "error");
    if (errors.length) throw new Error(errors.map(message => `WGSL ${message.lineNum}: ${message.message}`).join("\n"));
  }
  const frameLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: PBR_FRAME_UNIFORM_BYTES } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
    ...[3, 4].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "cube" as const } })),
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
  ] });
  const material = device.createBindGroupLayout({ entries: [
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
  ] });
  const emptyMaterialLayout = device.createBindGroupLayout({ label: "Deep empty material group 1", entries: [] });
  const cascadedShadowLayout = device.createBindGroupLayout({ label: "Deep cascaded shadow group 2", entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT,
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
  const mainPipelines = new Map<string, GPURenderPipeline>();
  const pendingMain: Array<Promise<GPURenderPipeline>> = [];
  const pendingMainKeys: string[] = [];
  for (const mode of ["plain", "material", "normal"] as const) for (const transparent of [false, true]) {
    for (const raster of ["ccw", "cw", "double"] as const) {
      const key = mainPipelineKey(mode, transparent, raster), doubleSided = raster === "double";
      const targets: readonly GPUColorTargetState[] = transparent ? weightedOitColorTargets()
        : PBR_OPAQUE_ATTACHMENT_FORMATS.map(format => ({ format }));
      pendingMainKeys.push(key);
      pendingMain.push(device.createRenderPipelineAsync({
        label: `Deep forward PBR ${key}`,
        layout: mode === "plain" ? plainLayout : materialPipelineLayout,
        vertex: { module, entryPoint: mode === "normal" ? "vertexNormalMapped" : "vertexMain",
          buffers: mode === "normal" ? [...buffers, PBR_PREVIOUS_INSTANCE_BUFFER_LAYOUT, tangentBuffer]
            : [...buffers, PBR_PREVIOUS_INSTANCE_BUFFER_LAYOUT] },
        fragment: { module, entryPoint: mode === "plain"
          ? transparent ? "fragmentMainTransparent" : "fragmentMain"
          : transparent ? "fragmentMaterialTransparent" : "fragmentMaterial", targets },
        primitive: { topology: "triangle-list", cullMode: doubleSided ? "none" : "back", frontFace: raster === "cw" ? "cw" : "ccw" },
        depthStencil: { format: PBR_DEPTH_FORMAT, depthWriteEnabled: !transparent, depthCompare: "less" },
        multisample: { count: PBR_MAIN_SAMPLE_COUNT },
      }));
    }
  }
  const shadowFrameLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
  ] });
  const shadowPlainLayout = device.createPipelineLayout({ bindGroupLayouts: [shadowFrameLayout] });
  const shadowMaterialLayout = device.createPipelineLayout({ bindGroupLayouts: [shadowFrameLayout, material] });
  const shadowPipelines = new Map<string, GPURenderPipeline>(), pendingShadow: Array<Promise<GPURenderPipeline>> = [], pendingShadowKeys: string[] = [];
  for (const mode of ["solid", "maskPlain", "maskMaterial"] as const) for (const raster of ["ccw", "cw", "double"] as const) {
    const key = shadowPipelineKey(mode, raster), doubleSided = raster === "double";
    pendingShadowKeys.push(key);
    pendingShadow.push(device.createRenderPipelineAsync({
      label: `Deep shadow ${key}`, layout: mode === "maskMaterial" ? shadowMaterialLayout : shadowPlainLayout,
      vertex: { module, entryPoint: mode === "solid" ? "shadowMain" : "shadowMaskMain", buffers },
      ...(mode === "solid" ? {} : { fragment: { module, entryPoint: mode === "maskPlain" ? "shadowMaskPlain" : "shadowMaskTextured", targets: [] } }),
      primitive: { topology: "triangle-list", cullMode: doubleSided ? "none" : "back", frontFace: raster === "cw" ? "cw" : "ccw" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: 1, depthBiasSlopeScale: 1 },
    }));
  }
  const output = device.createRenderPipelineAsync({
    label: "Deep output", layout: "auto", vertex: { module: outputModule, entryPoint: "vertexMain" },
    fragment: { module: outputModule, entryPoint: "fragmentMain", targets: [{ format }] }, primitive: { topology: "triangle-list" },
  });
  const [createdMain, createdShadow, outputPipeline] = await Promise.all([Promise.all(pendingMain), Promise.all(pendingShadow), output]);
  createdMain.forEach((pipeline, index) => mainPipelines.set(pendingMainKeys[index]!, pipeline));
  createdShadow.forEach((pipeline, index) => shadowPipelines.set(pendingShadowKeys[index]!, pipeline));
  return { main: mainPipelines.get(mainPipelineKey("plain", false, "ccw"))!,
    shadow: shadowPipelines.get(shadowPipelineKey("solid", "ccw"))!, mainPipelines, shadowPipelines,
    output: outputPipeline, materialLayout: { material }, cascadedShadowLayout };
}

/** glTF BLEND 使用 straight-alpha RGB：src-alpha / one-minus-src-alpha；alpha 通道使用 source-over。 */
export const alphaBlendSemantics = {
  color: ["src-alpha", "one-minus-src-alpha"], alpha: ["one", "one-minus-src-alpha"],
  depthWriteEnabled: false, shadow: "none",
} as const satisfies { readonly color: readonly GPUBlendFactor[]; readonly alpha: readonly GPUBlendFactor[];
  readonly depthWriteEnabled: false; readonly shadow: "none" };

export function materialMode(textured: boolean, normalMapped: boolean): MainMaterialMode {
  return normalMapped ? "normal" : textured ? "material" : "plain";
}

export function shadowMode(alphaMode: AlphaMode, textured: boolean): ShadowMode | undefined {
  if (alphaMode === "BLEND") return undefined;
  if (alphaMode === "OPAQUE") return "solid";
  return textured ? "maskMaterial" : "maskPlain";
}
