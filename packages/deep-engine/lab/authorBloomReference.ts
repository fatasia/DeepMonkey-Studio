import { decodeFloat16Bits, encodeFloat16Bits } from "./temporalAaProbe.js";

export interface AuthorBloomReferenceImage { readonly width: number; readonly height: number; readonly pixels: Float32Array }
const half = (value: number) => decodeFloat16Bits(encodeFloat16Bits(value));

function image(width: number, height: number, pixel: (x: number, y: number) => readonly number[]): AuthorBloomReferenceImage {
  const pixels = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.set(pixel(x, y).map(half), (y * width + x) * 4);
  }
  return { width, height, pixels };
}

function sample(source: AuthorBloomReferenceImage, u: number, v: number): number[] {
  const x = u * source.width - 0.5, y = v * source.height - 0.5, ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const channel = (px: number, py: number, c: number) => source.pixels[
    (Math.min(source.height - 1, Math.max(0, py)) * source.width + Math.min(source.width - 1, Math.max(0, px))) * 4 + c]!;
  return [0, 1, 2, 3].map(c => (channel(ix, iy, c) * (1 - fx) + channel(ix + 1, iy, c) * fx) * (1 - fy)
    + (channel(ix, iy + 1, c) * (1 - fx) + channel(ix + 1, iy + 1, c) * fx) * fy);
}

/** Independent CPU translation of installed Three r185; each render target store rounds to half float. */
export function authorBloomReference(source: AuthorBloomReferenceImage, strength: number, threshold: number): AuthorBloomReferenceImage {
  let width = Math.max(1, Math.round(source.width / 2)), height = Math.max(1, Math.round(source.height / 2));
  let previous = image(width, height, (x, y) => {
    const color = sample(source, (x + 0.5) / width, (y + 0.5) / height);
    const luminance = color[0]! * 0.2126 + color[1]! * 0.7152 + color[2]! * 0.0722;
    const t = Math.max(0, Math.min(1, (luminance - threshold) / 0.01)), factor = t * t * (3 - 2 * t);
    return color.map(value => value * factor);
  });
  const levels: AuthorBloomReferenceImage[] = [];
  for (const radius of [6, 10, 14, 18, 22]) {
    const sigma = radius / 3, weights = Array.from({ length: radius }, (_, i) => 0.39894 * Math.exp(-0.5 * i * i / (sigma * sigma)) / sigma);
    const blur = (input: AuthorBloomReferenceImage, horizontal: boolean) => image(width, height, (x, y) => {
      const u = (x + 0.5) / width, v = (y + 0.5) / height;
      const color = sample(input, u, v).map(value => value * weights[0]!);
      for (let i = 1; i < radius; i++) {
        const du = horizontal ? i / width : 0, dv = horizontal ? 0 : i / height;
        const a = sample(input, u + du, v + dv), b = sample(input, u - du, v - dv);
        for (let c = 0; c < 3; c++) color[c]! += (a[c]! + b[c]!) * weights[i]!;
      }
      color[3] = 1; return color;
    });
    previous = blur(blur(previous, true), false); levels.push(previous);
    width = Math.max(1, Math.round(width / 2)); height = Math.max(1, Math.round(height / 2));
  }
  width = levels[0]!.width; height = levels[0]!.height;
  const combined = image(width, height, (x, y) => {
    const values = levels.map(level => sample(level, (x + 0.5) / width, (y + 0.5) / height));
    const color = [0, 1, 2].map(c => 3 * strength * values.reduce((sum, value, i) => sum + value[c]! * (0.8 - i * 0.1), 0));
    return [...color, Math.max(...color)];
  });
  return image(source.width, source.height, (x, y) => {
    const bloom = sample(combined, (x + 0.5) / source.width, (y + 0.5) / source.height);
    return bloom.map((value, c) => value + source.pixels[(y * source.width + x) * 4 + c]!);
  });
}
