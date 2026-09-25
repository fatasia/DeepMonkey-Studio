import { decodeLatin1 } from "./tokens.js";

/** 缺省 16MB 上限沿用既有 X_T 子集口径；环境变量最多放宽到 64MB，禁止无界读取。 */
export const XT_GENERIC_DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const XT_GENERIC_MAX_BYTES_CEILING = 64 * 1024 * 1024;
export const XT_GENERIC_MAX_BYTES_ENV = "XT_GENERIC_MAX_BYTES";

const HEADER_PREFIX = "**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PART_MARKERS = ["**PART1;", "**PART2;", "**PART3;", "**END_OF_HEADER"] as const;
const IDENTIFICATION_PREFIX = "T51 : TRANSMIT FILE";

export type XtEncodingClass = "format-text" | "legacy-baseline" | "unknown";

export interface XtSegmentHeader {
  application?: string;
  declaredSchema?: string;
  productVersion?: string;
  sourceFileName?: string;
  /** T51 标识行上的 schema；不同版本的写入口径可能不同，只记录不拒绝。 */
  identificationSchema?: string;
  identificationModellerVersion?: string;
  encodingClass: XtEncodingClass;
  payloadTokenOffset: number;
}

export interface XtTextSegments {
  header: XtSegmentHeader;
  /** latin1 解码后的完整文本；供上层统计与调试，token 流由 entityIndex 生成。 */
  text: string;
  sourceBytes: number;
}

export class XtGenericSegmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XtGenericSegmentError";
  }
}

export function resolveGenericMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[XT_GENERIC_MAX_BYTES_ENV]);
  if (!Number.isFinite(raw) || raw <= 0) return XT_GENERIC_DEFAULT_MAX_BYTES;
  return Math.min(Math.floor(raw), XT_GENERIC_MAX_BYTES_CEILING);
}

/**
 * 分段读取：固定头、PART 标记与 T51 标识行只记录不拒绝（除结构必需项外）。
 * Parasolid 文本的折行会切断数值 token，必须整体去除后再切 token；
 * 偏移全部以压缩后文本为准，标识行边界先在原文上确定。
 * schema 版本差异不影响分段；几何解释交给上层按类校验。
 */
export function readXtTextSegments(source: Uint8Array, maxBytes = resolveGenericMaxBytes()): XtTextSegments {
  if (source.byteLength === 0 || source.byteLength > maxBytes) {
    throw new XtGenericSegmentError(`X_T 文本大小必须在 1 到 ${maxBytes} 字节之间`);
  }
  const raw = decodeLatin1(source);
  const headerEnd = raw.indexOf("**END_OF_HEADER");
  const hasFixedHeader = raw.startsWith(HEADER_PREFIX) && PART_MARKERS.every((marker) => raw.includes(marker));
  if (!hasFixedHeader || headerEnd < 0) {
    throw new XtGenericSegmentError("未识别到 Parasolid X_T 固定文本头标记");
  }
  const identificationAt = raw.indexOf(IDENTIFICATION_PREFIX, headerEnd);
  if (identificationAt < 0) {
    throw new XtGenericSegmentError("头部之后缺少 T51 文本传输流标识行");
  }
  const lineEnd = raw.indexOf("\n", identificationAt);
  const identificationLine = raw.slice(identificationAt, lineEnd < 0 ? undefined : lineEnd + 1);
  const text = raw.replace(/[\r\n]/g, "");
  const payloadTokenOffset = raw.slice(0, lineEnd < 0 ? raw.length : lineEnd + 1).replace(/[\r\n]/g, "").length;
  return {
    header: parseHeader(raw.slice(0, headerEnd), identificationLine, payloadTokenOffset),
    text,
    sourceBytes: source.byteLength,
  };
}

function parseHeader(headerText: string, identificationLine: string, payloadTokenOffset: number): XtSegmentHeader {
  const schemaMatch = /SCH_\d+_\d+(?:_\d+)?/.exec(identificationLine);
  const versionMatch = /version (\d+)/.exec(identificationLine);
  return {
    ...optionalField("application", headerField(headerText, "APPL")),
    ...optionalField("declaredSchema", headerField(headerText, "SCH")),
    ...optionalField("productVersion", headerField(headerText, "FRU")),
    ...optionalField("sourceFileName", headerField(headerText, "FILE")),
    ...(schemaMatch ? { identificationSchema: schemaMatch[0] } : {}),
    ...(versionMatch ? { identificationModellerVersion: versionMatch[1] } : {}),
    encodingClass: classifyEncoding(schemaMatch?.[0]),
    payloadTokenOffset,
  };
}

function classifyEncoding(schema: string | undefined): XtEncodingClass {
  if (!schema) return "unknown";
  // SCH_901000 是嵌入的旧格式基线；整份文件用该编码时实体框架与新式 255 标记不兼容。
  return schema.startsWith("SCH_901000") ? "legacy-baseline" : "format-text";
}

function headerField(header: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[;\\r\\n])\\s*${name}=([^;\\r\\n]{1,256})`, "i").exec(header);
  return match?.[1]?.trim();
}

function optionalField<K extends keyof XtSegmentHeader>(key: K, value: string | undefined): Partial<Pick<XtSegmentHeader, K>> {
  return value ? { [key]: value } as Partial<Pick<XtSegmentHeader, K>> : {};
}
