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
  if (options.dracoEnabled) transforms.push(draco({
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
  if (transforms.length > 0) {
    onProgress?.("正在执行几何与贴图优化");
    await document.transform(...transforms);
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
