export interface RadianceHdrImage {
  readonly width: number;
  readonly height: number;
  /** Linear-sRGB RGB texels in top-left, row-major order. */
  readonly data: Float32Array<ArrayBuffer>;
}

export interface RadianceHdrDecodeOptions {
  readonly maxDimension?: number;
  readonly maxPixels?: number;
}

interface ResolutionAxis { readonly name: "X" | "Y"; readonly sign: "+" | "-"; readonly length: number }

const DEFAULT_MAX_DIMENSION = 16_384;
const DEFAULT_MAX_PIXELS = 64 * 1024 * 1024;

class ByteReader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  byte(message = "Radiance HDR payload is truncated."): number {
    if (this.offset >= this.bytes.length) throw new Error(message);
    return this.bytes[this.offset++]!;
  }
  line(): string {
    const start = this.offset;
    while (this.offset < this.bytes.length && this.bytes[this.offset] !== 0x0a) this.offset++;
    if (this.offset >= this.bytes.length) throw new Error("Radiance HDR header is truncated.");
    if (this.offset - start > 4096) throw new Error("Radiance HDR header line is too long.");
    const end = this.offset > start && this.bytes[this.offset - 1] === 0x0d ? this.offset - 1 : this.offset;
    this.offset++;
    let result = "";
    for (let index = start; index < end; index++) {
      const value = this.bytes[index]!;
      if (value < 0x20 || value > 0x7e) throw new Error("Radiance HDR header is not ASCII.");
      result += String.fromCharCode(value);
    }
    return result;
  }
}

function limit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`Invalid Radiance HDR ${name}.`);
  }
  return resolved;
}

function parseResolution(line: string, maxDimension: number, maxPixels: number): readonly [ResolutionAxis, ResolutionAxis] {
  const match = /^([+-])([XY])\s+(\d+)\s+([+-])([XY])\s+(\d+)$/.exec(line);
  if (!match || match[2] === match[5]) throw new Error("Radiance HDR resolution is invalid.");
  const firstLength = Number(match[3]), secondLength = Number(match[6]);
  if (!Number.isSafeInteger(firstLength) || firstLength < 1 || firstLength > maxDimension
    || !Number.isSafeInteger(secondLength) || secondLength < 1 || secondLength > maxDimension
    || firstLength * secondLength > maxPixels) throw new Error("Radiance HDR dimensions exceed limits.");
  return [
    { sign: match[1] as "+" | "-", name: match[2] as "X" | "Y", length: firstLength },
    { sign: match[4] as "+" | "-", name: match[5] as "X" | "Y", length: secondLength },
  ];
}

function coordinate(axis: ResolutionAxis, index: number): number {
  if (axis.name === "X") return axis.sign === "+" ? index : axis.length - 1 - index;
  return axis.sign === "-" ? index : axis.length - 1 - index;
}

function writePixel(output: Float32Array, width: number, first: ResolutionAxis, second: ResolutionAxis,
  scanline: number, pixel: number, red: number, green: number, blue: number, exponent: number): void {
  const firstCoordinate = coordinate(first, scanline), secondCoordinate = coordinate(second, pixel);
  const x = first.name === "X" ? firstCoordinate : secondCoordinate;
  const y = first.name === "Y" ? firstCoordinate : secondCoordinate;
  const destination = (y * width + x) * 3;
  if (exponent === 0) {
    output[destination] = 0; output[destination + 1] = 0; output[destination + 2] = 0;
    return;
  }
  const scale = 2 ** (exponent - 136);
  output[destination] = red * scale;
  output[destination + 1] = green * scale;
  output[destination + 2] = blue * scale;
}

function decodeModernScanline(reader: ByteReader, length: number, header: readonly number[]): Uint8Array {
  if (header[2]! * 256 + header[3]! !== length) throw new Error("Radiance HDR scanline width is inconsistent.");
  const channels = new Uint8Array(length * 4);
  for (let channel = 0; channel < 4; channel++) {
    let written = 0;
    while (written < length) {
      const code = reader.byte();
      if (code === 0) throw new Error("Radiance HDR RLE packet is invalid.");
      if (code > 128) {
        const count = code - 128, value = reader.byte();
        if (written + count > length) throw new Error("Radiance HDR RLE run exceeds its scanline.");
        channels.fill(value, channel * length + written, channel * length + written + count);
        written += count;
      } else {
        if (written + code > length) throw new Error("Radiance HDR RLE literal exceeds its scanline.");
        for (let index = 0; index < code; index++) channels[channel * length + written++] = reader.byte();
      }
    }
  }
  return channels;
}

