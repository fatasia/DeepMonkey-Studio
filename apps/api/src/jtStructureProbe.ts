export const JT_VERSION_FIELD_BYTES = 80;
export const JT_MAX_HEADER_SAMPLE_BYTES = 4 * 1024;
export const JT_MAX_TOC_SAMPLE_BYTES = 64 * 1024;
export const JT_MAX_TOC_ENTRY_COUNT = 1_000_000;

const BYTE_ORDER_OFFSET = 80;
const EMPTY_FIELD_OFFSET = 81;
const TOC_OFFSET_FIELD = 85;
const LEGACY_HEADER_BYTES = 105;
const VERSION_10_HEADER_BYTES = 109;
const LEGACY_TOC_ENTRY_BYTES = 28;
const VERSION_10_TOC_ENTRY_BYTES = 32;

export type JtByteOrder = "little-endian" | "big-endian";
export type JtStructureProbeStatus = "invalid" | "unsupported-version" | "header-recognized" | "toc-recognized";

export type JtStructureIssueCode =
  | "invalid-file-size"
  | "header-sample-too-large"
  | "header-too-short"
  | "invalid-version-header"
  | "invalid-translation-marker"
  | "unsupported-version"
  | "invalid-byte-order"
  | "unsafe-toc-offset"
  | "toc-out-of-bounds"
  | "toc-sample-too-large"
  | "toc-sample-offset-mismatch"
  | "toc-sample-too-short"
  | "invalid-toc-entry-count"
  | "toc-table-out-of-bounds";

export interface JtStructureProbeIssue {
  code: JtStructureIssueCode;
  message: string;
}

export interface JtTocSample {
  /** 样本在原文件中的绝对偏移，必须与头部声明的 TOC Offset 一致。 */
  offset: number;
  bytes: Uint8Array;
}

export interface JtStructureProbeInput {
  /** 原文件总字节数；调用方可用范围读取提供 header/toc，无需把整个文件载入内存。 */
  fileSize: number;
  headerBytes: Uint8Array;
  tocSample?: JtTocSample;
}

export interface JtFormatVersion {
  raw: string;
  major: number;
  minor: number;
}

export interface JtTocProbe {
  offset: number;
  offsetWidthBytes: 4 | 8;
  entrySizeBytes: 28 | 32;
  entryCount?: number;
  declaredTableBytes?: number;
}

export interface JtProbeEvidence {
  sampleBytes: number;
  headerMarkers: readonly string[];
  limitations: readonly string[];
}

export interface JtStructureProbeResult {
  status: JtStructureProbeStatus;
  recognizedFormat: "jt" | "unknown";
  /** 本探测器不读取 Segment，也不代表装配、PMI 或几何已经可解析。 */
  probeScope: "structure-only";
  geometryParsed: false;
  version?: JtFormatVersion;
  byteOrder?: JtByteOrder;
  emptyField?: number;
  toc?: JtTocProbe;
  evidence: JtProbeEvidence;
  issues: JtStructureProbeIssue[];
}

interface ParsedHeader {
  version: JtFormatVersion;
  byteOrder: JtByteOrder;
  littleEndian: boolean;
  emptyField: number;
  toc: JtTocProbe;
}

/**
 * 依据公开 JT 文件格式参考执行固定头和 TOC 基础探测。
 * 只读取有限样本并校验所有整数边界，不分配由文件内计数控制的数组。
 */
