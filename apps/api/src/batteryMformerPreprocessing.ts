import type { BatteryPredictionInput } from "./batteryModelGateway.js";

export interface BatteryMformerModelMetadata {
  earlyCycles: number;
  curveLength: number;
  conditionEmbeddingSize: number;
  predictionLength: number;
  eolThreshold: number;
  confidenceGate?: {
    passed?: boolean;
    test_mape?: number;
    test_mae?: number;
    training_datasets?: string[];
  };
}

export interface PreparedBatteryMformerInput {
  curves: Float32Array;
  curveMask: Float32Array;
  sohInput: Float32Array;
  cycleFeatures: Float32Array;
  observedSohFull: Float32Array;
  observedCycleNumbers: Int32Array;
  observedCycles: number;
  nominalCapacityAh: number;
  warnings: string[];
}

type RecordRow = BatteryPredictionInput["records"][number];

/**
 * 将上传循环记录转换为正式 BatteryMFormer 的五输入合同。
 * 算法保持源工程的缺失值填充、SOC 对齐插值和末圈掩码语义。
 */
export function prepareBatteryMformerInput(
  input: BatteryPredictionInput,
  model: BatteryMformerModelMetadata,
): PreparedBatteryMformerInput {
  assertModelShape(model);
  const grouped = groupCycles(input.records);
  if (grouped.length === 0) throw new Error("BatteryMFormer 输入缺少 cycle 字段");
  const nominalFromRecords = firstPositive(input.records, "nominalCapacityAh");
  const allCapacities = positiveValues(input.records, "capacityAh");
  const nominal = input.nominalCapacityAh ?? nominalFromRecords ?? (allCapacities.length > 0 ? Math.max(...allCapacities) : undefined);
  if (!nominal || !Number.isFinite(nominal) || nominal <= 0) throw new Error("BatteryMFormer 需要 capacityAh 或配置额定容量");
  const warnings = input.nominalCapacityAh || nominalFromRecords ? [] : ["未配置额定容量，使用上传数据中的最大容量近似。"];

  const curves = new Float32Array(model.earlyCycles * 4 * model.curveLength);
  const curveMask = new Float32Array(model.earlyCycles);
  const sohInput = new Float32Array(model.earlyCycles);
  const cycleFeatures = new Float32Array(model.earlyCycles * 2);
  const availableCycles = Math.min(grouped.length, model.earlyCycles);
  curveMask.fill(1, 0, availableCycles);
  // 源加载器最后一个已提供循环只保留 SOH/mask，曲线位置保持零值。
  const curveCycleCount = Math.min(model.earlyCycles, Math.max(0, grouped.length - 1));
  const observed = observedHealth(grouped);
  for (let index = 0; index < availableCycles; index += 1) {
    sohInput[index] = (observed.soh[index]! - model.eolThreshold) / Math.max(1 - model.eolThreshold, 1e-6);
  }

  const filePrefix = batteryFilePrefix(input.fileName);
  const dischargeFirst = new Set(["RWTH", "CALB_0", "CALB_25", "CALB_45"]).has(filePrefix);
  const half = Math.floor(model.curveLength / 2);
  let usable = 0;
  for (let outputIndex = 0; outputIndex < curveCycleCount; outputIndex += 1) {
    const rows = grouped[outputIndex]![1];
    const [time, voltage, current, chargeCapacity, dischargeCapacity] = cycleArrays(rows);
    const cRate = current.map((value) => value / nominal);
    const chargeEnd = lastIndex(cRate, (value) => value >= 0.01);
    const dischargeEnd = lastIndex(cRate, (value) => value <= -0.01);
    if (chargeEnd < 0 || dischargeEnd < 0) continue;

    let rawCharge: CurvePhase;
    let rawDischarge: CurvePhase;
    if (dischargeFirst) {
      rawDischarge = phase(voltage.slice(0, dischargeEnd), current.slice(0, dischargeEnd), dischargeCapacity.slice(0, dischargeEnd), time.slice(0, dischargeEnd));
      rawCharge = phase(voltage.slice(dischargeEnd), current.slice(dischargeEnd), chargeCapacity.slice(dischargeEnd), time.slice(dischargeEnd));
      rawCharge = filterPhase(rawCharge, (_, index) => Math.abs(rawCharge.current[index]! / nominal) > 0.01);
    } else {
      rawDischarge = phase(voltage.slice(chargeEnd), current.slice(chargeEnd), dischargeCapacity.slice(chargeEnd), time.slice(chargeEnd));
      rawDischarge = filterPhase(rawDischarge, (_, index) => Math.abs(rawDischarge.current[index]! / nominal) > 0.01);
      rawCharge = phase(voltage.slice(0, chargeEnd), current.slice(0, chargeEnd), chargeCapacity.slice(0, chargeEnd), time.slice(0, chargeEnd));
    }
    if (rawCharge.voltage.length === 0 || rawDischarge.voltage.length === 0) continue;

    const chargeDelta = Math.max(range(rawCharge.capacity), 1e-6);
    const dischargeDelta = Math.max(range(rawDischarge.capacity), 1e-6);
    const chargeSoc = rawCharge.capacity.map((value) => (value - rawCharge.capacity[0]!) / chargeDelta);
    const dischargeSoc = rawDischarge.capacity.map((value) => 1 - (value - rawDischarge.capacity[0]!) / dischargeDelta);
    const charge = socResample(rawCharge, chargeSoc, half, true);
    const discharge = socResample(rawDischarge, dischargeSoc, model.curveLength - half, false);
    writeCurve(curves, outputIndex, 0, model.curveLength, [...charge.voltage, ...discharge.voltage]);
    writeCurve(curves, outputIndex, 1, model.curveLength, [...charge.current, ...discharge.current].map((value) => value / nominal));
    writeCurve(curves, outputIndex, 2, model.curveLength, [...charge.capacity, ...discharge.capacity]);
    writeCurve(curves, outputIndex, 3, model.curveLength, [...charge.soc, ...discharge.soc]);
    cycleFeatures[outputIndex * 2] = maximum(discharge.capacity) / Math.max(maximum(charge.capacity), 1e-6);
    cycleFeatures[outputIndex * 2 + 1] = energy(rawDischarge) / Math.max(energy(rawCharge), 1e-6);
    usable += 1;
  }

  if (usable < Math.max(3, Math.min(model.earlyCycles, 10))) {
    throw new Error(`BatteryMFormer 有效完整循环不足：${usable}/${model.earlyCycles}；每圈必须同时包含充电和放电采样`);
  }
  if (availableCycles < model.earlyCycles) warnings.push(`仅获得 ${availableCycles}/${model.earlyCycles} 个早期循环，其余位置使用掩码填充。`);
  return {
    curves,
    curveMask,
    sohInput,
    cycleFeatures,
    observedSohFull: Float32Array.from(observed.soh),
    observedCycleNumbers: Int32Array.from(observed.cycleNumbers),
    observedCycles: availableCycles,
    nominalCapacityAh: nominal,
    warnings,
  };
}

