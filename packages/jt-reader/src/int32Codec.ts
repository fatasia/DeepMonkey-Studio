import { JtFormatError } from "./binaryReader.js";

const MAX_VALUES = 1_000_000;
const MAX_ARITHMETIC_WORK = 64_000_000;
const MAX_RECURSION = 8;

export type JtPredictor =
  | "lag1"
  | "lag2"
  | "stride1"
  | "stride2"
  | "strip-index"
  | "ramp"
  | "xor1"
  | "xor2"
  | "none";

export interface DecodedInt32Packet {
  values: number[];
  byteLength: number;
  codec: number;
}

interface ProbabilityEntry {
  escape: boolean;
  occurrenceCount: number;
  value: number;
}

function ensureRange(bytes: Uint8Array, offset: number, length: number, context: string): void {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    throw new JtFormatError(`${context} 超出整数压缩包边界`);
  }
}

function u32(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 4, "U32");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

class WordBitReader {
  #bit = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly bitLength: number,
  ) {}

  get position(): number {
    return this.#bit;
  }

  read(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > 32 || this.#bit + count > this.bitLength) {
      throw new JtFormatError(`整数 CODEC 请求了无效的 ${count} 位`);
    }
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const wordOffset = Math.floor(this.#bit / 32) * 4;
      const word = u32(this.bytes, wordOffset);
      const bitInWord = this.#bit % 32;
      value = value * 2 + ((word >>> (31 - bitInWord)) & 1);
      this.#bit += 1;
    }
    return value >>> 0;
  }

  readSigned(count: number): number {
    const raw = this.read(count);
    if (count === 0) return 0;
    if (count === 32) return raw | 0;
    const sign = 2 ** (count - 1);
    return raw >= sign ? raw - 2 ** count : raw;
  }
}

