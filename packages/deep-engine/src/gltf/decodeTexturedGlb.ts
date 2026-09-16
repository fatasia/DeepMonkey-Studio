import type { RenderPacket } from "../renderPacket.js";
import { decodeTexturedGltf, type TexturedGltfImportOptions } from "./decodeTexturedGltf.js";
import { parseGlb } from "./parseGlb.js";
import type { GltfImageDecoder } from "./textureTypes.js";
import { object } from "./validation.js";

export interface TexturedGlbImportOptions extends TexturedGltfImportOptions {}

/** 静态 PBR 纹理 GLB 导入；PNG/JPEG 解码由宿主注入，纯 KTX2 包可省略解码器。 */
export async function decodeTexturedGlb(bytes: Uint8Array, imageDecoder: GltfImageDecoder | undefined,
  options: TexturedGlbImportOptions = {}): Promise<RenderPacket> {
  object(options, "options"); options.signal?.throwIfAborted();
  const parsed = parseGlb(bytes);
  return await decodeTexturedGltf(parsed.json, parsed.buffers, imageDecoder, options);
}
