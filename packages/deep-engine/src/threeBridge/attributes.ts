import { invalid, record, unsupported } from "./types.js";

type NumericArray = Float32Array | Float64Array | Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array;
export interface AttributeView {
  readonly array: NumericArray;
  readonly count: number;
  readonly stride: number;
  readonly offset: number;
  readonly normalized: boolean;
  readonly stamp: readonly unknown[];
}
export function attribute(value: unknown, size: number, feature: string): AttributeView {
  const a = record(value, feature);
  if (a.isGLBufferAttribute || a.isFloat16BufferAttribute || a.isInstancedBufferAttribute) unsupported(`${feature} storage`);
  const interleaved = a.isInterleavedBufferAttribute === true;
  const data = interleaved ? record(a.data, feature) : a;
  if (data.isInstancedInterleavedBuffer) unsupported(`${feature} storage`);
  const array = data.array;
  if (!(array instanceof Float32Array || array instanceof Float64Array || array instanceof Int8Array || array instanceof Uint8Array
    || array instanceof Uint8ClampedArray || array instanceof Int16Array || array instanceof Uint16Array || array instanceof Int32Array || array instanceof Uint32Array)) unsupported(`${feature} storage`);
  if (typeof SharedArrayBuffer !== "undefined" && array.buffer instanceof SharedArrayBuffer) unsupported(`${feature} shared storage`);
  const count = a.count as number, stride = (interleaved ? data.stride : a.itemSize) as number, offset = (interleaved ? a.offset : 0) as number;
  if (a.itemSize !== size || !Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(stride) || stride < size
    || !Number.isSafeInteger(offset) || offset < 0 || offset + size > stride || count * stride > array.length) invalid(`${feature} layout`);
  if (!Number.isSafeInteger(data.version) || (data.version as number) < 0 || typeof a.normalized !== "boolean") invalid(`${feature} version`);
  return { array, count, stride, offset, normalized: a.normalized,
    stamp: [a, data, array, array.buffer, array.byteOffset, array.byteLength, count, stride, offset, a.normalized, data.version] };
}
export function component(a: AttributeView, index: number, axis: number): number {
  const value = a.array[index * a.stride + a.offset + axis]!;
  if (!a.normalized || a.array instanceof Float32Array || a.array instanceof Float64Array) return value;
  if (a.array instanceof Int8Array) return Math.max(value / 127, -1);
  if (a.array instanceof Int16Array) return Math.max(value / 32767, -1);
  if (a.array instanceof Int32Array) return Math.max(value / 2147483647, -1);
  if (a.array instanceof Uint8Array || a.array instanceof Uint8ClampedArray) return value / 255;
  return value / (a.array instanceof Uint16Array ? 65535 : 4294967295);
}
export function indexAttribute(value: unknown): AttributeView | undefined {
  if (value == null) return undefined;
  const a = attribute(value, 1, "index");
  if (a.normalized || a.stride !== 1 || a.offset !== 0 || !(a.array instanceof Uint8Array || a.array instanceof Uint16Array || a.array instanceof Uint32Array)) unsupported("index storage");
  return a;
}
export function sameStamp(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
