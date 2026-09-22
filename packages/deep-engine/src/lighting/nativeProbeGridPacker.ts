import { DEEP_GI_PROBE_RECORD_BYTES } from "./probeClipmapPlan.js";
import { packIrradianceProbeRecord } from "./probeClipmapSampling.js";

/**
 * F3 Native 探针网格打包:把探针数据打包成 Native `probe_gi`
 * storage(binding 11)的 96B 小端 f32 扁平记录流,供
 * `frame.lightDirection.w >= 1.5` 的网格三线性路径消费。
 *
 * 两种记录流(字节布局与 Rust `probe_gi_grid.rs` 逐字对齐):
 * - 旧单层合同(`packNativeProbeGridRecords`,逐字节不变):record 0 = 网格头
 *   (words[0..3] origin、[3] spacing、[4..7] gridSize、[7] baseProbeRecords 恒 1、
 *   [8..11] maxPosition、[11] probeCount,保留区 12 字全零),record 1..N = 探针。
 * - v2 多层级联合同(`packNativeProbeGridLevels`):record 0 = 布局头——主 12 字
 *   全零,保留区 word12=版本(2)、word13=levelCount(1..4,细→粗)、word14=levels
 *   起始记录号(恒 1),其余保留字全零;随后每层一个网格头(原格式,保留区全零,
 *   baseProbeRecords = 本层首条探针记录号 = 布局头 + 前面所有层全部记录 +
 *   本层网格头)+ 该层探针记录按层顺序排布。层间要求:粗层 spacing 严格更大、
 *   粗层范围逐轴包含细层范围(与 Rust 级联 decode fail-closed 校验一致)。
 *
 * 探针记录线性下标 (z*gridY + y)*gridX + x,由 `packIrradianceProbeRecord`
 * 编码(positionOffset 为重定位增量)。任何非法输入在写第一个字节前 fail-closed。
 */

export const NATIVE_PROBE_GRID_MAX_PROBES = 65_536 - 1;
/** v2 布局头版本号,与 Rust PROBE_GI_GRID_LAYOUT_VERSION 一致。 */
export const NATIVE_PROBE_GRID_LAYOUT_VERSION = 2;
/** 级联最大层数,与 Rust PROBE_GI_GRID_MAX_LEVELS 一致。 */
export const NATIVE_PROBE_GRID_MAX_LEVELS = 4;
/** v2 布局头保留区字:0=版本、1=levelCount、2=levels 起始记录号(恒 1)。 */
const LAYOUT_RESERVED_LEVELS_START = 1;

export interface NativeProbeGridLevel {
  readonly origin: readonly [number, number, number];
  readonly spacing: number;
  readonly gridSize: readonly [number, number, number];
}

export interface NativeProbeGridProbe {
  readonly irradiance: readonly [number, number, number];
  readonly validity: number;
  readonly meanDistance: number;
  readonly distanceVariance: number;
  readonly occlusionFloor?: number;
  readonly positionOffset?: readonly [number, number, number];
}

export type NativeProbeGridPackError =
  | "invalid-spacing"
  | "invalid-origin"
  | "invalid-grid-size"
  | "probe-count-mismatch"
  | "probe-budget-exceeded"
  | "invalid-probe-record"
  | "invalid-level-count"
  | "invalid-level-nesting";

