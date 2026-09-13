import type { RenderPacket } from "../renderPacket.js";
import { decodeGltf, type GltfImportOptions } from "./decodeGltf.js";
import { parseGlb } from "./parseGlb.js";

/** GLB 2.0 的单个内嵌 BIN 子集；外部多 buffer 请用 decodeGltf 并显式提供字节。 */
export function decodeGlb(bytes: Uint8Array, options: GltfImportOptions = {}): RenderPacket {
  const parsed = parseGlb(bytes);
  return decodeGltf(parsed.json, parsed.buffers, options);
}
