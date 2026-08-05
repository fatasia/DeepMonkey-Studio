import { WebIO, type Document, type JSONDocument } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { center, dedup, draco, prune, simplify, textureCompress, weld } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { MeshoptSimplifier } from "meshoptimizer";

export interface ModelOptimizationOptions {
  simplifyEnabled: boolean;
  simplifyRatio: number;
  simplifyError: number;
  dracoEnabled: boolean;
  textureEnabled: boolean;
  textureSize: number;
  textureFormat: "webp" | "jpeg" | "original";
  bakeEnabled: boolean;
  bakeStrength: number;
  origin: "keep" | "center" | "ground";
  removeUnused: boolean;
}

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
}

let ioPromise: Promise<WebIO> | undefined;

export async function optimizeModelFile(
  file: File,
  options: ModelOptimizationOptions,
  onProgress?: (message: string) => void
): Promise<ModelOptimizationResult> {
  const io = await optimizerIO();
  onProgress?.("正在解析模型");
  const document = await readDocument(io, file);
  const before = statistics(document, file.size);
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
  if (options.bakeEnabled) {
    onProgress?.("正在烘焙顶点光照");
    bakeVertexLighting(document, options.bakeStrength);
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
  return { binary, before, after: statistics(validation, binary.byteLength) };
}

export async function inspectModelFile(file: File): Promise<ModelFileStatistics> {
  const io = await optimizerIO();
  return statistics(await readDocument(io, file), file.size);
}

/**
 * Bakes a lightweight, view-independent hemisphere/key light into COLOR_0.
 * This intentionally avoids UV unwrapping and texture atlases, keeping the
 * operation fast enough for local browser use while preserving the result in GLB.
 */
export function bakeVertexLighting(document: Document, strength: number): void {
  const amount = Math.max(0, Math.min(1, strength));
  if (amount <= 0) return;
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer("Baked vertex lighting");
  const light = normalize3([0.35, 0.82, 0.45]);
  const normalValue: number[] = [];
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
        const nx = normalValue[0] ?? 0;
        const ny = normalValue[1] ?? 0;
        const nz = normalValue[2] ?? 0;
        const key = Math.max(0, nx * light[0] + ny * light[1] + nz * light[2]);
        const sky = 0.65 + 0.35 * Math.max(0, ny);
        const baked = 1 - amount + amount * Math.min(1, 0.32 + 0.68 * key * sky);
        if (sourceColor) sourceColor.getElement(index, colorValue);
        else colorValue.splice(0, colorValue.length, 1, 1, 1);
        colors[index * colorSize] = clamp01((colorValue[0] ?? 1) * baked);
        colors[index * colorSize + 1] = clamp01((colorValue[1] ?? 1) * baked);
        colors[index * colorSize + 2] = clamp01((colorValue[2] ?? 1) * baked);
        if (colorSize === 4) colors[index * colorSize + 3] = clamp01(colorValue[3] ?? 1);
      }
      primitive.setAttribute("COLOR_0", document.createAccessor("Baked vertex lighting")
        .setType(colorSize === 4 ? "VEC4" : "VEC3")
        .setArray(colors)
        .setBuffer(buffer));
    }
  }
}

function normalize3(value: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...value) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

async function optimizerIO(): Promise<WebIO> {
  ioPromise ??= Promise.all([
    loadWasm("draco_encoder.wasm"),
    loadWasm("draco_decoder_gltf.wasm")
  ]).then(async ([encoderWasm, decoderWasm]) => {
    const [encoder, decoder] = await Promise.all([
      draco3d.createEncoderModule({ wasmBinary: encoderWasm }),
      draco3d.createDecoderModule({ wasmBinary: decoderWasm })
    ]);
    return new WebIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ "draco3d.encoder": encoder, "draco3d.decoder": decoder });
  });
  return await ioPromise;
}

async function loadWasm(name: string): Promise<Uint8Array> {
  const response = await fetch(`${import.meta.env.BASE_URL}draco/${name}`);
  if (!response.ok) throw new Error(`Draco 资源加载失败：${name} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function readDocument(io: WebIO, file: File): Promise<Document> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.name.toLocaleLowerCase().endsWith(".glb")) return await io.readBinary(bytes);
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
