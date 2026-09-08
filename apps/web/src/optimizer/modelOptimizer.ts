import { type WebIO, type Document, type JSONDocument } from "@gltf-transform/core";
import { center, dedup, draco, prune, simplify, textureCompress, unwrap, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { bakeWebLightmap, type WebLightmapResult } from "./lightmapBaker";
import { preserveOptimizationCredit } from "./modelOptimizationCredit";
import { optimizerIO } from "./modelOptimizerIO";
import { migrateLegacyMaterials } from "./legacyGltfMaterials";

export interface ModelOptimizationOptions {
  simplifyEnabled: boolean;
  simplifyRatio: number;
  simplifyError: number;
  dracoEnabled: boolean;
  textureEnabled: boolean;
  textureSize: number;
  textureFormat: "webp" | "jpeg" | "original";
  bakeEnabled: boolean;
  bakeMode: "vertex" | "lightmap";
  bakeStrength: number;
  bakeAmbient: number;
  bakeAmbientColor: string;
  bakeLights: BakeLightState[];
  lightmapResolution: 256 | 512 | 1024;
  lightmapAmbientOcclusion: boolean;
  lightmapAoSamples: 4 | 8;
  lightmapShadows: boolean;
  lightmapShadowSamples: 1 | 4 | 8;
  lightmapIndirectSamples: 0 | 2 | 4;
  lightmapDenoise: boolean;
  origin: "keep" | "center" | "ground";
  removeUnused: boolean;
}

export type BakeLightType = "directional" | "point";

export interface BakeLightState {
  id: string;
  name: string;
  type: BakeLightType;
  enabled: boolean;
  color: string;
  intensity: number;
  direction: [number, number, number];
  position: [number, number, number];
  range: number;
}

export interface BakeLightingOptions {
  strength: number;
  ambient: number;
  ambientColor: string;
  lights: BakeLightState[];
}

export const DEFAULT_BAKE_LIGHTS: BakeLightState[] = [{
  id: "bake-key",
  name: "主方向光",
  type: "directional",
  enabled: true,
  color: "#ffffff",
  intensity: 0.9,
  direction: [0.35, 0.82, 0.45],
  position: [4, 8, 4],
  range: 20
}];

export interface ModelFileStatistics {
  bytes: number;
  nodes: number;
  meshes: number;
  primitives: number;
  triangles: number;
  vertices: number;
  materials: number;
  textures: number;
}

export interface ModelOptimizationResult {
  binary: Uint8Array<ArrayBuffer>;
  before: ModelFileStatistics;
  after: ModelFileStatistics;
  lightmap?: WebLightmapResult;
}

export async function optimizeModelFile(
  file: File,
  options: ModelOptimizationOptions,
  onProgress?: (message: string) => void,
  copyright?: string,
): Promise<ModelOptimizationResult> {
  const io = await optimizerIO();
  onProgress?.("正在解析模型");
  const document = await readDocument(io, file);
  preserveOptimizationCredit(document, copyright);
  const before = statistics(document, file.size);
  await migrateLegacyMaterials(document);
  const transforms = [];
  if (options.removeUnused) transforms.push(dedup(), weld());
  if (options.simplifyEnabled && options.simplifyRatio < 0.999) {
    await MeshoptSimplifier.ready;
    transforms.push(simplify({
      simplifier: MeshoptSimplifier,
      ratio: Math.max(0.01, Math.min(1, options.simplifyRatio)),
      error: Math.max(0.000001, Math.min(1, options.simplifyError)),
      lockBorder: false
    }));
  }
  if (options.textureEnabled) {
    transforms.push(textureCompress({
      ...(options.textureFormat === "original" ? {} : { targetFormat: options.textureFormat }),
      resize: [options.textureSize, options.textureSize]
    }));
  }
  if (options.origin !== "keep") transforms.push(center({ pivot: options.origin === "ground" ? "below" : "center" }));
  if (options.removeUnused) transforms.push(prune({ keepAttributes: false, keepLeaves: false }));
  if (transforms.length > 0) {
    onProgress?.("正在执行几何与贴图优化");
    await document.transform(...transforms);
  }
  let lightmap: WebLightmapResult | undefined;
  if (options.bakeEnabled && options.bakeMode === "vertex") {
    onProgress?.("正在烘焙顶点光照");
    bakeVertexLighting(document, { strength: options.bakeStrength, ambient: options.bakeAmbient, ambientColor: options.bakeAmbientColor, lights: options.bakeLights });
  } else if (options.bakeEnabled) {
    onProgress?.("正在自动展开 UV2 光照图集");
    try {
      await unwrapLightmapUvs(document);
    } catch (reason) {
      console.warn("UV2 atlas unwrap failed; using browser projection fallback.", reason);
      onProgress?.("UV2 自动展开不可用，正在使用兼容图集");
    }
    lightmap = await bakeWebLightmap(document, {
      resolution: options.lightmapResolution,
      strength: options.bakeStrength,
      ambient: options.bakeAmbient,
      ambientColor: options.bakeAmbientColor,
      lights: options.bakeLights,
      ambientOcclusion: options.lightmapAmbientOcclusion,
      aoSamples: options.lightmapAoSamples,
      shadows: options.lightmapShadows,
      shadowSamples: options.lightmapShadowSamples,
      indirectSamples: options.lightmapIndirectSamples,
      denoise: options.lightmapDenoise
    }, onProgress);
  }
  if (options.dracoEnabled) {
    onProgress?.("正在执行 Draco 压缩");
    await document.transform(draco({
      method: "edgebreaker",
      encodeSpeed: 5,
      decodeSpeed: 5,
      quantizePosition: 16,
      quantizeNormal: 10,
      quantizeTexcoord: 14,
      quantizeColor: 8,
      quantizeGeneric: 12,
      quantizationVolume: "mesh"
    }));
  }
  onProgress?.("正在生成 GLB");
  const binary = await io.writeBinary(document);
  const validation = await io.readBinary(binary);
  return { binary, before, after: statistics(validation, binary.byteLength), ...(lightmap ? { lightmap } : {}) };
}

let watlasPromise: Promise<typeof import("watlas")> | undefined;

async function unwrapLightmapUvs(document: Document): Promise<void> {
  watlasPromise ??= import("watlas").then(async (watlas) => {
    await watlas.Initialize();
    return watlas;
  });
  const watlas = await watlasPromise;
  await document.transform(unwrap({ watlas, texcoord: 1, overwrite: true, groupBy: "scene" }));
}

export async function inspectModelFile(file: File): Promise<ModelFileStatistics> {
  const io = await optimizerIO();
  return statistics(await readDocument(io, file), file.size);
}

/**
 * Bakes lightweight, view-independent diffuse lighting into COLOR_0.
 * This intentionally avoids UV unwrapping and texture atlases, keeping the
 * operation fast enough for local browser use while preserving the result in GLB.
 * Point lights use mesh-local coordinates so the operation stays deterministic
 * for browser-side optimization without flattening or duplicating scene nodes.
 */
export function bakeVertexLighting(document: Document, options: BakeLightingOptions): void {
  const amount = clamp01(options.strength);
  if (amount <= 0) return;
  const ambient = clamp01(options.ambient);
  const ambientColor = hexToLinear(options.ambientColor);
  const lights = options.lights.filter((light) => light.enabled && light.intensity > 0).map((light) => ({
    ...light,
    colorLinear: hexToLinear(light.color),
    directionNormalized: normalize3(light.direction)
  }));
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer("Baked vertex lighting");
  const normalValue: number[] = [];
  const positionValue: number[] = [];
  const colorValue: number[] = [];

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      const normal = primitive.getAttribute("NORMAL");
      if (!position || !normal || position.getCount() !== normal.getCount()) continue;
      const sourceColor = primitive.getAttribute("COLOR_0");
      const colorSize = sourceColor?.getElementSize() === 4 ? 4 : 3;
      const colors = new Float32Array(position.getCount() * colorSize);
      for (let index = 0; index < position.getCount(); index += 1) {
        normal.getElement(index, normalValue);
        position.getElement(index, positionValue);
        const normalDirection = normalize3([normalValue[0] ?? 0, normalValue[1] ?? 0, normalValue[2] ?? 0]);
        const lighting: [number, number, number] = [ambient * ambientColor[0], ambient * ambientColor[1], ambient * ambientColor[2]];
        for (const light of lights) {
          let lightDirection = light.directionNormalized;
          let attenuation = 1;
          if (light.type === "point") {
            const delta: [number, number, number] = [
              light.position[0] - (positionValue[0] ?? 0),
              light.position[1] - (positionValue[1] ?? 0),
              light.position[2] - (positionValue[2] ?? 0)
            ];
            const distance = Math.hypot(...delta);
            lightDirection = normalize3(delta);
            const range = Math.max(0.001, light.range);
            attenuation = Math.pow(Math.max(0, 1 - distance / range), 2);
          }
          const diffuse = Math.max(0, dot3(normalDirection, lightDirection)) * light.intensity * attenuation;
          lighting[0] += light.colorLinear[0] * diffuse;
          lighting[1] += light.colorLinear[1] * diffuse;
          lighting[2] += light.colorLinear[2] * diffuse;
        }
        if (sourceColor) sourceColor.getElement(index, colorValue);
        else colorValue.splice(0, colorValue.length, 1, 1, 1);
        for (let channel = 0; channel < 3; channel += 1) {
          const baked = 1 - amount + amount * clamp01(lighting[channel] ?? ambient);
          colors[index * colorSize + channel] = clamp01((colorValue[channel] ?? 1) * baked);
        }
        if (colorSize === 4) colors[index * colorSize + 3] = clamp01(colorValue[3] ?? 1);
      }
      primitive.setAttribute("COLOR_0", document.createAccessor("Baked vertex lighting")
        .setType(colorSize === 4 ? "VEC4" : "VEC3")
        .setArray(colors)
        .setBuffer(buffer));
    }
  }
}

