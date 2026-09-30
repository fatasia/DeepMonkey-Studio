/**
 * I 级 C1 3DGS——PLY 二进负载解码:f32 属性 → 统一 64B/粒 records。
 *
 * 失败路径(全部 fail-closed,错误带粒号+字段名):
 * 负载截断 / 尾部多余字节 / 任一必选字段 NaN-Inf / 旋转四元数模长为 0
 * (不可归一化)。scale 以 exp() 解码、opacity 以 sigmoid() 解码、
 * color = 0.5 + SH_C0·f_dc 后 clamp 到 0..1,四元数归一化到 xyzw。
 * SH 高阶带(f_rest)不在此解码,按文件原值保留到 shRest 供后续
 * 视角相关 SH 着色;首刀渲染只消费 DC(视角无关)。
 */
import {
  SPLAT_RECORD_FLOAT_STRIDE,
  SPLAT_RECORD_OFFSET_COLOR,
  SPLAT_RECORD_OFFSET_OPACITY,
  SPLAT_RECORD_OFFSET_ROTATION,
  SPLAT_RECORD_OFFSET_SCALE,
  SPLAT_SH_C0,
  SPLAT_PLY_FORMAT_ID,
  splatOpacityFromLogit,
  splatPlyPayloadByteLength,
  parseSplatPlyHeader,
  SplatParseError,
  type SplatPlyHeaderContract,
} from "./splatFormatContract.js";

export interface SplatCloud {
  /** SPLAT_PLY_FORMAT_ID 或 SPLAT_RUNTIME_FORMAT_ID。 */
  format: string;
  splatCount: number;
  /** splatCount × 16 f32,布局见 splatFormatContract 记录注释;GPU 直传。 */
  records: Float32Array;
  shDegree: SplatPlyHeaderContract["shDegree"];
  /** splatCount × shRestCount,f_rest 原始系数;无高阶带时为 null。 */
  shRest: Float32Array | null;
  shRestCount: number;
}

function requirePayloadBounds(bytes: Uint8Array, contract: SplatPlyHeaderContract): void {
  const expected = splatPlyPayloadByteLength(contract);
  const actual = bytes.byteLength - contract.headerByteLength;
  if (actual < expected) {
    throw new SplatParseError(
      `PLY payload is truncated: expected ${expected} bytes after the header, found ${actual} ` +
      `(${contract.splatCount} splats × ${contract.byteStride} B).`);
  }
  if (actual > expected) {
    throw new SplatParseError(
      `PLY payload has ${actual - expected} unexpected trailing byte(s): expected exactly ${expected} ` +
      `after the header; refusing to guess the layout.`);
  }
}

function decodeShRest(
  view: DataView,
  contract: SplatPlyHeaderContract,
  splatIndex: number,
  splatBase: number,
  target: Float32Array,
  targetOffset: number,
): void {
  for (let coefficient = 0; coefficient < contract.shRestCount; coefficient++) {
    const column = contract.propertyColumns.get(`f_rest_${coefficient}`)!;
    const value = view.getFloat32(splatBase + column * 4, true);
    if (!Number.isFinite(value)) {
      throw new SplatParseError(`Splat #${splatIndex} field "f_rest_${coefficient}" is not finite.`);
    }
    target[targetOffset + coefficient] = value;
  }
}

function decodeSplatRecord(
  view: DataView,
  contract: SplatPlyHeaderContract,
  splatIndex: number,
  splatBase: number,
  records: Float32Array,
  recordOffset: number,
): void {
  const readFinite = (name: string): number => {
    const value = view.getFloat32(splatBase + contract.propertyColumns.get(name)! * 4, true);
    if (!Number.isFinite(value)) {
      throw new SplatParseError(`Splat #${splatIndex} field "${name}" is not finite.`);
    }
    return value;
  };

  records[recordOffset] = readFinite("x");
  records[recordOffset + 1] = readFinite("y");
  records[recordOffset + 2] = readFinite("z");
  records[recordOffset + SPLAT_RECORD_OFFSET_OPACITY] = splatOpacityFromLogit(readFinite("opacity"));
  records[recordOffset + SPLAT_RECORD_OFFSET_SCALE] = Math.exp(readFinite("scale_0"));
  records[recordOffset + SPLAT_RECORD_OFFSET_SCALE + 1] = Math.exp(readFinite("scale_1"));
  records[recordOffset + SPLAT_RECORD_OFFSET_SCALE + 2] = Math.exp(readFinite("scale_2"));

  const qx = readFinite("rot_1"), qy = readFinite("rot_2"), qz = readFinite("rot_3"), qw = readFinite("rot_0");
  const length = Math.hypot(qx, qy, qz, qw);
  if (length <= 1e-12) {
    throw new SplatParseError(`Splat #${splatIndex} rotation quaternion has zero length and cannot be normalized.`);
  }
  records[recordOffset + SPLAT_RECORD_OFFSET_ROTATION] = qx / length;
  records[recordOffset + SPLAT_RECORD_OFFSET_ROTATION + 1] = qy / length;
  records[recordOffset + SPLAT_RECORD_OFFSET_ROTATION + 2] = qz / length;
  records[recordOffset + SPLAT_RECORD_OFFSET_ROTATION + 3] = qw / length;

  for (let channel = 0; channel < 3; channel++) {
    const dc = readFinite(`f_dc_${channel}`);
    records[recordOffset + SPLAT_RECORD_OFFSET_COLOR + channel] =
      Math.min(1, Math.max(0, 0.5 + SPLAT_SH_C0 * dc));
  }
  records[recordOffset + SPLAT_RECORD_OFFSET_COLOR + 3] =
    records[recordOffset + SPLAT_RECORD_OFFSET_OPACITY]!;
}

/** 解码完整 PLY 字节(头 + 负载)为统一 SplatCloud。 */
export function decodeSplatPly(bytes: Uint8Array): SplatCloud {
  const contract = parseSplatPlyHeader(bytes);
  requirePayloadBounds(bytes, contract);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = new Float32Array(contract.splatCount * SPLAT_RECORD_FLOAT_STRIDE);
  let shRest: Float32Array | null = null;
  if (contract.shRestCount > 0) {
    shRest = new Float32Array(contract.splatCount * contract.shRestCount);
  }
  for (let splatIndex = 0; splatIndex < contract.splatCount; splatIndex++) {
    const splatBase = contract.headerByteLength + splatIndex * contract.byteStride;
    const recordOffset = splatIndex * SPLAT_RECORD_FLOAT_STRIDE;
    decodeSplatRecord(view, contract, splatIndex, splatBase, records, recordOffset);
    if (shRest !== null) {
      decodeShRest(view, contract, splatIndex, splatBase, shRest, splatIndex * contract.shRestCount);
    }
  }
  return {
    format: SPLAT_PLY_FORMAT_ID,
    splatCount: contract.splatCount,
    records,
    shDegree: contract.shDegree,
    shRest,
    shRestCount: contract.shRestCount,
  };
}