interface CurvePhase {
  voltage: number[];
  current: number[];
  capacity: number[];
  time: number[];
}

interface ResampledPhase extends Omit<CurvePhase, "time"> {
  soc: number[];
}

function socResample(source: CurvePhase, rawSoc: number[], length: number, isCharge: boolean): ResampledPhase {
  if (rawSoc.length < 2 || source.voltage.length < 2) {
    return {
      voltage: resample(source.voltage, length), current: resample(source.current, length),
      capacity: resample(source.capacity, length), soc: resample(rawSoc, length),
    };
  }
  const soc = sanitize(rawSoc);
  const monotonic: number[] = [];
  for (const value of soc) {
    const previous = monotonic.at(-1);
    monotonic.push(previous === undefined ? value : isCharge ? Math.max(previous, value) : Math.min(previous, value));
  }
  const valid = monotonic.map((value, index) => index === 0 || (isCharge ? value - monotonic[index - 1]! > 1e-8 : value - monotonic[index - 1]! < -1e-8));
  if (valid.filter(Boolean).length < 2) {
    return {
      voltage: resample(source.voltage, length), current: resample(source.current, length),
      capacity: resample(source.capacity, length), soc: resample(rawSoc, length),
    };
  }
  let sourceSoc = monotonic.filter((_, index) => valid[index]);
  let voltage = sanitize(source.voltage).filter((_, index) => valid[index]);
  let current = sanitize(source.current).filter((_, index) => valid[index]);
  let capacity = sanitize(source.capacity).filter((_, index) => valid[index]);
  let targetSoc = linspace(Math.min(...sourceSoc), Math.max(...sourceSoc), length);
  if (!isCharge) {
    sourceSoc = sourceSoc.reverse();
    voltage = voltage.reverse();
    current = current.reverse();
    capacity = capacity.reverse();
    targetSoc = targetSoc.reverse();
  }
  return {
    voltage: targetSoc.map((value) => interpolate(value, sourceSoc, voltage)),
    current: targetSoc.map((value) => interpolate(value, sourceSoc, current)),
    capacity: targetSoc.map((value) => interpolate(value, sourceSoc, capacity)),
    soc: targetSoc,
  };
}