export function probeJtStructure(input: JtStructureProbeInput): JtStructureProbeResult {
  const base = {
    probeScope: "structure-only" as const,
    geometryParsed: false as const,
    evidence: {
      sampleBytes: input.headerBytes.byteLength + (input.tocSample?.bytes.byteLength ?? 0),
      headerMarkers: ["JT Version M.n", "Byte Order", "TOC Offset"],
      limitations: ["不读取 Segment，不解析几何、装配或 PMI", "不声明几何渲染、跨版本正式兼容或生产可用"],
    },
  };
  const inputIssue = validateInput(input);
  if (inputIssue) return { ...base, status: "invalid", recognizedFormat: "unknown", issues: [inputIssue] };

  const parsed = parseHeader(input.headerBytes);
  if ("issue" in parsed) {
    return {
      ...base,
      status: parsed.issue.code === "unsupported-version" ? "unsupported-version" : "invalid",
      recognizedFormat: parsed.recognized ? "jt" : "unknown",
      ...(parsed.version ? { version: parsed.version } : {}),
      issues: [parsed.issue]
    };
  }

  const headerResult = {
    ...base,
    recognizedFormat: "jt" as const,
    version: parsed.version,
    byteOrder: parsed.byteOrder,
    emptyField: parsed.emptyField,
    toc: parsed.toc
  };
  const tocOffsetIssue = validateTocOffset(parsed.toc.offset, parsed.version.major, input.fileSize);
  if (tocOffsetIssue) return { ...headerResult, status: "invalid", issues: [tocOffsetIssue] };
  if (!input.tocSample) return { ...headerResult, status: "header-recognized", issues: [] };

  const tocResult = parseTocSample(input.tocSample, parsed, input.fileSize);
  if ("issue" in tocResult) return { ...headerResult, status: "invalid", issues: [tocResult.issue] };
  return {
    ...headerResult,
    status: "toc-recognized",
    toc: { ...parsed.toc, entryCount: tocResult.entryCount, declaredTableBytes: tocResult.declaredTableBytes },
    issues: []
  };
}

function validateInput(input: JtStructureProbeInput): JtStructureProbeIssue | undefined {
  if (!Number.isSafeInteger(input.fileSize) || input.fileSize <= 0) {
    return issue("invalid-file-size", "JT 文件大小必须是正的安全整数");
  }
  if (input.headerBytes.byteLength > JT_MAX_HEADER_SAMPLE_BYTES) {
    return issue("header-sample-too-large", `JT 头部样本不能超过 ${JT_MAX_HEADER_SAMPLE_BYTES} 字节`);
  }
  if (input.headerBytes.byteLength < JT_VERSION_FIELD_BYTES + 1) {
    return issue("header-too-short", `JT 头部样本至少需要 ${JT_VERSION_FIELD_BYTES + 1} 字节`);
  }
  if (input.tocSample && input.tocSample.bytes.byteLength > JT_MAX_TOC_SAMPLE_BYTES) {
    return issue("toc-sample-too-large", `JT TOC 样本不能超过 ${JT_MAX_TOC_SAMPLE_BYTES} 字节`);
  }
  return undefined;
}

function parseHeader(bytes: Uint8Array): ParsedHeader | {
  issue: JtStructureProbeIssue;
  recognized: boolean;
  version?: JtFormatVersion;
} {
  const version = parseVersion(bytes);
  if (!version) return { issue: issue("invalid-version-header", "未识别到合法的 JT Version M.n 文件头"), recognized: false };
  if (!hasTranslationMarker(bytes)) {
    return { issue: issue("invalid-translation-marker", "JT 版本字段末尾的 ASCII 传输检测标记无效"), recognized: true, version };
  }
  if (version.major < 8 || version.major > 10) {
    return { issue: issue("unsupported-version", `当前基础探测仅定义 JT 8.x、9.x 和 10.x 的头部布局，检测到 ${version.major}.${version.minor}`), recognized: true, version };
  }

  const headerBytes = version.major >= 10 ? VERSION_10_HEADER_BYTES : LEGACY_HEADER_BYTES;
  if (bytes.byteLength < headerBytes) {
    return { issue: issue("header-too-short", `JT ${version.major}.x 头部样本至少需要 ${headerBytes} 字节`), recognized: true, version };
  }

  const byteOrderValue = bytes[BYTE_ORDER_OFFSET];
  if (byteOrderValue !== 0 && byteOrderValue !== 1) {
    return { issue: issue("invalid-byte-order", `JT Byte Order 仅允许 0 或 1，实际为 ${byteOrderValue}`), recognized: true, version };
  }
  const littleEndian = byteOrderValue === 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const emptyField = view.getInt32(EMPTY_FIELD_OFFSET, littleEndian);
  const offsetWidthBytes = version.major >= 10 ? 8 : 4;
  const tocOffset = readTocOffset(view, offsetWidthBytes, littleEndian);
  if (tocOffset === undefined) {
    return { issue: issue("unsafe-toc-offset", "JT TOC Offset 超出 JavaScript 可安全表示的整数范围"), recognized: true, version };
  }

  return {
    version,
    littleEndian,
    byteOrder: littleEndian ? "little-endian" : "big-endian",
    emptyField,
    toc: {
      offset: tocOffset,
      offsetWidthBytes,
      entrySizeBytes: version.major >= 10 ? VERSION_10_TOC_ENTRY_BYTES : LEGACY_TOC_ENTRY_BYTES
    }
  };
}

