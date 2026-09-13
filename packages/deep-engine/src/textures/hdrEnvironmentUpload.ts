import type { RadianceHdrImage } from "./radianceHdr.js";

export interface HdrEnvironmentUpload {
  readonly width: number;
  readonly height: number;
  /** WebGPU COPY_BYTES_PER_ROW_ALIGNMENT compatible RGBA16F rows. */
  readonly bytesPerRow: number;
  readonly data: Uint16Array<ArrayBuffer>;
  readonly clampedChannels: number;
}

export interface HdrEnvironmentUploadOptions {
  readonly maxDimension?: number;
  readonly maxBytes?: number;
  readonly maxRadiance?: number;
}

const MAX_HALF_FLOAT = 65_504;
const MAX_DIMENSION = 16_384;
const MAX_BYTES = 512 * 1024 * 1024;

function integerLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`Invalid HDR environment ${name}.`);
  }
  return resolved;
}

function createHalfConverter(): (value: number) => number {
  const storage = new ArrayBuffer(4), floats = new Float32Array(storage), integers = new Uint32Array(storage);
  return (value: number): number => {
    floats[0] = value;
    const bits = integers[0]!, exponent = (bits >>> 23) & 0xff;
    let mantissa = (bits >>> 12) & 0x7ff, result = (bits >>> 16) & 0x8000;
    if (exponent < 103) return result;
    if (exponent < 113) {
      mantissa |= 0x800;
      result |= (mantissa >>> (114 - exponent)) + ((mantissa >>> (113 - exponent)) & 1);
      return result;
    }
    if (exponent > 142) return result | 0x7c00;
    result |= (exponent - 112) << 10;
    result |= mantissa >>> 1;
    return result + (mantissa & 1);
  };
}

/** Packs owned linear RGB float pixels into aligned, finite RGBA16F upload rows. */
export function prepareHdrEnvironmentUpload(image: RadianceHdrImage,
  options: HdrEnvironmentUploadOptions = {}): HdrEnvironmentUpload {
  if (!image || typeof image !== "object" || Array.isArray(image)) throw new Error("Invalid HDR environment image.");
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Invalid HDR environment upload options.");
  const maxDimension = integerLimit(options.maxDimension, MAX_DIMENSION, MAX_DIMENSION, "dimension limit");
  const maxBytes = integerLimit(options.maxBytes, MAX_BYTES, MAX_BYTES, "byte limit");
  if (!Number.isSafeInteger(image.width) || image.width < 1 || image.width > maxDimension
    || !Number.isSafeInteger(image.height) || image.height < 1 || image.height > maxDimension) {
    throw new Error("HDR environment dimensions exceed limits.");
  }
  if (!(image.data instanceof Float32Array) || !(image.data.buffer instanceof ArrayBuffer)
    || image.data.byteLength !== image.width * image.height * 3 * 4) {
    throw new Error("HDR environment requires exact owned RGB32F pixels.");
  }
  const maxRadiance = options.maxRadiance ?? MAX_HALF_FLOAT;
  if (!Number.isFinite(maxRadiance) || maxRadiance <= 0 || maxRadiance > MAX_HALF_FLOAT) {
    throw new Error("Invalid HDR environment radiance limit.");
  }
  const bytesPerRow = Math.ceil(image.width * 8 / 256) * 256;
  const byteLength = bytesPerRow * image.height;
  if (!Number.isSafeInteger(byteLength) || byteLength > maxBytes) throw new Error("HDR environment upload exceeds byte limit.");
  const output = new Uint16Array(byteLength / 2), toHalf = createHalfConverter();
  const alpha = toHalf(1);
  let clampedChannels = 0;
  for (let y = 0; y < image.height; y++) {
    let source = y * image.width * 3, destination = y * bytesPerRow / 2;
    for (let x = 0; x < image.width; x++, source += 3, destination += 4) {
      for (let channel = 0; channel < 3; channel++) {
        const value = image.data[source + channel]!;
        if (!Number.isFinite(value) || value < 0) throw new Error("HDR environment contains invalid radiance.");
        if (value > maxRadiance) clampedChannels++;
        output[destination + channel] = toHalf(Math.min(value, maxRadiance));
      }
      output[destination + 3] = alpha;
    }
  }
  return Object.freeze({ width: image.width, height: image.height, bytesPerRow, data: output, clampedChannels });
}
