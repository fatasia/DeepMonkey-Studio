import { DEEP_GI_PROBE_RECORD_BYTES } from "./probeClipmapPlan.js";
import { packIrradianceProbeRecord } from "./probeClipmapSampling.js";

/**
 * F3 Native 探针网格打包:把单层 clipmap 级别的探针数据打包成 Native
 * `probe_gi` storage(binding 11)的"网格头 + 探针记录"扁平数组,
 * 供 `frame.lightDirection.w >= 1.5` 的网格三线性路径消费。
 *
 * 字节布局与 Rust `probe_gi_grid.rs` 逐字对齐(96B 小端 f32 记录):
 * - record 0 = 网格头:words[0..3] origin、[3] spacing、[4..7] gridSize、
 *   [7] baseProbeRecords(恒 1)、[8..11] maxPosition、[11] probeCount、
 *   其余(含保留区)全零。
 * - record 1..N = 探针记录,线性下标 (z*gridY + y)*gridX + x,
 *   由 `packIrradianceProbeRecord` 编码(positionOffset 为重定位增量)。
 *
 * 注意:Native 网格模式是单层合同;多层 clipmap 需要每层一组独立打包
 * (或未来扩展头协议),本函数不做层级混合。
 */

export const NATIVE_PROBE_GRID_MAX_PROBES = 65_536 - 1;

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
  | "invalid-probe-record";

/** 打包"网格头 + 探针记录";任何非法输入在写第一个字节前 fail-closed 抛错。 */
export function packNativeProbeGridRecords(
  level: NativeProbeGridLevel,
  probes: readonly NativeProbeGridProbe[],
): ArrayBuffer {
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

  const output = new ArrayBuffer((1 + count) * DEEP_GI_PROBE_RECORD_BYTES);
  const words = new DataView(output);
  // 网格头:24 个 f32 小端,与 Rust IrradianceProbeRecord 字段顺序一致。
  const writeWord = (index: number, value: number) => words.setFloat32(index * 4, value, true);
  writeWord(0, ox); writeWord(1, oy); writeWord(2, oz); writeWord(3, level.spacing);
  writeWord(4, gx); writeWord(5, gy); writeWord(6, gz); writeWord(7, 1);
  writeWord(8, maxPosition[0]); writeWord(9, maxPosition[1]); writeWord(10, maxPosition[2]);
  writeWord(11, count);
  // words[12..24] 保持零(与 Native reserved 合同一致),ArrayBuffer 本就零初始化。
  probes.forEach((probe, index) => {
    const record = packIrradianceProbeRecord({
      irradiance: probe.irradiance,
      validity: probe.validity,
      meanDistance: probe.meanDistance,
      distanceVariance: probe.distanceVariance,
      ...(probe.occlusionFloor === undefined ? {} : { occlusionFloor: probe.occlusionFloor }),
      ...(probe.positionOffset === undefined ? {} : { positionOffset: probe.positionOffset }),
    });
    new Uint8Array(output, (1 + index) * DEEP_GI_PROBE_RECORD_BYTES, DEEP_GI_PROBE_RECORD_BYTES)
      .set(new Uint8Array(record));
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