/** 校验单层几何与探针字段;任何非法输入在写第一个字节前抛错。 */
function validateLevel(level: NativeProbeGridLevel, probes: readonly NativeProbeGridProbe[]): number {
  const [ox, oy, oz] = level.origin;
  const [gx, gy, gz] = level.gridSize;
  if (!(Number.isFinite(level.spacing) && level.spacing > 0 && level.spacing <= 1_000_000)) {
    throw new RangeError(`native-probe-grid: invalid-spacing ${level.spacing}`);
  }
  if (![ox, oy, oz].every(value => Number.isFinite(value) && Math.abs(value) <= 1_000_000_000)) {
    throw new RangeError("native-probe-grid: invalid-origin");
  }
  if (![gx, gy, gz].every(value => Number.isSafeInteger(value) && value >= 2 && value <= 64)) {
    throw new RangeError("native-probe-grid: invalid-grid-size");
  }
  const count = gx * gy * gz;
  if (probes.length !== count) {
    throw new RangeError(`native-probe-grid: probe-count-mismatch ${probes.length} != ${count}`);
  }
  if (count > NATIVE_PROBE_GRID_MAX_PROBES) {
    throw new RangeError(`native-probe-grid: probe-budget-exceeded ${count}`);
  }
  const maxPosition: readonly [number, number, number] = [
    ox + gx * level.spacing, oy + gy * level.spacing, oz + gz * level.spacing,
  ];
  if (!maxPosition.every(value => Number.isFinite(value) && Math.abs(value) <= 1_000_000_000)) {
    throw new RangeError("native-probe-grid: invalid-origin");
  }
  for (const probe of probes) {
    validateProbe(probe, level.spacing);
  }
  return count;
}

/** 写一个网格头记录(24 个 f32 小端,与 Rust IrradianceProbeRecord 字段顺序一致)。 */
function writeGridHeader(words: DataView, recordIndex: number, level: NativeProbeGridLevel,
  count: number, baseProbeRecords: number): void {
  const [ox, oy, oz] = level.origin;
  const [gx, gy, gz] = level.gridSize;
  const writeWord = (index: number, value: number) => words.setFloat32(index * 4, value, true);
  const first = recordIndex * 24;
  writeWord(first + 0, ox); writeWord(first + 1, oy); writeWord(first + 2, oz);
  writeWord(first + 3, level.spacing);
  writeWord(first + 4, gx); writeWord(first + 5, gy); writeWord(first + 6, gz);
  writeWord(first + 7, baseProbeRecords);
  writeWord(first + 8, ox + gx * level.spacing);
  writeWord(first + 9, oy + gy * level.spacing);
  writeWord(first + 10, oz + gz * level.spacing);
  writeWord(first + 11, count);
  // words[12..24] 保持零(与 Native reserved 合同一致),ArrayBuffer 本就零初始化。
}

function appendProbes(output: ArrayBuffer, recordOffset: number, probes: readonly NativeProbeGridProbe[]): void {
  probes.forEach((probe, index) => {
    const record = packIrradianceProbeRecord({
      irradiance: probe.irradiance,
      validity: probe.validity,
      meanDistance: probe.meanDistance,
      distanceVariance: probe.distanceVariance,
      ...(probe.occlusionFloor === undefined ? {} : { occlusionFloor: probe.occlusionFloor }),
      ...(probe.positionOffset === undefined ? {} : { positionOffset: probe.positionOffset }),
    });
    new Uint8Array(output, (recordOffset + index) * DEEP_GI_PROBE_RECORD_BYTES, DEEP_GI_PROBE_RECORD_BYTES)
      .set(new Uint8Array(record));
  });
}

/** 打包旧单层合同"网格头 + 探针记录";输出与历史版本逐字节一致。 */
export function packNativeProbeGridRecords(
  level: NativeProbeGridLevel,
  probes: readonly NativeProbeGridProbe[],
): ArrayBuffer {
  const count = validateLevel(level, probes);
  const output = new ArrayBuffer((1 + count) * DEEP_GI_PROBE_RECORD_BYTES);
  writeGridHeader(new DataView(output), 0, level, count, 1);
  appendProbes(output, 1, probes);
  return output;
}

export interface NativeProbeGridLevelInput {
  readonly level: NativeProbeGridLevel;
  readonly probes: readonly NativeProbeGridProbe[];
}