function cycleArrays(rows: RecordRow[]): [number[], number[], number[], number[], number[]] {
  const matrix = [...rows].sort((left, right) => (numeric(left.time) ?? 0) - (numeric(right.time) ?? 0)).map((row) => [
    numeric(row.time), numeric(row.voltage), numeric(row.current), numeric(row.chargeCapacityAh), numeric(row.capacityAh),
  ].map((value) => value ?? Number.NaN));
  for (const row of matrix) if (row[3]! < 0 || row[4]! < 0) row.fill(Number.NaN);
  fillMissing(matrix);
  return [0, 1, 2, 3, 4].map((column) => matrix.map((row) => Number.isFinite(row[column]) ? row[column]! : 0)) as [number[], number[], number[], number[], number[]];
}

function fillMissing(matrix: number[][]): void {
  for (let column = 0; column < 5; column += 1) {
    let next = Number.NaN;
    for (let index = matrix.length - 1; index >= 0; index -= 1) {
      const value = matrix[index]![column]!;
      if (Number.isFinite(value)) next = value;
      else if (Number.isFinite(next)) matrix[index]![column] = next;
    }
    let previous = Number.NaN;
    for (let index = 0; index < matrix.length; index += 1) {
      const value = matrix[index]![column]!;
      if (Number.isFinite(value)) previous = value;
      else if (Number.isFinite(previous)) matrix[index]![column] = previous;
    }
  }
}

function observedHealth(grouped: Array<[number, RecordRow[]]>): { soh: number[]; cycleNumbers: number[] } {
  const capacities = grouped.map(([, rows]) => maximum(rows.map((row) => numeric(row.capacityAh)).filter((value): value is number => value !== undefined && value >= 0)));
  const reference = capacities.find((value) => value > 0) ?? 0;
  const soh = grouped.map(([, rows], index) => {
    let value = rows.map((row) => numeric(row.soh)).find((candidate) => candidate !== undefined);
    if (value === undefined) value = reference ? capacities[index]! / reference : 0;
    else if (value > 1.5) value /= 100;
    return value;
  });
  return { soh, cycleNumbers: grouped.map(([cycle]) => cycle) };
}

