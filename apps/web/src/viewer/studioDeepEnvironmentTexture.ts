import * as THREE from "three";
import type { PbrEnvironmentSource } from "@bim-studio/deep-engine/webgpu";

export interface StudioEnvironmentTextureIdentity {
  readonly texture: THREE.Texture;
  readonly source: THREE.Texture["source"];
  readonly image: unknown;
  readonly version: number;
  readonly sourceVersion: number;
  readonly mapping: THREE.Texture["mapping"];
  readonly flipY: boolean;
  readonly colorSpace: string;
  readonly type: THREE.TextureDataType;
  readonly format: THREE.Texture["format"];
  readonly premultiplyAlpha: boolean;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly pixels: unknown;
}

export function captureStudioEnvironmentTexture(texture: THREE.Texture): StudioEnvironmentTextureIdentity {
  const image = texture.image as { width?: number; height?: number; naturalWidth?: number;
    naturalHeight?: number; data?: unknown } | null;
  return { texture, source: texture.source, image: texture.image, version: texture.version,
    sourceVersion: texture.source.version, mapping: texture.mapping, flipY: texture.flipY,
    colorSpace: texture.colorSpace, type: texture.type, format: texture.format,
    premultiplyAlpha: texture.premultiplyAlpha, width: image?.naturalWidth ?? image?.width,
    height: image?.naturalHeight ?? image?.height, pixels: image?.data };
}

export function isStudioEnvironmentTextureCurrent(identity: StudioEnvironmentTextureIdentity): boolean {
  const next = captureStudioEnvironmentTexture(identity.texture);
  return (Object.keys(identity) as (keyof StudioEnvironmentTextureIdentity)[])
    .every(key => identity[key] === next[key]);
}

export interface StudioEnvironmentTextureOptions {
  readonly signal?: AbortSignal;
  readonly maxDimension?: number;
  /** Output RGB32F plus temporary RGBA8 readback; excludes caller-owned source. */
  readonly maxBytes?: number;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("环境转换已取消。", "AbortError");
}

function limits(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > fallback) throw new Error("环境转换预算无效。");
  return result;
}

function readImage(image: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  } catch {
    // 不透传可能包含资源 URL 的浏览器异常。
    throw new Error("无法读取当前环境图片；请检查图片解码状态和跨域读取权限。");
  } finally { canvas.width = 0; canvas.height = 0; }
}

export interface PreparedStudioEnvironmentTexture {
  readonly source: PbrEnvironmentSource;
  readonly identity: StudioEnvironmentTextureIdentity;
}

/** Converts the currently resolved author texture; never fetches or mutates its source. */
export function prepareStudioEnvironmentTexture(texture: THREE.Texture,
  options: StudioEnvironmentTextureOptions = {}): PreparedStudioEnvironmentTexture {
  const conversion = convertEnvironmentTexture(texture, options);
  let step = conversion.next();
  while (!step.done) step = conversion.next();
  return step.value;
}

/** Yields to input/cancellation between bounded pixel batches during candidate preparation. */
export async function prepareStudioEnvironmentTextureAsync(texture: THREE.Texture,
  options: StudioEnvironmentTextureOptions = {}): Promise<PreparedStudioEnvironmentTexture> {
  checkAbort(options.signal);
  const identity = captureStudioEnvironmentTexture(texture);
  await yieldForEnvironmentInput(options.signal);
  assertCurrent(identity);
  const conversion = convertEnvironmentTexture(texture, options);
  let step = conversion.next();
  while (!step.done) {
    await yieldForEnvironmentInput(options.signal);
    step = conversion.next();
  }
  return step.value;
}

