import type { GltfTextureMimeType } from "./textureTypes.js";
import { budget, invalid, unsupported } from "./validation.js";

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : 63;
}

/** 解析 glTF 内嵌 PNG/JPEG 与 KHR_texture_basisu 所需的无 IO Data URI 子集。 */
export function decodeImageDataUri(uri: string, path: string, remainingBytes: number,
  signal?: AbortSignal): Readonly<{ mimeType: GltfTextureMimeType; data: Uint8Array<ArrayBuffer> }> {
  signal?.throwIfAborted();
  const comma = uri.indexOf(","), header = comma < 0 ? uri : uri.slice(0, comma);
  const match = /^data:(image\/png|image\/jpeg|image\/ktx2);base64$/iu.exec(header);
  if (!match) {
    if (!/^data:/iu.test(uri)) unsupported(path, "external image URI");
    unsupported(path, "image Data URI media type or encoding");
  }
  const payload = uri.slice(comma + 1);
  if (!payload.length || payload.length % 4 !== 0) invalid(path, "Image Data URI contains invalid base64.");
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const byteLength = payload.length / 4 * 3 - padding;
  budget(byteLength, remainingBytes, "images");
  if (!BASE64.test(payload)) invalid(path, "Image Data URI contains invalid base64.");
  const data = new Uint8Array(byteLength);
  let target = 0;
  for (let offset = 0; offset < payload.length; offset += 4) {
    if ((offset & 0x3fff) === 0) signal?.throwIfAborted();
    const a = sextet(payload.charCodeAt(offset)), b = sextet(payload.charCodeAt(offset + 1));
    const c = payload[offset + 2] === "=" ? 0 : sextet(payload.charCodeAt(offset + 2));
    const d = payload[offset + 3] === "=" ? 0 : sextet(payload.charCodeAt(offset + 3));
    data[target++] = a << 2 | b >> 4;
    if (target < byteLength) data[target++] = (b & 15) << 4 | c >> 2;
    if (target < byteLength) data[target++] = (c & 3) << 6 | d;
  }
  return { mimeType: match[1]!.toLowerCase() as GltfTextureMimeType, data };
}
