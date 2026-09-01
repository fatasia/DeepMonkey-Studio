import { JtFormatError } from "./binaryReader.js";
import type { DecodedInt32Packet } from "./int32Codec.js";

const MAX_VALUES = 1_000_000;
const MAX_RECURSION = 8;

interface V2ProbabilityEntry {
  escape: boolean;
  occurrenceCount: number;
  value: number;
}

function ensure(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) throw new JtFormatError(`${label} 超出 CDP2 边界`);
}

function u32(bytes: Uint8Array, offset: number): number {
  ensure(bytes, offset, 4, "CDP2 U32");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

class WordBits {
  #position = 0;

  constructor(private readonly bytes: Uint8Array, private readonly bitLength: number) {}

  get position(): number {
    return this.#position;
  }

  read(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > 32 || this.#position + count > this.bitLength) {
      throw new JtFormatError(`CDP2 请求了无效的 ${count} 位`);
    }
    let result = 0;
    for (let index = 0; index < count; index += 1) {
      const word = u32(this.bytes, Math.floor(this.#position / 32) * 4);
      result = result * 2 + ((word >>> (31 - (this.#position % 32))) & 1);
      this.#position += 1;
    }
    return result >>> 0;
  }

  signed(count: number): number {
    const raw = this.read(count);
    if (count === 0) return 0;
    if (count === 32) return raw | 0;
    const sign = 2 ** (count - 1);
    return raw >= sign ? raw - 2 ** count : raw;
  }
}

class ByteBits {
  #position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > 32) throw new JtFormatError("CDP2 概率表位宽无效");
    let result = 0;
    for (let index = 0; index < count; index += 1) {
      const value = this.bytes[Math.floor(this.#position / 8)];
      if (value === undefined) throw new JtFormatError("CDP2 概率表被截断");
      result = result * 2 + ((value >>> (7 - (this.#position % 8))) & 1);
      this.#position += 1;
    }
    return result >>> 0;
  }

  finish(): number {
    const length = Math.ceil(this.#position / 8);
    if (this.#position % 8 !== 0) {
      const tail = this.bytes[length - 1]! & ((1 << (8 - (this.#position % 8))) - 1);
      if (tail !== 0) throw new JtFormatError("CDP2 概率表对齐位非零");
    }
    return length;
  }
}

function decodeBitLengthV2(codeWords: Uint8Array, bitLength: number, valueCount: number): number[] {
  const bits = new WordBits(codeWords, bitLength);
  const values: number[] = [];
  if (bits.read(1) === 0) {
    const minimumBits = bits.read(6);
    const maximumBits = bits.read(6);
    const minimum = bits.signed(minimumBits);
    const maximum = bits.signed(maximumBits);
    if (maximum < minimum) throw new JtFormatError("CDP2 BitLength 固定范围无效");
    const span = maximum - minimum;
    const width = span === 0 ? 0 : 32 - Math.clz32(span);
    for (let index = 0; index < valueCount; index += 1) values.push((minimum + bits.read(width)) | 0);
  } else {
    const mean = bits.signed(32);
    const deltaBits = bits.read(3);
    const runBits = bits.read(3);
    if (deltaBits === 0 || runBits === 0) throw new JtFormatError("CDP2 BitLength 动态块位宽无效");
    const minimumDelta = -(2 ** (deltaBits - 1));
    const maximumDelta = 2 ** (deltaBits - 1) - 1;
    let width = 0;
    while (values.length < valueCount) {
      let delta: number;
      do {
        delta = bits.signed(deltaBits);
        width += delta;
        if (width < 0 || width > 32) throw new JtFormatError("CDP2 BitLength 动态字段越界");
      } while (delta === minimumDelta || delta === maximumDelta);
      const run = bits.read(runBits);
      if (run <= 0 || values.length + run > valueCount) throw new JtFormatError("CDP2 BitLength 游程无效");
      for (let index = 0; index < run; index += 1) values.push((mean + bits.signed(width)) | 0);
    }
  }
  if (bits.position !== bitLength || values.length !== valueCount) throw new JtFormatError("CDP2 BitLength 未完整消费代码位");
  return values;
}

function parseV2Context(bytes: Uint8Array): { entries: V2ProbabilityEntry[]; byteLength: number } {
  const bits = new ByteBits(bytes);
  const entryCount = bits.read(16);
  const symbolBits = bits.read(6);
  const occurrenceBits = bits.read(6);
  const valueBits = bits.read(6);
  const minimum = bits.read(32) | 0;
  if (entryCount > MAX_VALUES || symbolBits === 0 || occurrenceBits === 0) throw new JtFormatError("CDP2 概率表头无效");
  const entries = Array.from({ length: entryCount }, () => {
    const symbol = bits.read(symbolBits) - 2;
    return {
      escape: symbol === -2,
      occurrenceCount: bits.read(occurrenceBits),
      value: (bits.read(valueBits) + minimum) | 0,
    };
  });
  return { entries, byteLength: bits.finish() };
}

function decodeArithmeticV2(
  codeWords: Uint8Array,
  bitLength: number,
  valueCount: number,
  entries: readonly V2ProbabilityEntry[],
): Array<number | undefined> {
  const total = entries.reduce((sum, entry) => sum + entry.occurrenceCount, 0);
  if (total <= 0 || total > 0xffff) throw new JtFormatError("CDP2 Arithmetic 概率总数无效");
  // CDP2 的最后一个 U32 会以 0 填充；算术重归一化允许读取这些物理填充位。
  const bits = new WordBits(codeWords, codeWords.byteLength * 8);
  let code = 0;
  for (let index = 0; index < 16; index += 1) code = ((code << 1) | bits.read(1)) & 0xffff;
  let low = 0;
  let high = 0xffff;
  const values: Array<number | undefined> = [];
  for (let index = 0; index < valueCount; index += 1) {
    const range = high - low + 1;
    const scaled = Math.floor(((code - low + 1) * total - 1) / range);
    let cumulative = 0;
    const entry = entries.find((candidate) => {
      const end = cumulative + candidate.occurrenceCount;
      if (scaled >= cumulative && scaled < end) return true;
      cumulative = end;
      return false;
    });
    if (!entry) throw new JtFormatError("CDP2 Arithmetic 找不到概率区间");
    high = low + Math.floor((range * (cumulative + entry.occurrenceCount)) / total) - 1;
    low += Math.floor((range * cumulative) / total);
    while (true) {
      if (((high ^ low) & 0x8000) === 0) {
        // 最高位相同，移出一位。
      } else if ((low & 0x4000) !== 0 && (high & 0x4000) === 0) {
        code ^= 0x4000;
        low &= 0x3fff;
        high |= 0x4000;
      } else break;
      low = (low << 1) & 0xffff;
      high = ((high << 1) | 1) & 0xffff;
      code = ((code << 1) | bits.read(1)) & 0xffff;
    }
    values.push(entry.escape ? undefined : entry.value);
  }
  if (bitLength === 0 && valueCount > 0) throw new JtFormatError("CDP2 Arithmetic 代码为空");
  return values;
}

export function decodeInt32PacketV2(bytes: Uint8Array, depth = 0): DecodedInt32Packet {
  if (depth > MAX_RECURSION) throw new JtFormatError("CDP2 递归层数超限");
  const valueCount = u32(bytes, 0);
  if (valueCount > MAX_VALUES) throw new JtFormatError("CDP2 值数量超限");
  if (valueCount === 0) return { values: [], byteLength: 4, codec: 0 };
  ensure(bytes, 4, 1, "CDP2 类型");
  const codec = bytes[4]!;
  if (codec === 4) return decodeChopperV2(bytes, valueCount, depth);
  if (codec === 0) {
    const byteLength = u32(bytes, 5);
    if (byteLength !== valueCount * 4) throw new JtFormatError("CDP2 Null 数据长度不一致");
    ensure(bytes, 9, byteLength, "CDP2 Null 数据");
    const view = new DataView(bytes.buffer, bytes.byteOffset + 9, byteLength);
    return { values: Array.from({ length: valueCount }, (_, index) => view.getInt32(index * 4, true)), byteLength: 9 + byteLength, codec };
  }
  if (codec !== 1 && codec !== 3) throw new JtFormatError(`不支持的 CDP2 CODEC：${codec}`);
  const bitLength = u32(bytes, 5);
  const codeByteLength = Math.ceil(bitLength / 32) * 4;
  ensure(bytes, 9, codeByteLength, "CDP2 代码字");
  const codeWords = bytes.subarray(9, 9 + codeByteLength);
  let cursor = 9 + codeByteLength;
  if (codec === 1) return { values: decodeBitLengthV2(codeWords, bitLength, valueCount), byteLength: cursor, codec };
  const context = parseV2Context(bytes.subarray(cursor));
  cursor += context.byteLength;
  const outOfBand = decodeInt32PacketV2(bytes.subarray(cursor), depth + 1);
  cursor += outOfBand.byteLength;
  if (bitLength === 0 && outOfBand.values.length === valueCount) return { values: outOfBand.values, byteLength: cursor, codec };
  const symbols = decodeArithmeticV2(codeWords, bitLength, valueCount, context.entries);
  const escapedCount = symbols.filter((value) => value === undefined).length;
  if (outOfBand.values.length !== escapedCount) throw new JtFormatError("CDP2 Arithmetic 逸出值数量不一致");
  let escaped = 0;
  return { values: symbols.map((value) => value ?? outOfBand.values[escaped++]!), byteLength: cursor, codec };
}

function decodeChopperV2(bytes: Uint8Array, valueCount: number, depth: number): DecodedInt32Packet {
  ensure(bytes, 5, 1, "CDP2 Chopper 位宽");
  const chopBits = bytes[5]!;
  if (chopBits === 0) {
    const nested = decodeInt32PacketV2(bytes.subarray(6), depth + 1);
    if (nested.values.length !== valueCount) throw new JtFormatError("CDP2 Chopper 嵌套数量不一致");
    return { values: nested.values, byteLength: 6 + nested.byteLength, codec: 4 };
  }
  const bias = u32(bytes, 6) | 0;
  const spanBits = bytes[10];
  if (spanBits === undefined || chopBits > spanBits || spanBits > 32) throw new JtFormatError("CDP2 Chopper 位跨度无效");
  const high = decodeInt32PacketV2(bytes.subarray(11), depth + 1);
  const low = decodeInt32PacketV2(bytes.subarray(11 + high.byteLength), depth + 1);
  if (high.values.length !== valueCount || low.values.length !== valueCount) throw new JtFormatError("CDP2 Chopper 数量不一致");
  const shift = spanBits - chopBits;
  const mask = shift === 32 ? 0xffff_ffff : 2 ** shift - 1;
  const values = high.values.map((value, index) => {
    const lowValue = low.values[index]!;
    if (lowValue < 0 || lowValue > mask) throw new JtFormatError("CDP2 Chopper 低位越界");
    return ((lowValue | (value << shift)) + bias) | 0;
  });
  return { values, byteLength: 11 + high.byteLength + low.byteLength, codec: 4 };
}
