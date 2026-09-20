import { isPbrFrameReadbackSnapshot, type PbrFrameReadbackSnapshot } from "@bim-studio/deep-engine";

export interface FrameReadbackExportFormat {
  readonly label: string;
  readonly hdr: boolean;
}

const EXPORTABLE_FORMATS: Readonly<Record<string, FrameReadbackExportFormat>> = Object.freeze({
  "rgba8unorm": { label: "RGBA8", hdr: false },
  "rgba8unorm-srgb": { label: "RGBA8 sRGB", hdr: false },
  "bgra8unorm": { label: "BGRA8", hdr: false },
  "bgra8unorm-srgb": { label: "BGRA8 sRGB", hdr: false },
  "rgba16float": { label: "RGBA16F", hdr: true },
  "rgba32float": { label: "RGBA32F", hdr: true },
  "r32float": { label: "R32F depth", hdr: true },
});

export function frameReadbackExportFormat(result: PbrFrameReadbackSnapshot): FrameReadbackExportFormat | undefined {
  return EXPORTABLE_FORMATS[result.format];
}

function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/** Reinhard per-channel tonemap; diagnostic preview only, never a match for the renderer's ACES path. */
function tonemap(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(0, value);
  return Math.round(clamped / (1 + clamped) * 255);
}

/** Produces canvas-ready RGBA8 pixels; returns undefined for formats this diagnostic export does not cover. */
export function frameReadbackPixelsRgba8(result: PbrFrameReadbackSnapshot): Uint8ClampedArray<ArrayBuffer> | undefined {
  if (!isPbrFrameReadbackSnapshot(result)) return undefined;
  const format = EXPORTABLE_FORMATS[result.format];
  if (format === undefined) return undefined;
  const pixels = new Uint8ClampedArray(new ArrayBuffer(result.width * result.height * 4));
  const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
  if (result.format === "r32float") {
    // 线性深度单通道 → 灰度：按本快照最大深度归一（远=亮），诊断读图用，不做任何逆投影。
    let maxDepth = 0;
    for (let pixel = 0; pixel < result.width * result.height; pixel++) {
      const depth = view.getFloat32(pixel * 4, true);
      if (Number.isFinite(depth) && depth > maxDepth) maxDepth = depth;
    }
    for (let pixel = 0; pixel < result.width * result.height; pixel++) {
      const raw = view.getFloat32(pixel * 4, true);
      const value = Number.isFinite(raw) ? Math.round(clamp01(raw / Math.max(maxDepth, 1e-9)) * 255) : 0;
      const out = pixel * 4;
      pixels[out] = value; pixels[out + 1] = value; pixels[out + 2] = value; pixels[out + 3] = 255;
    }
    return pixels;
  }
  for (let pixel = 0; pixel < result.width * result.height; pixel++) {
    const out = pixel * 4;
    if (format.hdr) {
      const componentBytes = result.format === "rgba16float" ? 2 : 4;
      const offset = pixel * 4 * componentBytes;
      for (let channel = 0; channel < 3; channel++) {
        const value = componentBytes === 2
          ? halfToFloat(view.getUint16(offset + channel * 2, true))
          : view.getFloat32(offset + channel * 4, true);
        pixels[out + channel] = tonemap(value);
      }
      pixels[out + 3] = 255;
    } else {
      const offset = pixel * 4;
      const isBgra = result.format.startsWith("bgra");
      pixels[out] = result.bytes[offset + (isBgra ? 2 : 0)]!;
      pixels[out + 1] = result.bytes[offset + 1]!;
      pixels[out + 2] = result.bytes[offset + (isBgra ? 0 : 2)]!;
      pixels[out + 3] = result.bytes[offset + 3]!;
    }
  }
  return pixels;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export async function frameReadbackPngBlob(result: PbrFrameReadbackSnapshot): Promise<Blob | undefined> {
  const pixels = frameReadbackPixelsRgba8(result);
  if (pixels === undefined || typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = result.width;
  canvas.height = result.height;
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  context.putImageData(new ImageData(pixels, result.width, result.height), 0, 0);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  return blob ?? undefined;
}