function yieldForEnvironmentInput(signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(new DOMException("环境转换已取消。", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, 0);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function assertCurrent(identity: StudioEnvironmentTextureIdentity): void {
  if (!isStudioEnvironmentTextureCurrent(identity)) throw new Error("环境源在转换期间变化，请重新准备。");
}

function* convertEnvironmentTexture(texture: THREE.Texture,
  options: StudioEnvironmentTextureOptions): Generator<void, PreparedStudioEnvironmentTexture> {
  checkAbort(options.signal);
  const identity = captureStudioEnvironmentTexture(texture);
  if (texture.mapping !== THREE.EquirectangularReflectionMapping) throw new Error("环境需要等距柱状反射贴图。");
  if (texture.format !== THREE.RGBAFormat) throw new Error("环境仅支持 RGBA 源格式。");
  if (texture.colorSpace !== THREE.LinearSRGBColorSpace && texture.colorSpace !== THREE.SRGBColorSpace) {
    throw new Error("环境需要明确的 linear-sRGB 或 sRGB 色彩空间。");
  }
  if (texture.premultiplyAlpha) throw new Error("环境不支持预乘透明度。");
  const image = texture.image as { width?: number; height?: number; naturalWidth?: number;
    naturalHeight?: number; data?: unknown } | null;
  const width = image?.naturalWidth ?? image?.width ?? 0;
  const height = image?.naturalHeight ?? image?.height ?? 0;
  const maxDimension = limits(options.maxDimension, 16_384);
  const maxBytes = limits(options.maxBytes, 256 * 1024 * 1024);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > maxDimension || height > maxDimension) throw new Error("环境图片未解码或尺寸超出预算。");
  const dataTexture = texture instanceof THREE.DataTexture;
  if (width * height * (dataTexture ? 12 : 16) > maxBytes) throw new Error("环境转换内存超出预算。");
  let pixels: Float32Array | Uint16Array | Uint8Array | Uint8ClampedArray;
  if (dataTexture) {
    const data = image?.data;
    if (texture.type === THREE.HalfFloatType && data instanceof Uint16Array
      || texture.type === THREE.FloatType && data instanceof Float32Array
      || texture.type === THREE.UnsignedByteType && (data instanceof Uint8Array || data instanceof Uint8ClampedArray)) {
      pixels = data as typeof pixels;
    } else throw new Error("环境像素类型与纹理声明不匹配。");
    if (pixels.length !== width * height * 4 || !(pixels.buffer instanceof ArrayBuffer)) {
      throw new Error("环境需要完整且非共享的 RGBA 像素。");
    }
  } else {
    if (texture.type !== THREE.UnsignedByteType || texture.colorSpace !== THREE.SRGBColorSpace) {
      throw new Error("浏览器环境图片读取仅支持 sRGB 无符号字节源。");
    }
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) {
      throw new Error("ImageBitmap 环境需显式解码朝向后再接入。");
    }
    pixels = readImage(texture.image as CanvasImageSource, width, height);
  }
  checkAbort(options.signal);
  const output = new Float32Array(width * height * 3);
  const color = new THREE.Color();
  const batchPixels = 16_384;
  let processed = 0;
  const scalar = (offset: number): number => texture.type === THREE.HalfFloatType
    ? THREE.DataUtils.fromHalfFloat(pixels[offset]!)
    : texture.type === THREE.UnsignedByteType ? pixels[offset]! / 255 : pixels[offset]!;
  for (let y = 0; y < height; y++) {
    checkAbort(options.signal);
    // Three equirectUv 将北极放在 v=1；Deep 输入北极为首行(v=0)。
    const sourceY = texture.flipY ? y : height - y - 1;
    for (let x = 0; x < width; x++) {
      const input = (sourceY * width + x) * 4, destination = (y * width + x) * 3;
      const r = scalar(input), g = scalar(input + 1), b = scalar(input + 2), alpha = scalar(input + 3);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)
        || r < 0 || g < 0 || b < 0 || alpha !== 1) {
        throw new Error("环境包含非法辐射值或非不透明像素。");
      }
      color.r = r; color.g = g; color.b = b;
      if (texture.colorSpace === THREE.SRGBColorSpace) color.convertSRGBToLinear();
      output[destination] = color.r; output[destination + 1] = color.g; output[destination + 2] = color.b;
      if (!Number.isFinite(output[destination]) || !Number.isFinite(output[destination + 1])
        || !Number.isFinite(output[destination + 2])) {
        throw new Error("环境线性辐射超出 RGB32F 范围。");
      }
      if (++processed % batchPixels === 0) {
        yield;
        checkAbort(options.signal);
        assertCurrent(identity);
      }
    }
  }
  checkAbort(options.signal);
  assertCurrent(identity);
  return { source: { kind: "radiance-hdr", image: { width, height, data: output } }, identity };
}
