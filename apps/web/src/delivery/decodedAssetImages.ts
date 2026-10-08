import { parseGlb, type GltfImageDecoder } from "@bim-studio/deep-engine/gltf";
import type { RenderPacket } from "@bim-studio/deep-engine";

/** Reuse pixels across live/baked poses only after the caller matches asset bytes and decode profile. */
export function decodedAssetImageDecoder(bytes: Uint8Array, packet: RenderPacket,
  resourcePrefix: string, fallback: GltfImageDecoder): GltfImageDecoder {
  const { json } = parseGlb(bytes);
  const textures = (json as { textures?: { source?: number; extensions?: unknown }[] }).textures ?? [];
  const pixels = new Map<number, NonNullable<RenderPacket["textures"]>[number]>();
  for (const [index, texture] of textures.entries()) {
    // Extension transcoders can choose a different image or color-space payload.
    if (texture.extensions || !Number.isSafeInteger(texture.source)) continue;
    const prefix = `${resourcePrefix}/texture/${index}/`;
    const source = packet.textures?.find(value => value.id.startsWith(prefix) && !value.compression);
    if (source) pixels.set(texture.source!, source);
  }
  return { decode(image, signal) {
    signal?.throwIfAborted();
    const source = pixels.get(image.imageIndex);
    // The importer takes its own checked snapshot, so these retained bytes stay immutable.
    return source ? Promise.resolve({ width: source.width, height: source.height, data: source.data,
      ...(source.bytesPerRow === undefined ? {} : { bytesPerRow: source.bytesPerRow }) }) : fallback.decode(image, signal);
  } };
}
