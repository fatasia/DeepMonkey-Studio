import { decodedLength } from "./deep2d.js";
import { bytesToBase64 } from "./dashboardVideoMedia.js";
import { integer, record, requireValue } from "./primitives.js";
import type { RenderPacket } from "../renderPacketTypes.js";

export const RUNTIME_TEXTURE_BYTE_LIMIT = 128 * 1024 * 1024;
// Preserve small historical packet wire bytes; large byte planes are single JSON strings.
const COMPACT_THRESHOLD = 64 * 1024;
export function compactRuntimePacketTextures<T extends Pick<RenderPacket, "textures">>(packet: T): T {
  if (!packet.textures) return packet;
  let total = 0;
  const plain = (value: unknown): void => {
    record(value, "$.textures");
    requireValue(Object.getOwnPropertySymbols(value as object).length === 0
      && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => "value" in field && field.enumerable),
    "$.textures", "Accessors, hidden and symbol texture fields are not JSON.");
  };
  for (const texture of packet.textures) {
    plain(texture);
    for (const level of [texture, ...texture.mipmaps ?? []]) {
      plain(level);
      const data = level.data;
      requireValue(data instanceof Uint8Array && data.buffer instanceof ArrayBuffer, "$.textures.data", "Expected unshared texture bytes.");
      total += data.byteLength;
      requireValue(total <= RUNTIME_TEXTURE_BYTE_LIMIT, "$.textures", "Texture data exceeds the 128 MiB packet budget.");
    }
  }
  const compact = (data: Uint8Array): Uint8Array | string => data.length < COMPACT_THRESHOLD ? data : bytesToBase64(data);
  return { ...packet, textures: packet.textures.map(texture => ({ ...texture, data: compact(texture.data),
    ...(texture.mipmaps ? { mipmaps: texture.mipmaps.map(level => ({ ...level, data: compact(level.data) })) } : {}),
  })) } as unknown as T;
}

/** Preflight the complete byte budget before allocating any decoded planes. */
export function validateRuntimeTexturePlaneBytes(level: Record<string, unknown>, path: string): number {
  const width = integer(level.width, 1, 16_384, `${path}.width`);
  const height = integer(level.height, 1, 16_384, `${path}.height`);
  const pitch = level.bytesPerRow === undefined ? width * 4
    : integer(level.bytesPerRow, width * 4, RUNTIME_TEXTURE_BYTE_LIMIT, `${path}.bytesPerRow`);
  const maximum = pitch * height, minimum = pitch * (height - 1) + width * 4;
  requireValue(minimum <= RUNTIME_TEXTURE_BYTE_LIMIT, path, "Texture data exceeds the 128 MiB packet budget.");
  if (typeof level.data === "string") {
    requireValue(level.data.length <= Math.ceil(Math.min(maximum,RUNTIME_TEXTURE_BYTE_LIMIT) / 3) * 4, `${path}.data`, "Texture byte length differs from dimensions.");
    const actual = decodedLength(level.data, `${path}.data`);
    requireValue(actual >= minimum && actual <= maximum, `${path}.data`, "Texture byte length differs from dimensions.");
    return actual;
  }
  return Array.isArray(level.data) ? level.data.length : maximum;
}

export function decodeRuntimeTextureBytes(value: string): Uint8Array {
  const decode = (Uint8Array as typeof Uint8Array & { fromBase64?: (text: string) => Uint8Array }).fromBase64;
  if (decode) return decode.call(Uint8Array, value);
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < bytes.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
