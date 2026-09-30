/**
 * I 级 C1 3DGS——antimatter15 `.splat` 运行时格式解码(32B/粒 → 统一 64B records)。
 *
 * 布局(合同冻结,参考 antimatter15/splat 的 `convert` 产物):
 *   [0..12)  position 3×f32(dataset space,无内置单位标定)
 *   [12..24) scale    3×f32(已线性,不再 exp)
 *   [24..28) color    4×u8,straight alpha(alpha=0..255 不透明度)
 *   [28..32) rotation 4×u8,wxyz；(v-128)/128 后归一化并转为记录xyzw
 * 失败路径:长度非 32 整数倍 / 粒数超预算 / 四元数全零(不可归一化)。
 * u8 通道无 NaN 可能,故无逐字段 finite 检查。
 */
import {
  SPLAT_MAX_SPLAT_COUNT,
  SPLAT_RECORD_FLOAT_STRIDE,
  SPLAT_RECORD_OFFSET_COLOR,
  SPLAT_RECORD_OFFSET_OPACITY,
  SPLAT_RECORD_OFFSET_ROTATION,
  SPLAT_RECORD_OFFSET_SCALE,
  SPLAT_RUNTIME_FORMAT_ID,
  SplatParseError,
} from "./splatFormatContract.js";
import type { SplatCloud } from "./decodeSplatPly.js";

export const SPLAT_RUNTIME_RECORD_BYTE_STRIDE = 32;

/** 粒数预算守卫(纯函数,可直测;解码入口与预算路径共用)。 */
export function assertSplatRuntimeCount(splatCount: number): void {
  if (splatCount > SPLAT_MAX_SPLAT_COUNT) {
    throw new SplatParseError(
      `.splat declares ${splatCount} splats, exceeding the ${SPLAT_MAX_SPLAT_COUNT} splat budget.`);
  }
}

/** 解码 antimatter15 `.splat` 字节为统一 SplatCloud(shDegree 恒 0:该格式无 SH 高阶带)。 */
export function decodeSplatRuntimeFormat(bytes: Uint8Array): SplatCloud {
  if (bytes.byteLength % SPLAT_RUNTIME_RECORD_BYTE_STRIDE !== 0) {
    throw new SplatParseError(
      `.splat payload length ${bytes.byteLength} is not a multiple of ` +
      `${SPLAT_RUNTIME_RECORD_BYTE_STRIDE} bytes per splat; the file is truncated or not a runtime splat.`);
  }
  const splatCount = bytes.byteLength / SPLAT_RUNTIME_RECORD_BYTE_STRIDE;
  assertSplatRuntimeCount(splatCount);

  const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = bytes;
  const records = new Float32Array(splatCount * SPLAT_RECORD_FLOAT_STRIDE);
  for (let splatIndex = 0; splatIndex < splatCount; splatIndex++) {
    const sourceBase = splatIndex * SPLAT_RUNTIME_RECORD_BYTE_STRIDE;
    const u8Base = splatIndex * SPLAT_RUNTIME_RECORD_BYTE_STRIDE + 24;
    const recordOffset = splatIndex * SPLAT_RECORD_FLOAT_STRIDE;

    for (let channel = 0; channel < 6; channel++) {
      const value = source.getFloat32(sourceBase + channel * 4, true);
      if (!Number.isFinite(value) || (channel >= 3 && value <= 0)) {
        throw new SplatParseError(`Splat #${splatIndex} position/scale channel ${channel} is invalid.`);
      }
      records[recordOffset + (channel < 3 ? channel : SPLAT_RECORD_OFFSET_SCALE + channel - 3)] = value;
    }

    const qw = (u8[u8Base + 4]! - 128) / 128, qx = (u8[u8Base + 5]! - 128) / 128;
    const qy = (u8[u8Base + 6]! - 128) / 128, qz = (u8[u8Base + 7]! - 128) / 128;
    const length = Math.hypot(qx, qy, qz, qw);
    if (length <= 1e-6) {
      throw new SplatParseError(`Splat #${splatIndex} rotation quaternion has zero length and cannot be normalized.`);
    }
    records[recordOffset + SPLAT_RECORD_OFFSET_ROTATION] = qx / length;
    records[recordOffset + SPLAT_RECORD_OFFSET_ROTATION + 1] = qy / length;
    records[recordOffset + SPLAT_RECORD_OFFSET_ROTATION + 2] = qz / length;
    records[recordOffset + SPLAT_RECORD_OFFSET_ROTATION + 3] = qw / length;

    for (let channel = 0; channel < 3; channel++) {
      records[recordOffset + SPLAT_RECORD_OFFSET_COLOR + channel] = u8[u8Base + channel]! / 255;
    }
    records[recordOffset + SPLAT_RECORD_OFFSET_COLOR + 3] = u8[u8Base + 3]! / 255;
    records[recordOffset + SPLAT_RECORD_OFFSET_OPACITY] = u8[u8Base + 3]! / 255;
  }
  return {
    format: SPLAT_RUNTIME_FORMAT_ID,
    splatCount,
    records,
    shDegree: 0,
    shRest: null,
    shRestCount: 0,
  };
}