class ByteBitReader {
  #bit = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > 32) throw new JtFormatError("概率表位宽无效");
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = this.bytes[Math.floor(this.#bit / 8)];
      if (byte === undefined) throw new JtFormatError("概率表被截断");
      value = value * 2 + ((byte >>> (7 - (this.#bit % 8))) & 1);
      this.#bit += 1;
    }
    return value >>> 0;
  }

  finish(): number {
    const byteLength = Math.ceil(this.#bit / 8);
    if (this.#bit % 8 !== 0) {
      const last = this.bytes[byteLength - 1];
      if (last === undefined || (last & ((1 << (8 - (this.#bit % 8))) - 1)) !== 0) {
        throw new JtFormatError("概率表尾部填充位非零");
      }
    }
    return byteLength;
  }
}

function parseProbabilityContext(bytes: Uint8Array): { entries: ProbabilityEntry[]; byteLength: number } {
  ensureRange(bytes, 0, 2, "概率表头");
  const entryCount = (bytes[0]! << 8) | bytes[1]!;
  const bits = new ByteBitReader(bytes.subarray(2));
  const occurrenceBits = bits.read(6);
  const valueBits = bits.read(7);
  const minimum = bits.read(32) | 0;
  if (entryCount > MAX_VALUES || occurrenceBits + valueBits === 0) {
    throw new JtFormatError("概率表项目数量或位宽无效");
  }
  const entries: ProbabilityEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    entries.push({
      escape: bits.read(1) === 1,
      occurrenceCount: bits.read(occurrenceBits),
      value: (bits.read(valueBits) + minimum) | 0,
    });
  }
  return { entries, byteLength: 2 + bits.finish() };
}

function decodeBitLength(codeWords: Uint8Array, bitLength: number, valueCount: number): number[] {
  const bits = new WordBitReader(codeWords, bitLength);
  const values: number[] = [];
  if (bits.read(1) === 0) {
    const minimum = readNibbleSigned(bits);
    const maximum = readNibbleSigned(bits);
    if (maximum < minimum) {
      throw new JtFormatError("BitLength 固定位宽范围无效");
    }
    const span = maximum - minimum;
    const width = span === 0 ? 0 : 32 - Math.clz32(span);
    for (let index = 0; index < valueCount; index += 1) {
      const value = minimum + bits.read(width);
      if (value > maximum) throw new JtFormatError("BitLength 数值超出声明范围");
      values.push(value | 0);
    }
  } else {
    const mean = readNibbleSigned(bits);
    const minimumDelta = -8;
    const maximumDelta = 7;
    let width = 0;
    while (values.length < valueCount) {
      while (true) {
        const delta = bits.readSigned(4);
        width += delta;
        if (width < 0 || width > 32) throw new JtFormatError("BitLength 动态位宽越界");
        if (delta !== minimumDelta && delta !== maximumDelta) break;
      }
      const run = bits.read(4);
      if (run === 0 || values.length + run > valueCount) throw new JtFormatError("BitLength 游程长度无效");
      for (let index = 0; index < run; index += 1) values.push((mean + bits.readSigned(width)) | 0);
    }
  }
  if (bits.position !== bitLength) throw new JtFormatError("BitLength 未完整消费声明的代码位");
  return values;
}

/** JT 10 第三代 BitLength 以“4 位数据 + 1 位续写”从低位到高位保存有符号数。 */
function readNibbleSigned(bits: WordBitReader): number {
  let raw = 0;
  let nibbleCount = 0;
  let more: number;
  do {
    if (nibbleCount >= 8) throw new JtFormatError("BitLength nibbler 超过 32 位");
    raw = (raw | (bits.read(4) << (nibbleCount * 4))) | 0;
    more = bits.read(1);
    nibbleCount += 1;
  } while (more !== 0);
  const width = nibbleCount * 4;
  if (width === 32) return raw;
  const sign = 2 ** (width - 1);
  const unsigned = raw >>> 0;
  return unsigned >= sign ? unsigned - 2 ** width : unsigned;
}

function decodeArithmetic(
  codeWords: Uint8Array,
  bitLength: number,
  valueCount: number,
  entries: ProbabilityEntry[],
): Array<number | undefined> {
  if (entries.length * valueCount > MAX_ARITHMETIC_WORK) throw new JtFormatError("Arithmetic 解码工作量超限");
  const total = entries.reduce((sum, entry) => sum + entry.occurrenceCount, 0);
  if (total <= 0 || total > 0xffff) throw new JtFormatError("Arithmetic 概率总数无效");
  const bits = new WordBitReader(codeWords, bitLength);
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
    if (!entry) throw new JtFormatError("Arithmetic 找不到概率区间");
    const entryHigh = cumulative + entry.occurrenceCount;
    high = (low + Math.floor((range * entryHigh) / total) - 1) & 0xffff;
    low = (low + Math.floor((range * cumulative) / total)) & 0xffff;
    while (true) {
      if (((high ^ low) & 0x8000) === 0) {
        // 最高位相同，可以移出。
      } else if ((low & 0x4000) !== 0 && (high & 0x4000) === 0) {
        code ^= 0x4000;
        low &= 0x3fff;
        high |= 0x4000;
      } else {
        break;
      }
      low = (low << 1) & 0xffff;
      high = ((high << 1) | 1) & 0xffff;
      code = ((code << 1) | bits.read(1)) & 0xffff;
    }
    values.push(entry.escape ? undefined : entry.value);
  }
  return values;
}

export function decodeInt32Packet(bytes: Uint8Array, depth = 0): DecodedInt32Packet {
  if (depth > MAX_RECURSION) throw new JtFormatError("整数压缩包递归层数超限");
  const valueCount = u32(bytes, 0);
  if (valueCount > MAX_VALUES) throw new JtFormatError(`整数压缩包值数量 ${valueCount} 超限`);
  if (valueCount === 0) return { values: [], byteLength: 4, codec: 0 };
  ensureRange(bytes, 4, 1, "CODEC 类型");
  const codec = bytes[4]!;
  if (codec === 4) return decodeChopper(bytes, valueCount, depth);
  if (codec === 0) {
    const dataByteLength = u32(bytes, 5);
    if (dataByteLength !== valueCount * 4) throw new JtFormatError("Null CODEC 数据长度与值数量不一致");
    ensureRange(bytes, 9, dataByteLength, "Null CODEC 数据");
    const view = new DataView(bytes.buffer, bytes.byteOffset + 9, dataByteLength);
    const values = Array.from({ length: valueCount }, (_, index) => view.getInt32(index * 4, true));
    return { values, byteLength: 9 + dataByteLength, codec };
  }
  if (codec !== 1 && codec !== 3) throw new JtFormatError(`不支持的整数 CODEC：${codec}`);
  const bitLength = u32(bytes, 5);
  const codeByteLength = Math.ceil(bitLength / 32) * 4;
  ensureRange(bytes, 9, codeByteLength, "CODEC 代码字");
  const codeWords = bytes.subarray(9, 9 + codeByteLength);
  let cursor = 9 + codeByteLength;
  if (codec === 1) {
    return { values: decodeBitLength(codeWords, bitLength, valueCount), byteLength: cursor, codec };
  }
  const context = parseProbabilityContext(bytes.subarray(cursor));
  cursor += context.byteLength;
  const symbols = decodeArithmetic(codeWords, bitLength, valueCount, context.entries);
  const escapedCount = symbols.filter((value) => value === undefined).length;
  // 只有概率表声明了 escape 项时，流中才跟随递归的 OOB 数据包。
  // 无 escape 的 Arithmetic 包会紧接下一个业务字段，不能误吞为嵌套包。
  const outOfBand = escapedCount > 0
    ? decodeInt32Packet(bytes.subarray(cursor), depth + 1)
    : { values: [], byteLength: 0 };
  if (outOfBand.values.length !== escapedCount) throw new JtFormatError("Arithmetic 逸出值数量不一致");
  cursor += outOfBand.byteLength;
  let escapedIndex = 0;
  const values = symbols.map((value) => value ?? outOfBand.values[escapedIndex++]!);
  return { values, byteLength: cursor, codec };
}

function decodeChopper(bytes: Uint8Array, valueCount: number, depth: number): DecodedInt32Packet {
  ensureRange(bytes, 5, 1, "Chopper 位宽");
  const chopBits = bytes[5]!;
  if (chopBits === 0) {
    const nested = decodeInt32Packet(bytes.subarray(6), depth + 1);
    if (nested.values.length !== valueCount) throw new JtFormatError("Chopper 嵌套数量不一致");
    return { values: nested.values, byteLength: 6 + nested.byteLength, codec: 4 };
  }
  const bias = u32(bytes, 6) | 0;
  ensureRange(bytes, 10, 1, "Chopper 跨度");
  const spanBits = bytes[10]!;
  if (chopBits > spanBits || spanBits > 32) throw new JtFormatError("Chopper 位跨度无效");
  const high = decodeInt32Packet(bytes.subarray(11), depth + 1);
  const low = decodeInt32Packet(bytes.subarray(11 + high.byteLength), depth + 1);
  if (high.values.length !== valueCount || low.values.length !== valueCount) {
    throw new JtFormatError("Chopper 高低位数量不一致");
  }
  const shift = spanBits - chopBits;
  const lowMask = shift === 32 ? 0xffff_ffff : 2 ** shift - 1;
  const values = high.values.map((value, index) => {
    const lowValue = low.values[index]!;
    if (lowValue < 0 || lowValue > lowMask) throw new JtFormatError("Chopper 低位值越界");
    return ((lowValue | (value << shift)) + bias) | 0;
  });
  return { values, byteLength: 11 + high.byteLength + low.byteLength, codec: 4 };
}

export function applyPredictor(residuals: readonly number[], predictor: JtPredictor): number[] {
  if (predictor === "none") return [...residuals];
  const values: number[] = [];
  for (let index = 0; index < residuals.length; index += 1) {
    const residual = residuals[index]!;
    if (index < 4) {
      values.push(residual);
      continue;
    }
    const one = values[index - 1]!;
    const two = values[index - 2]!;
    const four = values[index - 4]!;
    const predicted = predictor === "lag1" || predictor === "xor1" ? one
      : predictor === "lag2" || predictor === "xor2" ? two
        : predictor === "stride1" ? (one + (one - two)) | 0
          : predictor === "stride2" ? (two + (two - four)) | 0
            : predictor === "strip-index"
              ? (two + ((two - four >= -7 && two - four <= 7) ? two - four : 2)) | 0
              : index;
    values.push(predictor === "xor1" || predictor === "xor2" ? residual ^ predicted : (residual + predicted) | 0);
  }
  return values;
}
