export const XT_MAX_SAMPLE_BYTES = 256 * 1024;
export const XT_MAX_HEADER_BYTES = 64 * 1024;
export const XT_MAX_IDENTIFIER_BYTES = 512;

const TEXT_HEADER_PREFIX = "**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PART_MARKERS = ["**PART1;", "**PART2;", "**PART3;", "**END_OF_HEADER"];

export type XtExpectedFormat = "x_t" | "x_b";
export type XtEncoding = "text" | "bare-binary" | "typed-binary" | "neutral-binary";
export type XtStructureProbeStatus = "invalid" | "header-recognized";

export interface XtStructureProbeIssue {
  code:
    | "invalid-file-size"
    | "sample-too-large"
    | "header-not-recognized"
    | "header-too-large"
    | "missing-payload-marker"
    | "extension-encoding-mismatch"
    | "invalid-text-identification"
    | "binary-header-too-short"
    | "binary-identifier-too-large"
    | "binary-identifier-out-of-bounds"
    | "bare-binary-machine-layout-unknown"
    | "typed-binary-non-ascii-identifier";
  message: string;
}

export interface XtSchemaVersion {
  raw: string;
  modellerVersion?: string;
  schemaNumber?: string;
}

export interface XtProbeEvidence {
  /** 只记录有限样本中直接观察到的证据，不包含几何或拓扑推断。 */
  sampleBytes: number;
  headerMarkers: readonly string[];
  payloadOffset?: number;
  limitations: readonly string[];
}

export interface XtHeaderMetadata {
  application?: string;
  format?: string;
  declaredSchema?: string;
  sourceFileName?: string;
  productVersion?: string;
  guise?: string;
  key?: string;
  createdAt?: string;
  site?: string;
  user?: string;
  machine?: string;
  machineModel?: string;
  operatingSystem?: string;
  operatingSystemRelease?: string;
  userFieldSize?: number;
}

export interface XtStructureProbeResult {
  status: XtStructureProbeStatus;
  recognizedFormat: "parasolid-x_t" | "parasolid-x_b" | "unknown";
  probeScope: "structure-only";
  geometryParsed: false;
  encoding?: XtEncoding;
  version?: XtSchemaVersion;
  header?: XtHeaderMetadata;
  evidence: XtProbeEvidence;
  issues: XtStructureProbeIssue[];
}

type XtHeader = NonNullable<XtStructureProbeResult["header"]>;

export interface XtStructureProbeInput {
  fileSize: number;
  sampleBytes: Uint8Array;
  expectedFormat?: XtExpectedFormat;
}

/**
 * Parasolid X_T 的安全头部探测。根据公开 X_T Format Reference (2008) 只读取传输头、
 * 标志和 modeller/schema 标识；不引入外部 schema，也不读取 B-Rep、NURBS 或 trim。
 */
