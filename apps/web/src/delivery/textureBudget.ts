import { parseGlb, type GltfDecodedImage, type GltfImageDecoder } from "@bim-studio/deep-engine/gltf";
import type { CappedImageDecoder } from "./imageWorkerDecoder";

const LADDER = [8192, 4096, 2048, 1024, 512, 256] as const;

/** 读 GLB 内嵌 PNG/JPEG 的尺寸(只读文件头,不解码);无法识别的图片不计入。 */
export function glbEmbeddedImageDimensions(glb: Uint8Array): readonly (readonly [number, number])[] {
  const { json, buffers } = parseGlb(glb);
  const document = json as { images?: { bufferView?: number }[]; bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number }[] };
  const result: [number, number][] = [];
  for (const image of document.images ?? []) {
    const view = image.bufferView === undefined ? undefined : document.bufferViews?.[image.bufferView];
    const buffer = view ? buffers[view.buffer ?? 0] : undefined;
    if (!view || !buffer) continue;
    const size = encodedImageSize(buffer.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + (view.byteLength ?? 0)));
    if (size) result.push(size);
  }
  return result;
}

function encodedImageSize(data: Uint8Array): [number, number] | undefined {
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let cursor = 2;
    while (cursor + 9 < data.length) {
      if (data[cursor] !== 0xff) { cursor++; continue; }
      const marker = data[cursor + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { cursor += 2; continue; }
      const length = (data[cursor + 2]! << 8) | data[cursor + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return [(data[cursor + 7]! << 8) | data[cursor + 8]!, (data[cursor + 5]! << 8) | data[cursor + 6]!];
      }
      cursor += 2 + length;
    }
  }
  return undefined;
}

/**
 * 单个资产的纹理解码总预算内,每张图允许的最大边长。图片少/小则返回 undefined(无需降采样,
 * 画质与既有路径逐字节一致);只在"原尺寸总和超预算"时才返回 2 的幂上限。
 */
export function textureDimensionCap(imageDimensions: readonly (readonly [number, number])[], budgetBytes: number): number | undefined {
  if (!imageDimensions.length) return undefined;
  const total = imageDimensions.reduce((sum, [width, height]) => sum + width * height * 4, 0);
  if (total <= budgetBytes) return undefined;
  for (const cap of LADDER) {
    const bytes = imageDimensions.reduce((sum, [width, height]) =>
      sum + Math.min(width, cap) * Math.min(height, cap) * 4, 0);
    if (bytes <= budgetBytes) return cap;
  }
  return LADDER[LADDER.length - 1]!;
}

/** 包装解码器:边长超过 cap 的图以 2x2 盒式滤波逐级减半,直到不超过 cap。 */
export function capImageDimension(decoder: GltfImageDecoder, cap: number): GltfImageDecoder {
  return {
    async decode(image, signal) {
      const capped = (decoder as CappedImageDecoder).decodeCapped;
      if (capped) return capped.call(decoder, image, cap, signal);
      let decoded = await decoder.decode(image, signal);
      while (Math.max(decoded.width, decoded.height) > cap && Math.max(decoded.width, decoded.height) > 1) {
        signal?.throwIfAborted();
        decoded = halve(decoded);
      }
      return decoded;
    },
  };
}

function halve(source: GltfDecodedImage): GltfDecodedImage {
  const { width, height } = source, pitch = source.bytesPerRow ?? width * 4;
  const nextWidth = Math.max(1, width >> 1), nextHeight = Math.max(1, height >> 1);
  const output = new Uint8Array(nextWidth * nextHeight * 4), data = source.data;
  for (let y = 0; y < nextHeight; y++) {
    const y0 = Math.min(height - 1, y * 2) * pitch, y1 = Math.min(height - 1, y * 2 + 1) * pitch;
    for (let x = 0; x < nextWidth; x++) {
      const x0 = Math.min(width - 1, x * 2) * 4, x1 = Math.min(width - 1, x * 2 + 1) * 4, target = (y * nextWidth + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        output[target + channel] = (data[y0 + x0 + channel]! + data[y0 + x1 + channel]!
          + data[y1 + x0 + channel]! + data[y1 + x1 + channel]! + 2) >> 2;
      }
    }
  }
  return { width: nextWidth, height: nextHeight, data: output, bytesPerRow: nextWidth * 4 };
}