function decodeModern(reader: ByteReader, output: Float32Array, width: number,
  first: ResolutionAxis, second: ResolutionAxis, initial: readonly number[]): void {
  const length = second.length;
  for (let scanline = 0; scanline < first.length; scanline++) {
    const header = scanline === 0 ? initial : [reader.byte(), reader.byte(), reader.byte(), reader.byte()];
    if (header[0] !== 2 || header[1] !== 2 || (header[2]! & 0x80) !== 0) {
      throw new Error("Radiance HDR mixes modern RLE and flat scanlines.");
    }
    const channels = decodeModernScanline(reader, length, header);
    for (let pixel = 0; pixel < length; pixel++) writePixel(output, width, first, second, scanline, pixel,
      channels[pixel]!, channels[length + pixel]!, channels[length * 2 + pixel]!, channels[length * 3 + pixel]!);
  }
}

function decodeFlat(reader: ByteReader, output: Float32Array, width: number,
  first: ResolutionAxis, second: ResolutionAxis, initial: readonly number[]): void {
  const total = first.length * second.length;
  let sourcePixel = 0, runShift = 0, previous: readonly number[] | undefined;
  const next = (): readonly number[] => sourcePixel === 0 ? initial
    : [reader.byte(), reader.byte(), reader.byte(), reader.byte()];
  while (sourcePixel < total) {
    const rgbe = next();
    if (rgbe[0] === 1 && rgbe[1] === 1 && rgbe[2] === 1) {
      if (!previous) throw new Error("Radiance HDR flat run has no previous pixel.");
      if (runShift > 24) throw new Error("Radiance HDR flat run shift exceeds limits.");
      const count = rgbe[3]! * (2 ** runShift);
      if (!Number.isSafeInteger(count) || sourcePixel + count > total) {
        throw new Error("Radiance HDR flat run exceeds the image.");
      }
      for (let repeat = 0; repeat < count; repeat++, sourcePixel++) {
        const scanline = Math.floor(sourcePixel / second.length), pixel = sourcePixel % second.length;
        writePixel(output, width, first, second, scanline, pixel, previous[0]!, previous[1]!, previous[2]!, previous[3]!);
      }
      runShift += 8;
    } else {
      const scanline = Math.floor(sourcePixel / second.length), pixel = sourcePixel % second.length;
      writePixel(output, width, first, second, scanline, pixel, rgbe[0]!, rgbe[1]!, rgbe[2]!, rgbe[3]!);
      previous = rgbe; sourcePixel++; runShift = 0;
    }
  }
}

/** Decodes a Radiance RGBE file into owned, finite linear-sRGB RGB pixels. */
export function decodeRadianceHdr(source: Uint8Array, options: RadianceHdrDecodeOptions = {}): RadianceHdrImage {
  if (!(source instanceof Uint8Array) || !(source.buffer instanceof ArrayBuffer) || source.byteLength === 0) {
    throw new Error("Radiance HDR input requires owned nonempty bytes.");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Invalid Radiance HDR options.");
  const maxDimension = limit(options.maxDimension, DEFAULT_MAX_DIMENSION, DEFAULT_MAX_DIMENSION, "dimension limit");
  const maxPixels = limit(options.maxPixels, DEFAULT_MAX_PIXELS, DEFAULT_MAX_PIXELS, "pixel limit");
  const reader = new ByteReader(source);
  const signature = reader.line();
  if (signature !== "#?RADIANCE" && signature !== "#?RGBE") throw new Error("Radiance HDR signature is invalid.");
  let format = "", lineCount = 0;
  for (;;) {
    const line = reader.line();
    if (++lineCount > 256 || reader.offset > 64 * 1024) throw new Error("Radiance HDR header exceeds limits.");
    if (!line) break;
    if (line.startsWith("FORMAT=")) {
      if (format) throw new Error("Radiance HDR declares multiple formats.");
      format = line.slice(7);
    }
  }
  if (format !== "32-bit_rle_rgbe") throw new Error("Radiance HDR requires 32-bit_rle_rgbe format.");
  const [first, second] = parseResolution(reader.line(), maxDimension, maxPixels);
  const width = first.name === "X" ? first.length : second.length;
  const height = first.name === "Y" ? first.length : second.length;
  const output = new Float32Array(width * height * 3);
  const initial = [reader.byte(), reader.byte(), reader.byte(), reader.byte()];
  const modern = second.length >= 8 && second.length <= 0x7fff
    && initial[0] === 2 && initial[1] === 2 && (initial[2]! & 0x80) === 0;
  if (modern) decodeModern(reader, output, width, first, second, initial);
  else decodeFlat(reader, output, width, first, second, initial);
  return Object.freeze({ width, height, data: output });
}