export function probeXtStructure(input: XtStructureProbeInput): XtStructureProbeResult {
  const base = baseResult(input.sampleBytes.byteLength);
  if (!Number.isSafeInteger(input.fileSize) || input.fileSize <= 0) return invalid(base, "invalid-file-size", "X_T 文件大小必须是正的安全整数");
  if (input.sampleBytes.byteLength > XT_MAX_SAMPLE_BYTES) return invalid(base, "sample-too-large", `X_T 样本不能超过 ${XT_MAX_SAMPLE_BYTES} 字节`);

  const text = new TextDecoder("latin1").decode(input.sampleBytes);
  const headerEnd = text.indexOf("**END_OF_HEADER");
  const hasFixedHeader = text.startsWith(TEXT_HEADER_PREFIX) && PART_MARKERS.every((marker) => text.includes(marker));
  if (!hasFixedHeader || headerEnd < 0) return invalid(base, "header-not-recognized", "未识别到 Parasolid X_T 固定文本头标记");
  if (headerEnd > XT_MAX_HEADER_BYTES) return invalid(base, "header-too-large", `X_T 头部标记必须位于前 ${XT_MAX_HEADER_BYTES} 字节内`);

  const payloadOffset = skipHeaderPadding(text, headerEnd + "**END_OF_HEADER".length);
  const header = parseHeaderFields(text.slice(0, payloadOffset));
  const evidence = { ...base.evidence, headerMarkers: PART_MARKERS, payloadOffset };
  if (payloadOffset >= input.sampleBytes.byteLength) return invalid({ ...base, evidence, header }, "missing-payload-marker", "X_T 头部后缺少格式标志");

  const marker = input.sampleBytes[payloadOffset];
  const result = marker === 0x54
    ? parseText(input, text, payloadOffset, header, evidence)
    : marker === 0x42 || (marker === 0x50 && input.sampleBytes[payloadOffset + 1] === 0x53)
      ? parseBinary(input, payloadOffset, header, evidence)
      : invalid({ ...base, evidence, header }, "missing-payload-marker", "X_T 头部后的格式标志不是 T、B 或 PS");

  if (result.recognizedFormat !== "unknown" && input.expectedFormat && result.recognizedFormat !== toRecognizedFormat(input.expectedFormat)) {
    return { ...result, issues: [...result.issues, issue("extension-encoding-mismatch", `文件内容为 ${result.encoding}，与上传扩展名 ${input.expectedFormat} 不一致`)] };
  }
  return result;
}

function parseText(
  input: XtStructureProbeInput,
  text: string,
  payloadOffset: number,
  header: XtHeader,
  evidence: XtProbeEvidence,
): XtStructureProbeResult {
  const base = recognized("parasolid-x_t", "text", input.sampleBytes.byteLength, header, evidence);
  const identification = parseTextIdentification(text, payloadOffset + 1, header.userFieldSize);
  if (!identification) return { ...base, issues: [issue("invalid-text-identification", "X_T 文本标志后的 modeller/schema 长度字段无效或超出样本")] };
  return {
    ...base,
    version: schemaVersion(identification.schema, identification.modeller),
    header: { ...header, userFieldSize: identification.userFieldSize },
  };
}

function parseBinary(
  input: XtStructureProbeInput,
  payloadOffset: number,
  header: XtHeader,
  evidence: XtProbeEvidence,
): XtStructureProbeResult {
  const bytes = input.sampleBytes;
  if (bytes[payloadOffset] === 0x42) {
    return { ...recognized("parasolid-x_b", "bare-binary", bytes.byteLength, header, evidence), issues: [issue("bare-binary-machine-layout-unknown", "Bare binary 依赖写入端机器布局；本探测不会猜测字节序或标识长度")] };
  }
  if (payloadOffset + 4 > bytes.byteLength) return invalid({ ...baseResult(bytes.byteLength), evidence, header }, "binary-header-too-short", "X_T PS 二进制标志不完整");

  const typed = bytes[payloadOffset + 3] === 1;
  const neutral = bytes[payloadOffset + 3] === 0;
  if (!typed && !neutral) return invalid({ ...baseResult(bytes.byteLength), evidence, header }, "binary-header-too-short", "X_T PS 二进制标志类型未知");
  const machineOffset = payloadOffset + 4;
  if (typed && machineOffset + 3 > bytes.byteLength) return invalid({ ...baseResult(bytes.byteLength), evidence, header }, "binary-header-too-short", "Typed binary 缺少机器描述");
  const byteOrder = typed ? bytes[machineOffset] : 0;
  const characterSet = typed ? bytes[machineOffset + 2] : 0;
  const encoding: XtEncoding = typed ? "typed-binary" : "neutral-binary";
  const base = recognized("parasolid-x_b", encoding, bytes.byteLength, header, evidence);
  if (typed && characterSet !== 0) return { ...base, issues: [issue("typed-binary-non-ascii-identifier", "Typed binary 的字符集不是公开参考定义的 ASCII，未解码版本或 schema")] };
  if (typed && byteOrder !== 0 && byteOrder !== 1) return invalid(base, "binary-header-too-short", "Typed binary 的字节序标记未知");

  const identification = parseBinaryIdentification(bytes, machineOffset + (typed ? 3 : 0), byteOrder === 1);
  if ("issue" in identification) return { ...base, issues: [identification.issue] };
  return {
    ...base,
    version: schemaVersion(identification.schema, identification.modeller),
    header: { ...header, userFieldSize: identification.userFieldSize },
  };
}

