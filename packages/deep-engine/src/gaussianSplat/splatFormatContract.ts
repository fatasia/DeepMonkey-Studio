/**
 * I 级 C1 3DGS 实景扫描接入——PLY 格式合同(fail-closed)。
 *
 * 载体:INRIA 3D Gaussian Splatting 官方导出的 `point_cloud.ply`
 * (binary_little_endian 1.0,逐粒 float 属性,属性顺序不保证)。
 * 合同冻结必选字段 position/scale/rot/opacity/SH-DC,可选 SH 高阶带
 * 只接受完整度数(0/9/24/45,对应 SH 0~3 阶),部分带一律拒绝——
 * 这是真实导出器(完整 INRIA 与蒸馏变体)都满足的最严公共面。
 * ASCII / big-endian PLY 明确不支持并显式报错,不做静默降级。
 */

export class SplatParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplatParseError";
  }
}

/** PLY 3DGS 合同标识(解析产物携带,消费方可据此路由渲染路径)。 */
export const SPLAT_PLY_FORMAT_ID = "ply-binary-little-endian-3dgs-v1";
/** antimatter15 .splat 运行时格式标识(32B/粒,见 decodeSplatRuntimeFormat)。 */
export const SPLAT_RUNTIME_FORMAT_ID = "splat-runtime-32b-v1";

/** 单模型粒数预算:16M 粒 × 64B records ≈ 1GiB,超预算先拒绝再分配。 */
export const SPLAT_MAX_SPLAT_COUNT = 16_000_000;
/** PLY 头扫描预算:超过即认定格式损坏,防止对二进制负载做无界文本扫描。 */
export const SPLAT_PLY_HEADER_MAX_BYTES = 64 * 1024;

/** PLY SH 系数 SH_C0(0 阶基):color = 0.5 + SH_C0 * f_dc。 */
export const SPLAT_SH_C0 = 0.28209479177387814;
/** 允许的 f_rest 属性个数(完整 SH 带);缺省 0 = 只用 DC。 */
export const SPLAT_SH_BAND_COUNTS = [0, 9, 24, 45] as const;
export type SplatShDegree = 0 | 1 | 2 | 3;

/** 必选属性(名字固定;文件内顺序任意,解析按名字取列)。 */
export const SPLAT_REQUIRED_PROPERTIES = [
  "x", "y", "z",
  "f_dc_0", "f_dc_1", "f_dc_2",
  "opacity",
  "scale_0", "scale_1", "scale_2",
  "rot_0", "rot_1", "rot_2", "rot_3",
] as const;

/**
 * 解析产物单粒记录布局:16×f32 = 4×vec4f = 64B,与 WGSL storage
 * array<vec4f> 逐字对齐(GPU 直传,无需重排)。
 * [0..2] position xyz      [3] opacity(0..1,sigmoid 后)
 * [4..6] scale xyz(线性)   [7] padding = 0
 * [8..11] rotation xyzw(归一化)
 * [12..15] color rgba(0..1,straight alpha)
 */
export const SPLAT_RECORD_FLOAT_STRIDE = 16;
export const SPLAT_RECORD_BYTE_STRIDE = SPLAT_RECORD_FLOAT_STRIDE * 4;
export const SPLAT_RECORD_OFFSET_OPACITY = 3;
export const SPLAT_RECORD_OFFSET_SCALE = 4;
export const SPLAT_RECORD_OFFSET_ROTATION = 8;
export const SPLAT_RECORD_OFFSET_COLOR = 12;

export interface SplatPlyHeaderContract {
  format: typeof SPLAT_PLY_FORMAT_ID;
  /** "element vertex N" 的 N。 */
  splatCount: number;
  /** vertex 元素内属性名,按文件内顺序。 */
  propertyNames: readonly string[];
  /** 属性名 → 浮点列下标。 */
  propertyColumns: ReadonlyMap<string, number>;
  /** 每粒浮点数(= propertyNames.length,全部为 float)。 */
  floatStride: number;
  byteStride: number;
  shDegree: SplatShDegree;
  shRestCount: (typeof SPLAT_SH_BAND_COUNTS)[number];
  hasNormals: boolean;
  /** 含 "end_header" 换行在内的头部长度;负载自此开始。 */
  headerByteLength: number;
}

function parseHeaderLines(bytes: Uint8Array): { lines: string[]; headerByteLength: number } {
  const scanLength = Math.min(bytes.byteLength, SPLAT_PLY_HEADER_MAX_BYTES);
  const headerText = new TextDecoder("latin1").decode(bytes.subarray(0, scanLength));
  const endIndex = headerText.indexOf("end_header");
  if (endIndex < 0) {
    throw new SplatParseError(
      `PLY header is missing "end_header" within ${SPLAT_PLY_HEADER_MAX_BYTES} bytes; the file is not a valid 3DGS PLY.`);
  }
  const newlineAfterEnd = headerText.indexOf("\n", endIndex);
  if (newlineAfterEnd < 0) {
    throw new SplatParseError("PLY header is truncated: no byte follows \"end_header\".");
  }
  const headerByteLength = newlineAfterEnd + 1;
  return {
    lines: headerText.slice(0, headerByteLength).split(/\r?\n/),
    headerByteLength,
  };
}