function dot3(left: [number, number, number], right: [number, number, number]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function hexToLinear(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  const hex = match?.[1] ?? "ffffff";
  return [0, 2, 4].map((offset) => srgbToLinear(Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)) as [number, number, number];
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function normalize3(value: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...value) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

async function readDocument(io: WebIO, file: File): Promise<Document> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.name.toLocaleLowerCase().endsWith(".glb")) {
    const jsonDocument = await io.binaryToJSON(bytes);
    repairInvalidSparseAccessors(jsonDocument.json);
    return await io.readJSON(jsonDocument);
  }
  const text = new TextDecoder().decode(bytes);
  const json = JSON.parse(text) as JSONDocument["json"];
  const externalResources = [
    ...(json.buffers ?? []).map((buffer) => buffer.uri),
    ...(json.images ?? []).map((image) => image.uri)
  ].filter((uri): uri is string => Boolean(uri && !uri.startsWith("data:")));
  if (externalResources.length > 0) {
    throw new Error(`该 glTF 依赖 ${externalResources.length} 个外部 .bin/贴图文件，请先转换为单文件 GLB`);
  }
  return await io.readJSON({ json, resources: {} });
}

/**
 * Some CAD/Revit conversion pipelines leave placeholder sparse declarations on
 * Draco accessors (count 0/-1 or greater than the accessor itself). They contain
 * no usable data and make strict glTF tooling crash before Draco is decoded.
 */