function parseTextIdentification(
  text: string,
  start: number,
  headerUserFieldSize?: number,
): { modeller: string; schema: string; userFieldSize: number } | undefined {
  let offset = skipWhitespace(text, start);
  const modellerLength = readDecimal(text, offset);
  if (!modellerLength || modellerLength.value > XT_MAX_IDENTIFIER_BYTES) return undefined;
  offset = skipWhitespace(text, modellerLength.afterOffset);
  const modeller = text.slice(offset, offset + modellerLength.value);
  if (modeller.length !== modellerLength.value) return undefined;
  offset = skipWhitespace(text, offset + modellerLength.value);
  const schemaLength = readDecimal(text, offset);
  if (!schemaLength || schemaLength.value > XT_MAX_IDENTIFIER_BYTES) return undefined;
  offset = skipWhitespace(text, schemaLength.afterOffset);
  const rawSchema = text.slice(offset, offset + schemaLength.value);
  if (rawSchema.length !== schemaLength.value) return undefined;

  // 部分紧凑 X_T 会把换行计入 schema 长度，并在第三段指定嵌入基准 schema。
  const schema = rawSchema.trim();
  if (!/^SCH_\d+_\d+(?:_\d+)?$/.test(schema)) return undefined;

  const payloadUserFieldSize = readDecimal(text, skipWhitespace(text, offset + schemaLength.value));
  const userFieldSize = headerUserFieldSize ?? payloadUserFieldSize?.value;
  return userFieldSize === undefined ? undefined : { modeller, schema, userFieldSize };
}

function parseBinaryIdentification(bytes: Uint8Array, start: number, littleEndian: boolean):
  | { modeller: string; schema: string; userFieldSize: number }
  | { issue: XtStructureProbeIssue } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (start + 2 > bytes.byteLength) return { issue: issue("binary-header-too-short", "X_T 二进制 modeller length 字段不完整") };
  const modellerLength = view.getUint16(start, littleEndian);
  if (modellerLength > XT_MAX_IDENTIFIER_BYTES) return { issue: issue("binary-identifier-too-large", "X_T 二进制 modeller 标识超过安全上限") };
  let offset = start + 2;
  if (offset + modellerLength + 4 > bytes.byteLength) return { issue: issue("binary-identifier-out-of-bounds", "X_T 二进制 modeller/schema 标识超出已读样本") };
  const modeller = decodeAscii(bytes.subarray(offset, offset + modellerLength));
  offset += modellerLength;
  const schemaLength = view.getUint32(offset, littleEndian);
  offset += 4;
  if (schemaLength > XT_MAX_IDENTIFIER_BYTES) return { issue: issue("binary-identifier-too-large", "X_T 二进制 schema 标识超过安全上限") };
  if (offset + schemaLength + 4 > bytes.byteLength) return { issue: issue("binary-identifier-out-of-bounds", "X_T 二进制 schema 标识或 user field 字段超出已读样本") };
  const schema = decodeAscii(bytes.subarray(offset, offset + schemaLength));
  if (!/^SCH_\d+_\d+$/.test(schema)) return { issue: issue("binary-identifier-out-of-bounds", "X_T 二进制 schema 标识格式无效") };
  offset += schemaLength;
  return { modeller, schema, userFieldSize: view.getUint32(offset, littleEndian) };
}