function parseVertexElement(lines: string[]): { splatCount: number; propertyNames: string[] } {
  let splatCount = -1;
  const propertyNames: string[] = [];
  let insideVertex = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === "end_header") break;
    const tokens = trimmed.split(/\s+/);
    if (tokens[0] === "comment" || tokens[0] === "obj_info") continue;
    if (tokens[0] === "element") {
      insideVertex = tokens[1] === "vertex";
      if (!insideVertex) {
        throw new SplatParseError(
          `PLY contains an unsupported element "${tokens[1]}" (${tokens[2] ?? "?"} items); ` +
          "3DGS contract accepts a single vertex element only.");
      }
      splatCount = Number(tokens[2]);
      continue;
    }
    if (tokens[0] === "property") {
      if (!insideVertex) {
        throw new SplatParseError(`PLY property "${tokens.at(-1)}" appears outside the vertex element.`);
      }
      const type = tokens[1];
      if (type !== "float" && type !== "float32") {
        throw new SplatParseError(
          `PLY property "${tokens.at(-1)}" has unsupported type "${type}"; the 3DGS contract requires float/float32.`);
      }
      propertyNames.push(tokens.at(-1)!);
      continue;
    }
    if (tokens[0] === "format" || tokens[0] === "ply") continue;
    throw new SplatParseError(`PLY header contains an unsupported directive "${tokens[0]}".`);
  }
  if (splatCount < 0) {
    throw new SplatParseError("PLY is missing the \"element vertex\" declaration.");
  }
  return { splatCount, propertyNames };
}

/** 逐字段 fail-closed 校验;返回的 Map 供解码器按名字取列。 */
export function parseSplatPlyHeader(bytes: Uint8Array): SplatPlyHeaderContract {
  if (bytes.byteLength < 3 || bytes[0] !== 0x70 || bytes[1] !== 0x6c || bytes[2] !== 0x79) {
    throw new SplatParseError("File does not start with the PLY magic \"ply\".");
  }
  const { lines, headerByteLength } = parseHeaderLines(bytes);
  const formatLine = lines.map((line) => line.trim()).find((line) => line.startsWith("format "));
  if (formatLine !== "format binary_little_endian 1.0") {
    throw new SplatParseError(
      `PLY format "${formatLine ?? "<missing>"}" is unsupported; the 3DGS contract requires exactly ` +
      "\"format binary_little_endian 1.0\" (ASCII and big-endian are rejected, not downgraded).");
  }
  const { splatCount, propertyNames } = parseVertexElement(lines);
  if (!Number.isSafeInteger(splatCount) || splatCount > SPLAT_MAX_SPLAT_COUNT) {
    throw new SplatParseError(
      `PLY vertex count ${splatCount} is invalid or exceeds the ${SPLAT_MAX_SPLAT_COUNT} splat budget.`);
  }

  const missing = SPLAT_REQUIRED_PROPERTIES.filter((name) => !propertyNames.includes(name));
  if (missing.length > 0) {
    throw new SplatParseError(
      `PLY is missing required 3DGS properties: ${missing.join(", ")}.`);
  }
  const duplicates = propertyNames.filter((name, index) => propertyNames.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new SplatParseError(`PLY declares duplicate properties: ${[...new Set(duplicates)].join(", ")}.`);
  }

  const shRestCount = propertyNames.filter((name) => /^f_rest_\d+$/.test(name)).length;
  const shRestSequences = propertyNames.filter((name) => /^f_rest_\d+$/.test(name))
    .map((name) => Number(name.slice("f_rest_".length)));
  const shRestContiguous = shRestSequences.every((value, index) => value === index);
  if (!(SPLAT_SH_BAND_COUNTS as readonly number[]).includes(shRestCount) || !shRestContiguous) {
    throw new SplatParseError(
      `PLY has ${shRestCount} f_rest coefficients; the contract requires a complete SH band set ` +
      `(${SPLAT_SH_BAND_COUNTS.join("/")} contiguous from f_rest_0).`);
  }

  const propertyColumns = new Map(propertyNames.map((name, column) => [name, column]));
  const hasNormals = propertyNames.includes("nx") && propertyNames.includes("ny") && propertyNames.includes("nz");
  return {
    format: SPLAT_PLY_FORMAT_ID,
    splatCount,
    propertyNames,
    propertyColumns,
    floatStride: propertyNames.length,
    byteStride: propertyNames.length * 4,
    shDegree: ({ 0: 0, 9: 1, 24: 2, 45: 3 } as const)[shRestCount] ?? 0,
    shRestCount: shRestCount as (typeof SPLAT_SH_BAND_COUNTS)[number],
    hasNormals,
    headerByteLength,
  };
}

/** 期望负载字节数;解码器据此做字节精确校验(多一字节少一字节都拒绝)。 */
export function splatPlyPayloadByteLength(contract: SplatPlyHeaderContract): number {
  return contract.splatCount * contract.byteStride;
}

/** sigmoid(PLY opacity 原始 logit → 0..1)。 */
export function splatOpacityFromLogit(logit: number): number {
  return 1 / (1 + Math.exp(-logit));
}