function parseVersion(bytes: Uint8Array): JtFormatVersion | undefined {
  const printable = bytes.subarray(0, 75);
  if (printable.some((value) => value < 0x20 || value > 0x7e)) return undefined;
  const raw = new TextDecoder("ascii").decode(printable).trim();
  const match = /^Version\s+(\d+)\.(\d+)\s+JT(?:\s|$)/.exec(raw);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return undefined;
  return { raw, major, minor };
}

function hasTranslationMarker(bytes: Uint8Array): boolean {
  return bytes[75] === 0x20 && bytes[76] === 0x0a && bytes[77] === 0x0d && bytes[78] === 0x0a && bytes[79] === 0x20;
}

function readTocOffset(view: DataView, width: 4 | 8, littleEndian: boolean): number | undefined {
  if (width === 4) {
    const value = view.getInt32(TOC_OFFSET_FIELD, littleEndian);
    return value >= 0 ? value : undefined;
  }
  const value = view.getBigUint64(TOC_OFFSET_FIELD, littleEndian);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function validateTocOffset(offset: number, major: number, fileSize: number): JtStructureProbeIssue | undefined {
  const headerBytes = major >= 10 ? VERSION_10_HEADER_BYTES : LEGACY_HEADER_BYTES;
  if (offset < headerBytes || offset > fileSize - 4) {
    return issue("toc-out-of-bounds", `JT TOC Offset ${offset} 不在文件有效范围内`);
  }
  return undefined;
}

function parseTocSample(sample: JtTocSample, header: ParsedHeader, fileSize: number): {
  entryCount: number;
  declaredTableBytes: number;
} | { issue: JtStructureProbeIssue } {
  if (!Number.isSafeInteger(sample.offset) || sample.offset !== header.toc.offset) {
    return { issue: issue("toc-sample-offset-mismatch", "TOC 样本偏移与 JT 文件头声明不一致") };
  }
  if (sample.bytes.byteLength < 4) return { issue: issue("toc-sample-too-short", "TOC 样本至少需要 4 字节的 Entry Count") };

  const view = new DataView(sample.bytes.buffer, sample.bytes.byteOffset, sample.bytes.byteLength);
  const entryCount = view.getInt32(0, header.littleEndian);
  if (entryCount <= 0 || entryCount > JT_MAX_TOC_ENTRY_COUNT) {
    return { issue: issue("invalid-toc-entry-count", `JT TOC Entry Count ${entryCount} 超出 1..${JT_MAX_TOC_ENTRY_COUNT} 范围`) };
  }
  const declaredTableBytes = 4 + entryCount * header.toc.entrySizeBytes;
  if (!Number.isSafeInteger(declaredTableBytes) || declaredTableBytes > fileSize - header.toc.offset) {
    return { issue: issue("toc-table-out-of-bounds", "JT TOC 声明的表长度超出文件边界") };
  }
  return { entryCount, declaredTableBytes };
}

function issue(code: JtStructureIssueCode, message: string): JtStructureProbeIssue {
  return { code, message };
}