/**
 * 打包 v2 多层级联记录流:record 0 = 布局头,随后每层"网格头 + 探针"按细→粗
 * 顺序排布。层级内容与层间嵌套(粗层 spacing 严格更大、范围包含细层)全部
 * fail-closed 校验;总记录数不超过 Native storage 预算。
 */
export function packNativeProbeGridLevels(
  levels: readonly NativeProbeGridLevelInput[],
): ArrayBuffer {
  if (!(levels.length >= 1 && levels.length <= NATIVE_PROBE_GRID_MAX_LEVELS)) {
    throw new RangeError(`native-probe-grid: invalid-level-count ${levels.length}`);
  }
  const counts = levels.map(({ level, probes }) => validateLevel(level, probes));
  let total = 1; // 布局头
  for (const [index, count] of counts.entries()) {
    total += 1 + count;
    if (total > NATIVE_PROBE_GRID_MAX_PROBES) {
      throw new RangeError(`native-probe-grid: probe-budget-exceeded ${total}`);
    }
    // 层间嵌套:粗层 spacing 严格更大,粗层范围逐轴包含细层范围。
    if (index > 0) {
      const fine = levels[index - 1]!.level, coarse = levels[index]!.level;
      const fineMax = fine.gridSize.map((size, axis) => fine.origin[axis]! + size * fine.spacing);
      const coarseMax = coarse.gridSize.map((size, axis) => coarse.origin[axis]! + size * coarse.spacing);
      const nested = coarse.spacing > fine.spacing
        && coarse.origin.every((value, axis) => value <= fine.origin[axis]!)
        && coarseMax.every((value, axis) => value >= fineMax[axis]!);
      if (!nested) {
        throw new RangeError(`native-probe-grid: invalid-level-nesting ${index}`);
      }
    }
  }
  const output = new ArrayBuffer(total * DEEP_GI_PROBE_RECORD_BYTES);
  const words = new DataView(output);
  // v2 布局头:主 12 字全零,保留区 [版本, levelCount, levels 起始, 0...]。
  words.setFloat32((12 + 0) * 4, NATIVE_PROBE_GRID_LAYOUT_VERSION, true);
  words.setFloat32((12 + 1) * 4, levels.length, true);
  words.setFloat32((12 + 2) * 4, LAYOUT_RESERVED_LEVELS_START, true);
  let recordCursor = LAYOUT_RESERVED_LEVELS_START;
  levels.forEach(({ level }, index) => {
    // baseProbeRecords = 布局头 + 前面所有层全部记录 + 本层网格头。
    const baseProbeRecords = recordCursor + 1;
    writeGridHeader(words, recordCursor, level, counts[index]!, baseProbeRecords);
    recordCursor += 1;
    appendProbes(output, recordCursor, levels[index]!.probes);
    recordCursor += counts[index]!;
  });
  return output;
}

function validateProbe(probe: NativeProbeGridProbe, spacing: number): void {
  const [rx, gy, bz] = probe.irradiance;
  const finiteBounded = (value: number, limit: number) => Number.isFinite(value) && Math.abs(value) <= limit;
  const irradianceOk = [rx, gy, bz].every(value => Number.isFinite(value) && value >= 0 && value <= 65_504);
  const offset = probe.positionOffset ?? [0, 0, 0];
  const offsetOk = offset.length === 3 && offset.every(value => finiteBounded(value, spacing));
  if (!irradianceOk
    || !(Number.isFinite(probe.validity) && probe.validity >= 0 && probe.validity <= 1)
    || !(Number.isFinite(probe.meanDistance) && probe.meanDistance >= 0 && probe.meanDistance <= 1_000_000)
    || !(Number.isFinite(probe.distanceVariance) && probe.distanceVariance >= 0 && probe.distanceVariance <= 1_000_000_000_000)
    || !((probe.occlusionFloor ?? 0) >= 0 && (probe.occlusionFloor ?? 0) <= 1)
    || !offsetOk
  ) {
    throw new RangeError("native-probe-grid: invalid-probe-record");
  }
}
