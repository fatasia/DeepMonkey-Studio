import type { Document, JSONDocument, WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { metalRough } from "@gltf-transform/functions";
import { LEGACY_SPEC_GLOSS } from "../viewer/gltfLegacyMaterialDetection";
import { optimizerIO } from "./modelOptimizerIO";

/** Official glTF-Transform migration, including diffuse/specular textures and gloss alpha inversion. */
export async function migrateLegacyMaterials(document: Document): Promise<Document> {
  if (document.getRoot().listExtensionsUsed().some(extension => extension.extensionName === LEGACY_SPEC_GLOSS)) {
    await document.transform(metalRough());
  }
  return document;
}

export async function legacyGltfForRendering(
  data: ArrayBuffer | string,
  loadResource: (uri: string) => Promise<ArrayBuffer>,
  providedIO?: WebIO,
): Promise<ArrayBuffer> {
  const io = providedIO ?? await optimizerIO();
  const binary = typeof data !== "string" && data.byteLength >= 4 && new DataView(data).getUint32(0, true) === 0x46546c67;
  const jsonDocument: JSONDocument = binary
    ? await io.binaryToJSON(new Uint8Array(data as ArrayBuffer))
    : { json: JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as JSONDocument["json"], resources: {} };
  // A compatibility conversion must not silently discard unrelated unsupported extensions.
  const supported = new Set(ALL_EXTENSIONS.map(extension => extension.EXTENSION_NAME));
  const unknown = (jsonDocument.json.extensionsUsed ?? []).filter(name => !supported.has(name));
  if (unknown.length) throw new Error(`旧材质转换遇到未支持的扩展：${unknown.join(", ")}`);
  const uris = new Set([
    ...(jsonDocument.json.buffers ?? []).map(item => item.uri),
    ...(jsonDocument.json.images ?? []).map(item => item.uri),
  ].filter((uri): uri is string => Boolean(uri && !uri.startsWith("data:") && !jsonDocument.resources[uri])));
  await Promise.all([...uris].map(async uri => { jsonDocument.resources[uri] = new Uint8Array(await loadResource(uri)); }));
  const document = await migrateLegacyMaterials(await io.readJSON(jsonDocument));
  // Valid texture-only glTF has no geometry buffer, but embedding its images in GLB needs one.
  if (!document.getRoot().listBuffers().length && document.getRoot().listTextures().length) document.createBuffer();
  const output = await io.writeBinary(document);
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
}