function groupCycles(records: BatteryPredictionInput["records"]): Array<[number, RecordRow[]]> {
  const grouped = new Map<number, RecordRow[]>();
  for (const record of records) {
    const cycle = numeric(record.cycle);
    if (cycle === undefined || cycle < 0) continue;
    const key = Math.round(cycle);
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  return [...grouped.entries()].sort(([left], [right]) => left - right);
}

function energy(source: CurvePhase): number {
  let total = 0;
  for (let index = 0; index + 1 < source.voltage.length; index += 1) {
    const left = source.voltage[index]! * Math.abs(source.current[index]!);
    const right = source.voltage[index + 1]! * Math.abs(source.current[index + 1]!);
    total += (left + right) * 0.5 * ((source.time[index + 1]! - source.time[index]!) / 3600);
  }
  return total;
}

function filterPhase(source: CurvePhase, predicate: (value: number, index: number) => boolean): CurvePhase {
  const indices = source.voltage.map((value, index) => predicate(value, index) ? index : -1).filter((index) => index >= 0);
  return phase(
    indices.map((index) => source.voltage[index]!), indices.map((index) => source.current[index]!),
    indices.map((index) => source.capacity[index]!), indices.map((index) => source.time[index]!),
  );
}

function phase(voltage: number[], current: number[], capacity: number[], time: number[]): CurvePhase {
  return { voltage, current, capacity, time };
}

function resample(source: number[], length: number): number[] {
  if (source.length === 0) return Array.from({ length }, () => 0);
  if (source.length === 1) return Array.from({ length }, () => source[0]!);
  return Array.from({ length }, (_, index) => {
    const position = index / Math.max(1, length - 1) * (source.length - 1);
    const left = Math.floor(position);
    const right = Math.min(source.length - 1, left + 1);
    const ratio = position - left;
    return source[left]! * (1 - ratio) + source[right]! * ratio;
  });
}

function interpolate(value: number, sourceX: number[], sourceY: number[]): number {
  if (value <= sourceX[0]!) return sourceY[0]!;
  if (value >= sourceX.at(-1)!) return sourceY.at(-1)!;
  let right = 1;
  while (right < sourceX.length && sourceX[right]! < value) right += 1;
  const left = right - 1;
  const ratio = (value - sourceX[left]!) / Math.max(sourceX[right]! - sourceX[left]!, 1e-12);
  return sourceY[left]! * (1 - ratio) + sourceY[right]! * ratio;
}

function writeCurve(target: Float32Array, cycle: number, channel: number, length: number, values: number[]): void {
  target.set(Float32Array.from(values), (cycle * 4 + channel) * length);
}

function assertModelShape(model: BatteryMformerModelMetadata): void {
  for (const [label, value] of Object.entries({ earlyCycles: model.earlyCycles, curveLength: model.curveLength, conditionEmbeddingSize: model.conditionEmbeddingSize, predictionLength: model.predictionLength })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`BatteryMFormer ${label} 无效`);
  }
  if (!Number.isFinite(model.eolThreshold) || model.eolThreshold <= 0 || model.eolThreshold >= 1) throw new Error("BatteryMFormer EOL 阈值无效");
}

function batteryFilePrefix(fileName: string): string {
  const parts = fileName.split("_");
  return parts[0] === "CALB" ? parts.slice(0, 2).join("_") : parts[0] ?? "";
}

function positiveValues(records: BatteryPredictionInput["records"], field: string): number[] {
  return records.map((record) => numeric(record[field])).filter((value): value is number => value !== undefined && value > 0);
}

function firstPositive(records: BatteryPredictionInput["records"], field: string): number | undefined {
  return positiveValues(records, field)[0];
}

function numeric(value: unknown): number | undefined {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitize(values: number[]): number[] {
  return values.map((value) => Number.isFinite(value) ? Math.fround(value) : 0);
}

function linspace(start: number, end: number, length: number): number[] {
  if (length <= 1) return [Math.fround(start)];
  return Array.from({ length }, (_, index) => Math.fround(start + (end - start) * index / (length - 1)));
}

function lastIndex(values: number[], predicate: (value: number) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) if (predicate(values[index]!)) return index;
  return -1;
}

function maximum(values: number[]): number {
  return values.length > 0 ? Math.max(...values) : 0;
}

function range(values: number[]): number {
  return values.length > 0 ? Math.max(...values) - Math.min(...values) : 0;
}
