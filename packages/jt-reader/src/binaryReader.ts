import type { JtByteOrder } from "./types.js";

export class JtFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JtFormatError";
  }
}

export class BinaryReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #littleEndian: boolean;

  constructor(bytes: Uint8Array, byteOrder: JtByteOrder = "little-endian") {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#littleEndian = byteOrder === "little-endian";
  }

  get length(): number {
    return this.#bytes.byteLength;
  }

  ensure(offset: number, length: number, context: string): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
      throw new JtFormatError(`${context} 的偏移或长度无效`);
    }
    if (offset + length > this.length) {
      throw new JtFormatError(`${context} 超出数据边界：${offset} + ${length} > ${this.length}`);
    }
  }

  u8(offset: number, context = "U8"): number {
    this.ensure(offset, 1, context);
    return this.#view.getUint8(offset);
  }

  i16(offset: number, context = "I16"): number {
    this.ensure(offset, 2, context);
    return this.#view.getInt16(offset, this.#littleEndian);
  }

  u16(offset: number, context = "U16"): number {
    this.ensure(offset, 2, context);
    return this.#view.getUint16(offset, this.#littleEndian);
  }

  i32(offset: number, context = "I32"): number {
    this.ensure(offset, 4, context);
    return this.#view.getInt32(offset, this.#littleEndian);
  }

  u32(offset: number, context = "U32"): number {
    this.ensure(offset, 4, context);
    return this.#view.getUint32(offset, this.#littleEndian);
  }

  f32(offset: number, context = "F32"): number {
    this.ensure(offset, 4, context);
    return this.#view.getFloat32(offset, this.#littleEndian);
  }

  f64(offset: number, context = "F64"): number {
    this.ensure(offset, 8, context);
    return this.#view.getFloat64(offset, this.#littleEndian);
  }

  u64Number(offset: number, context = "U64"): number {
    this.ensure(offset, 8, context);
    const value = this.#view.getBigUint64(offset, this.#littleEndian);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new JtFormatError(`${context} 超出 JavaScript 安全整数范围`);
    }
    return Number(value);
  }

  bytes(offset: number, length: number, context = "字节区间"): Uint8Array {
    this.ensure(offset, length, context);
    return this.#bytes.subarray(offset, offset + length);
  }

  ascii(offset: number, length: number, context = "ASCII 字符串"): string {
    return new TextDecoder("ascii").decode(this.bytes(offset, length, context));
  }

  guid(offset: number, context = "GUID"): string {
    this.ensure(offset, 16, context);
    const part1 = this.u32(offset).toString(16).padStart(8, "0");
    const part2 = this.u16(offset + 4).toString(16).padStart(4, "0");
    const part3 = this.u16(offset + 6).toString(16).padStart(4, "0");
    const tail = Array.from(this.bytes(offset + 8, 8), (value) => value.toString(16).padStart(2, "0"));
    return `${part1}-${part2}-${part3}-${tail.slice(0, 2).join("")}-${tail.slice(2).join("")}`;
  }
}
