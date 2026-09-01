import { BinaryReader, JtFormatError } from "./binaryReader.js";
import type { JtFileHeader, JtReadLimits, JtSegmentEntry } from "./types.js";
import { decompressDeflate, decompressXz } from "./xzDecoder.js";

const SEGMENT_HEADER_BYTES = 24;

export interface JtContainer {
  bytes: Uint8Array;
  header: JtFileHeader;
  segments: JtSegmentEntry[];
}

function parseVersion(versionText: string): { majorVersion: number; minorVersion: number } {
  const match = /Version\s+(\d+)(?:\.(\d+))?/i.exec(versionText);
  if (!match?.[1]) throw new JtFormatError("文件头不包含可识别的 JT 版本");
  return {
    majorVersion: Number.parseInt(match[1], 10),
    minorVersion: Number.parseInt(match[2] ?? "0", 10),
  };
}

export function parseJtContainer(bytes: Uint8Array, limits: JtReadLimits): JtContainer {
  if (bytes.byteLength > limits.maxFileBytes) {
    throw new JtFormatError(`JT 文件超过 ${limits.maxFileBytes} 字节上限`);
  }
  const headerReader = new BinaryReader(bytes);
  headerReader.ensure(0, 105, "JT 文件头");
  const versionText = headerReader.ascii(0, 80).replace(/[\0\r\n]+/g, " ").trim();
  const { majorVersion, minorVersion } = parseVersion(versionText);
  const orderFlag = headerReader.u8(80, "文件字节序");
  if (orderFlag !== 0 && orderFlag !== 1) throw new JtFormatError(`不支持的 JT 字节序标记：${orderFlag}`);
  const byteOrder = orderFlag === 0 ? "little-endian" : "big-endian";
  const reader = new BinaryReader(bytes, byteOrder);
  // JT 10 起 TOC 偏移由 I32 扩展为 U64，后续 LSG GUID 因而顺延 4 字节。
  const tocOffset = majorVersion >= 10
    ? reader.u64Number(85, "TOC 偏移")
    : reader.u32(85, "TOC 偏移");
  const lsgSegmentId = reader.guid(majorVersion >= 10 ? 93 : 89, "LSG 数据段标识");
  reader.ensure(tocOffset, 4, "TOC 头");
  const entryCount = reader.u32(tocOffset, "TOC 项数量");
  if (entryCount > limits.maxSegmentCount) {
    throw new JtFormatError(`TOC 项数量 ${entryCount} 超过安全上限`);
  }
  const tocEntryBytes = majorVersion >= 10 ? 32 : 28;
  reader.ensure(tocOffset + 4, entryCount * tocEntryBytes, "TOC 项");

  const segments: JtSegmentEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const offset = tocOffset + 4 + index * tocEntryBytes;
    // JT 10 将 TOC 数据段偏移由 U32 扩展为 U64，9.x 仍是 28 字节目录项。
    const segmentOffset = majorVersion >= 10
      ? reader.u64Number(offset + 16, `TOC[${index}] 数据段偏移`)
      : reader.u32(offset + 16, `TOC[${index}] 数据段偏移`);
    const segmentLengthOffset = offset + (majorVersion >= 10 ? 24 : 20);
    const segmentLength = reader.u32(segmentLengthOffset, `TOC[${index}] 数据段长度`);
    const attributes = reader.u32(segmentLengthOffset + 4, `TOC[${index}] 属性`);
    if (segmentLength < SEGMENT_HEADER_BYTES || segmentLength > limits.maxSegmentBytes) {
      throw new JtFormatError(`TOC[${index}] 数据段长度 ${segmentLength} 无效`);
    }
    reader.ensure(segmentOffset, segmentLength, `TOC[${index}] 数据段`);
    const id = reader.guid(offset, `TOC[${index}] 标识`);
    const segmentId = reader.guid(segmentOffset, `数据段[${index}] 标识`);
    if (id !== segmentId) throw new JtFormatError(`TOC[${index}] 与数据段标识不一致`);
    const declaredLength = reader.u32(segmentOffset + 20, `数据段[${index}] 声明长度`);
    if (declaredLength !== segmentLength) throw new JtFormatError(`数据段[${index}] 长度与 TOC 不一致`);
    segments.push({ id, offset: segmentOffset, length: segmentLength, attributes, type: attributes >>> 24 });
  }

  return {
    bytes,
    header: { versionText, majorVersion, minorVersion, byteOrder, tocOffset, lsgSegmentId },
    segments,
  };
}

export async function readSegmentPayload(
  container: JtContainer,
  segment: JtSegmentEntry,
  limits: JtReadLimits,
): Promise<Uint8Array> {
  const reader = new BinaryReader(container.bytes, container.header.byteOrder);
  const payloadOffset = segment.offset + SEGMENT_HEADER_BYTES;
  const payloadLength = segment.length - SEGMENT_HEADER_BYTES;
  if (payloadLength < 9) return reader.bytes(payloadOffset, payloadLength, "数据段内容");

  const compressionFlag = reader.u32(payloadOffset, "压缩标记");
  if (compressionFlag !== 2 && compressionFlag !== 3) {
    return reader.bytes(payloadOffset, payloadLength, "未压缩数据段内容");
  }
  const encodedLength = reader.u32(payloadOffset + 4, "压缩数据长度");
  const algorithm = reader.u8(payloadOffset + 8, "压缩算法");
  if (algorithm !== compressionFlag) throw new JtFormatError(`不支持的 JT 压缩算法：${algorithm}`);
  if (encodedLength < 1 || encodedLength + 8 > payloadLength) {
    throw new JtFormatError(`JT 压缩数据长度 ${encodedLength} 无效`);
  }
  const encoded = reader.bytes(payloadOffset + 9, encodedLength - 1, "XZ 压缩内容");
  return compressionFlag === 3
    ? decompressXz(encoded, limits.maxDecompressedBytes)
    : decompressDeflate(encoded, limits.maxDecompressedBytes);
}
