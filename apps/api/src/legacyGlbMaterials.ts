import { open, readFile } from "node:fs/promises";
import type { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { metalRough } from "@gltf-transform/functions";

const LEGACY = "KHR_materials_pbrSpecularGlossiness";
const supported = new Set(ALL_EXTENSIONS.map(extension => extension.EXTENSION_NAME));

/** 小模型只读 JSON chunk 判别；现代模型不初始化解码器或重写字节。 */
export async function hasLegacyGlbMaterials(filePath: string): Promise<boolean> {
  const file = await open(filePath, "r");
  try {
    const header = Buffer.alloc(20);
    if ((await file.read(header, 0, 20, 0)).bytesRead !== 20 || header.readUInt32LE(0) !== 0x46546c67 || header.readUInt32LE(16) !== 0x4e4f534a) return false;
    const length = header.readUInt32LE(12);
    if (length > (await file.stat()).size - 20) throw new Error("GLB JSON chunk 超出文件长度。");
    const bytes = Buffer.alloc(length);
    if ((await file.read(bytes, 0, length, 20)).bytesRead !== length) throw new Error("GLB JSON chunk 不完整。");
    const json = JSON.parse(bytes.toString("utf8"));
    return Array.isArray(json.materials) && json.materials.some((material: { extensions?: Record<string, unknown> }) => Boolean(material?.extensions?.[LEGACY]));
  } finally { await file.close(); }
}

/** 任何重写前拒绝未知扩展，避免 NodeIO 丢掉不认识的可选扩展。 */
export async function readTransformableGlb(io: NodeIO, filePath: string): Promise<Document> {
  const source = await io.binaryToJSON(new Uint8Array(await readFile(filePath)));
  const unknown = [...new Set([...(source.json.extensionsUsed ?? []), ...(source.json.extensionsRequired ?? [])])].filter(name => !supported.has(name));
  if (unknown.length) throw new Error(`GLB 转换不支持扩展：${unknown.join(", ")}`);
  const document = await io.readJSON(source);
  if (document.getRoot().listExtensionsUsed().some(extension => extension.extensionName === LEGACY)) await document.transform(metalRough());
  return document;
}