function parseHeaderFields(header: string): XtHeader {
  const userFieldSize = nonNegativeIntegerField(header, "USFLD_SIZE");
  return {
    ...optionalField("application", field(header, "APPL")),
    ...optionalField("format", field(header, "FORMAT")),
    ...optionalField("declaredSchema", field(header, "SCH")),
    ...optionalField("sourceFileName", field(header, "FILE")),
    ...optionalField("productVersion", field(header, "FRU")),
    ...optionalField("guise", field(header, "GUISE")),
    ...optionalField("key", field(header, "KEY")),
    ...optionalField("createdAt", field(header, "DATE")),
    ...optionalField("site", field(header, "SITE")),
    ...optionalField("user", field(header, "USER")),
    ...optionalField("machine", field(header, "MC")),
    ...optionalField("machineModel", field(header, "MC_MODEL")),
    ...optionalField("operatingSystem", field(header, "OS")),
    ...optionalField("operatingSystemRelease", field(header, "OS_RELEASE")),
    ...(userFieldSize !== undefined ? { userFieldSize } : {}),
  };
}

function optionalField<Key extends keyof XtHeaderMetadata>(
  key: Key,
  value: string | undefined,
): Partial<Pick<XtHeaderMetadata, Key>> {
  return value ? { [key]: value } as Partial<Pick<XtHeaderMetadata, Key>> : {};
}

function field(header: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[;\\r\\n])\\s*${name}=([^;\\r\\n]{1,256})`, "i").exec(header);
  return match?.[1]?.trim();
}

function nonNegativeIntegerField(header: string, name: string): number | undefined {
  const value = field(header, name);
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function schemaVersion(schema: string, modeller: string): XtSchemaVersion {
  const match = /^SCH_(\d+)_(\d+)(?:_(\d+))?$/.exec(schema);
  const schemaNumber = match?.[3] ?? match?.[2];
  return { raw: schema, modellerVersion: match?.[1] ?? modeller, ...(schemaNumber ? { schemaNumber } : {}) };
}

function recognized(recognizedFormat: "parasolid-x_t" | "parasolid-x_b", encoding: XtEncoding, sampleBytes: number, header: XtHeader, evidence: XtProbeEvidence): XtStructureProbeResult {
  return { status: "header-recognized", recognizedFormat, probeScope: "structure-only", geometryParsed: false, encoding, header, evidence: { ...evidence, sampleBytes }, issues: [] };
}

function baseResult(sampleBytes: number): XtStructureProbeResult {
  return {
    status: "invalid", recognizedFormat: "unknown", probeScope: "structure-only", geometryParsed: false,
    evidence: { sampleBytes, headerMarkers: [], limitations: ["不解析 B-Rep、NURBS、trim、heal、装配或 PMI", "不声明几何渲染、跨版本正式兼容或生产可用"] },
    issues: [],
  };
}

function invalid(base: XtStructureProbeResult, code: XtStructureProbeIssue["code"], message: string): XtStructureProbeResult {
  return { ...base, status: "invalid", issues: [...base.issues, issue(code, message)] };
}

function issue(code: XtStructureProbeIssue["code"], message: string): XtStructureProbeIssue {
  return { code, message };
}

function toRecognizedFormat(format: XtExpectedFormat): "parasolid-x_t" | "parasolid-x_b" {
  return format === "x_t" ? "parasolid-x_t" : "parasolid-x_b";
}

function skipHeaderPadding(text: string, offset: number): number {
  while (offset < text.length && (text[offset] === "*" || /\s/.test(text[offset]!))) offset += 1;
  return offset;
}

function skipWhitespace(text: string, offset: number): number {
  while (offset < text.length && /\s/.test(text[offset]!)) offset += 1;
  return offset;
}

function readDecimal(text: string, offset: number): { value: number; afterOffset: number } | undefined {
  const match = /^\d+/.exec(text.slice(offset));
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isSafeInteger(value) ? { value, afterOffset: offset + match[0].length } : undefined;
}

function decodeAscii(bytes: Uint8Array): string {
  return bytes.some((value) => value < 0x20 || value > 0x7e) ? "" : new TextDecoder("ascii").decode(bytes);
}