function repairInvalidSparseAccessors(json: JSONDocument["json"]): void {
  for (const accessor of json.accessors ?? []) {
    const sparse = accessor.sparse;
    if (!sparse) continue;
    const indexTypeValid = [5121, 5123, 5125].includes(sparse.indices.componentType);
    const indexBufferValid = Number.isInteger(sparse.indices.bufferView) && sparse.indices.bufferView >= 0 && sparse.indices.bufferView < (json.bufferViews?.length ?? 0);
    const valueBufferValid = Number.isInteger(sparse.values.bufferView) && sparse.values.bufferView >= 0 && sparse.values.bufferView < (json.bufferViews?.length ?? 0);
    if (!Number.isInteger(sparse.count) || sparse.count <= 0 || sparse.count > accessor.count || !indexTypeValid || !indexBufferValid || !valueBufferValid) delete accessor.sparse;
  }
}

function statistics(document: Document, bytes: number): ModelFileStatistics {
  const root = document.getRoot();
  let primitives = 0;
  let triangles = 0;
  let vertices = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitives += 1;
      const position = primitive.getAttribute("POSITION");
      const indices = primitive.getIndices();
      vertices += position?.getCount() ?? 0;
      triangles += Math.floor((indices?.getCount() ?? position?.getCount() ?? 0) / 3);
    }
  }
  return {
    bytes,
    nodes: root.listNodes().length,
    meshes: root.listMeshes().length,
    primitives,
    triangles,
    vertices,
    materials: root.listMaterials().length,
    textures: root.listTextures().length
  };
}
