/** T07 采集脚本共享编解码与统计工具(f16 纹理读回、字节打包、分位数)。 */

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export function f16Bits(value: number): number {
  f32[0] = value; const bits = u32[0]!;
  const sign = (bits >> 16) & 0x8000;
  const exponent = (bits >> 23) & 0xff, mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 1 : 0);
  const adjusted = exponent - 127 + 15;
  if (adjusted >= 0x1f) return sign | 0x7c00;
  if (adjusted <= 0) { if (adjusted < -10) return sign; return sign | ((mantissa | 0x800000) >> (14 - adjusted)); }
  return sign | (adjusted << 10) | (mantissa >> 13);
}
export const toF16RgbaBytes = (rgba: Float32Array): Uint8Array => {
  const bytes = new Uint8Array(rgba.length * 2), view = new DataView(bytes.buffer);
  for (let index = 0; index < rgba.length; index++) view.setUint16(index * 2, f16Bits(rgba[index]!), true);
  return bytes;
};
export function decodeF16(bytes: Uint8Array, count: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = new Float32Array(count);
  for (let index = 0; index < count; index++) out[index] = decodeF16One(view, index);
  return out;
}
export function decodeF16One(view: DataView, index: number): number {
  const bits = view.getUint16(index * 2, true);
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, fraction = bits & 1023;
  return sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
}
export const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
export const f32Buffer = (values: ArrayLike<number>): Uint8Array => new Uint8Array(Float32Array.from(values as number[]).buffer);
export const percentiles = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.floor(sorted.length * 0.95)]! };
};
/** 从对齐行步长的 f16 读回缓冲提取 RGBA16F 像素(每像素 8 字节)。 */
export const extractRgba = (bytes: Uint8Array, width: number, height: number, stride: number): Float32Array => {
  const pixels = new Float32Array(width * height * 4), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = y * (stride / 2) + x * 4, target = (y * width + x) * 4;
    for (let channel = 0; channel < 4; channel++) pixels[target + channel] = decodeF16One(view, source + channel);
  }
  return pixels;
};
/** 从对齐行步长的 f16 读回缓冲提取运动向量(rgba16f 存储取 .xy)。 */
export const extractMotion = (bytes: Uint8Array, width: number, height: number, stride: number): Float32Array => {
  const motion = new Float32Array(width * height * 2), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = y * (stride / 2) + x * 4, target = (y * width + x) * 2;
    motion[target] = decodeF16One(view, source);
    motion[target + 1] = decodeF16One(view, source + 1);
  }
  return motion;
};
export function maxAbsDiff(left: Float32Array, right: Float32Array, stride = 4): number {
  let max = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += stride)
    for (let channel = 0; channel < (stride === 4 ? 3 : 1); channel++) max = Math.max(max, Math.abs((left[index + channel] ?? 0) - (right[index + channel] ?? 0)));
  return max;
}
export const hasNonFinite = (values: Float32Array): boolean => values.some(value => !Number.isFinite(value));
export function edgePixelCount(rgb: Float32Array, width: number, height: number, threshold = 0.15): number {
  const luma = (index: number) => rgb[index * 3]! * 0.25 + rgb[index * 3 + 1]! * 0.5 + rgb[index * 3 + 2]! * 0.25;
  let count = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const center = luma(y * width + x);
    if (Math.abs(center - luma(y * width + x + 1)) > threshold || Math.abs(center - luma((y + 1) * width + x)) > threshold) count++;
  }
  return count;
}
export const toRgb = (rgba: Float32Array, width: number, height: number): Float32Array => {
  const rgb = new Float32Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) rgb.set([rgba[pixel * 4]!, rgba[pixel * 4 + 1]!, rgba[pixel * 4 + 2]!], pixel * 3);
  return rgb;
};
