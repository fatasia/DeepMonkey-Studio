type BatteryRecord = Record<string, string | number>;

export function batteryDataProfile(records: BatteryRecord[], options: { chemistry?: string } = {}): Record<string, unknown> {
  const fields = new Map<string, string>();
  for (const key of Object.keys(records[0] ?? {})) fields.set(normalize(key), key);
  const cellKey = alias(fields, "cellid", "cell_id", "cell");
  const moduleKey = alias(fields, "moduleid", "module_id", "module");
  const cycleKey = alias(fields, "cycle", "cycleindex", "cycle_index");
  const timeKey = alias(fields, "time", "time_s", "timestamp", "datetime");
  const cellIds = uniqueText(records, cellKey);
  const cycles = uniqueText(records, cycleKey);
  const ranges = {
    currentA: numericRange(records, alias(fields, "current", "current_a", "currenta")),
    voltageV: numericRange(records, alias(fields, "voltage", "voltage_v", "voltagev", "cell_voltage")),
    temperatureC: numericRange(records, alias(fields, "temperature", "temperature_c", "temperaturec", "temp")),
    sohPct: normalizedPercentRange(records, alias(fields, "soh", "soh_pct", "sohpct")),
    capacityAh: numericRange(records, alias(fields, "capacityah", "capacity_ah", "capacity")),
  };
  const packAssessment = cellKey && cellIds.length > 1
    ? assessPack(records, {
        cellKey,
        ...(moduleKey ? { moduleKey } : {}),
        ...(cycleKey ? { cycleKey } : {}),
        ...(timeKey ? { timeKey } : {}),
        ...(alias(fields, "soh", "soh_pct", "sohpct") ? { sohKey: alias(fields, "soh", "soh_pct", "sohpct")! } : {}),
        ...(alias(fields, "capacityah", "capacity_ah", "capacity") ? { capacityKey: alias(fields, "capacityah", "capacity_ah", "capacity")! } : {}),
        ...(alias(fields, "voltage", "voltage_v", "voltagev", "cell_voltage") ? { voltageKey: alias(fields, "voltage", "voltage_v", "voltagev", "cell_voltage")! } : {}),
        ...(alias(fields, "temperature", "temperature_c", "temperaturec", "temp") ? { temperatureKey: alias(fields, "temperature", "temperature_c", "temperaturec", "temp")! } : {}),
        ...(alias(fields, "internalresistancemohm", "resistancemohm", "cellresistancemohm") ? { resistanceMohmKey: alias(fields, "internalresistancemohm", "resistancemohm", "cellresistancemohm")! } : {}),
        ...(alias(fields, "ohmicresistanceohm", "internalresistanceohm", "resistanceohm") ? { resistanceOhmKey: alias(fields, "ohmicresistanceohm", "internalresistanceohm", "resistanceohm")! } : {}),
        ...(alias(fields, "topology") ? { topologyKey: alias(fields, "topology")! } : {}),
        ...(alias(fields, "seriescount", "series") ? { seriesKey: alias(fields, "seriescount", "series")! } : {}),
        ...(alias(fields, "parallelcount", "parallel") ? { parallelKey: alias(fields, "parallelcount", "parallel")! } : {}),
        ...(alias(fields, "nominalcapacityah", "nominalcapacity") ? { nominalCapacityKey: alias(fields, "nominalcapacityah", "nominalcapacity")! } : {}),
        ...(options.chemistry ? { chemistry: options.chemistry } : {}),
      })
    : undefined;
  return {
    rowCount: records.length,
    cellCount: cellIds.length || 1,
    cycleCount: cycles.length,
    ranges: Object.fromEntries(Object.entries(ranges).filter(([, value]) => value !== undefined)),
    ...(packAssessment ? { packAssessment } : {}),
  };
}

function assessPack(records: BatteryRecord[], keys: {
  cellKey: string;
  moduleKey?: string;
  cycleKey?: string;
  timeKey?: string;
  sohKey?: string;
  capacityKey?: string;
  voltageKey?: string;
  temperatureKey?: string;
  resistanceMohmKey?: string;
  resistanceOhmKey?: string;
  topologyKey?: string;
  seriesKey?: string;
  parallelKey?: string;
  nominalCapacityKey?: string;
  chemistry?: string;
}): Record<string, unknown> | undefined {
  if (!keys.sohKey) return undefined;
  const latest = new Map<string, BatteryRecord>();
  for (const row of records) {
    const cell = String(row[keys.cellKey] ?? "").trim();
    if (!cell) continue;
    const previous = latest.get(cell);
    if (!previous || order(row, keys) >= order(previous, keys)) latest.set(cell, row);
  }
  const values = [...latest].map(([cellId, row]) => ({
    cellId,
    moduleId: keys.moduleKey ? String(row[keys.moduleKey] ?? "").trim() : "",
    sohPct: normalizedPercent(row[keys.sohKey!]),
    capacityAh: keys.capacityKey ? numeric(row[keys.capacityKey]) : undefined,
    voltageV: keys.voltageKey ? numeric(row[keys.voltageKey]) : undefined,
    temperatureC: keys.temperatureKey ? numeric(row[keys.temperatureKey]) : undefined,
    resistanceMOhm: keys.resistanceMohmKey
      ? numeric(row[keys.resistanceMohmKey])
      : keys.resistanceOhmKey
        ? (value => value === undefined ? undefined : value * 1000)(numeric(row[keys.resistanceOhmKey]))
        : undefined,
  })).filter((item): item is PackCell & { sohPct: number } => item.sohPct !== undefined);
  if (values.length < 2) return undefined;
  values.sort((left, right) => left.sohPct - right.sohPct);
  const weakest = values[0]!;
  const meanSoh = mean(values.map(item => item.sohPct))!;
  const sohSpread = spread(values.map(item => item.sohPct))!;
  const capacityValues = finite(values.map(item => item.capacityAh));
  const voltageValues = finite(values.map(item => item.voltageV));
  const temperatureValues = finite(values.map(item => item.temperatureC));
  const resistanceValues = finite(values.map(item => item.resistanceMOhm));
  const capacityCvPct = coefficientOfVariation(capacityValues);
  const voltageSpreadMv = (value => value === undefined ? undefined : value * 1000)(spread(voltageValues));
  const temperatureSpreadC = spread(temperatureValues);
  const resistanceSpreadPct = (() => {
    const range = spread(resistanceValues);
    const average = mean(resistanceValues);
    return range === undefined || average === undefined || average === 0 ? undefined : range / average * 100;
  })();
  const medianCapacityAh = median(capacityValues);
  const weakestCells = values.slice(0, 3).map(item => ({
    cellId: item.cellId,
    ...(item.moduleId ? { moduleId: item.moduleId } : {}),
    sohPct: round(item.sohPct, 3),
    ...(item.capacityAh !== undefined ? { capacityAh: round(item.capacityAh, 4) } : {}),
    ...(medianCapacityAh !== undefined && item.capacityAh !== undefined && medianCapacityAh > 0
      ? { capacityDeviationPct: round((item.capacityAh - medianCapacityAh) / medianCapacityAh * 100, 3) }
      : {}),
  }));
  const riskLevel = sohSpread >= 5
    || (voltageSpreadMv ?? 0) >= 80
    || (temperatureSpreadC ?? 0) >= 5
    || (resistanceSpreadPct ?? 0) >= 25
    ? "high"
    : sohSpread >= 2
      || (capacityCvPct ?? 0) >= 1.5
      || (voltageSpreadMv ?? 0) >= 30
      || (temperatureSpreadC ?? 0) >= 3
      || (resistanceSpreadPct ?? 0) >= 15
      ? "review"
      : "stable";
  const riskReasons = [
    sohSpread >= 2 ? `SOH 极差 ${sohSpread.toFixed(1)}%` : undefined,
    voltageSpreadMv !== undefined && voltageSpreadMv >= 30 ? `末端压差 ${voltageSpreadMv.toFixed(0)} mV` : undefined,
    temperatureSpreadC !== undefined && temperatureSpreadC >= 3 ? `温差 ${temperatureSpreadC.toFixed(1)}°C` : undefined,
    resistanceSpreadPct !== undefined && resistanceSpreadPct >= 15 ? `内阻极差 ${resistanceSpreadPct.toFixed(1)}%` : undefined,
  ].filter((item): item is string => Boolean(item));
  const conclusion = riskLevel === "high"
    ? `Pack 已出现显著不一致，${weakest.cellId} 正在限制可用容量与能量，不建议只看平均 SOH。`
    : riskLevel === "review"
      ? "Pack 存在早期离散迹象，建议缩短复检周期并持续跟踪弱电芯排序。"
      : "本次数据中未发现明显离散风险，可继续按当前周期监控。";
  const recommendations = [
    `优先复测 ${weakest.cellId}${weakest.moduleId ? `（${weakest.moduleId}）` : ""} 的容量、内阻与采样线。`,
    voltageSpreadMv !== undefined && voltageSpreadMv >= 30
      ? "执行静置复测与均衡检查，排除 SOC 不一致或采样偏差。"
      : "保持现有均衡策略并持续记录末端压差。",
    resistanceSpreadPct !== undefined && resistanceSpreadPct >= 15
      ? "检查连接件与内阻增长；确认后再决定降额、重组或更换。"
      : "将弱电芯排序和离散指标纳入下一次维护复核。",
  ];
  const energy = packEnergy(records, values, keys);
  return {
    assessedCells: values.length,
    meanSohPct: round(meanSoh, 3),
    weakestSohPct: round(weakest.sohPct, 3),
    sohSpreadPct: round(sohSpread, 3),
    weakestCellId: weakest.cellId,
    ...(weakest.moduleId ? { weakestModuleId: weakest.moduleId } : {}),
    riskLevel,
    riskReasons,
    conclusion,
    recommendations,
    weakestCells,
    finding: `${weakest.cellId}${weakest.moduleId ? ` / ${weakest.moduleId}` : ""} 限制 Pack 可用能力`,
    ...(capacityCvPct !== undefined ? { capacityCvPct: round(capacityCvPct, 3) } : {}),
    ...(voltageSpreadMv !== undefined ? { voltageSpreadMv: round(voltageSpreadMv, 1) } : {}),
    ...(temperatureSpreadC !== undefined ? { temperatureSpreadC: round(temperatureSpreadC, 3) } : {}),
    ...(resistanceSpreadPct !== undefined ? { resistanceSpreadPct: round(resistanceSpreadPct, 3) } : {}),
    ...(energy ?? {}),
  };
}

interface PackCell {
  cellId: string;
  moduleId: string;
  sohPct: number | undefined;
  capacityAh: number | undefined;
  voltageV: number | undefined;
  temperatureC: number | undefined;
  resistanceMOhm: number | undefined;
}

/** 拓扑齐全时按最弱电芯折算 Pack 可用容量与能量；只使用实测字段，不补虚拟值。 */
function packEnergy(
  records: BatteryRecord[],
  values: Array<PackCell & { sohPct: number }>,
  keys: { topologyKey?: string; seriesKey?: string; parallelKey?: string; nominalCapacityKey?: string; chemistry?: string },
): Record<string, unknown> | undefined {
  if (!keys.seriesKey || !keys.parallelKey) return undefined;
  const row = records.find(item => numeric(item[keys.seriesKey!]) !== undefined && numeric(item[keys.parallelKey!]) !== undefined);
  const series = row ? numeric(row[keys.seriesKey]) : undefined;
  const parallel = row ? numeric(row[keys.parallelKey]) : undefined;
  if (!series || !parallel) return undefined;
  const limitingCapacityAh = Math.min(...finite(values.map(item => item.capacityAh)));
  if (!Number.isFinite(limitingCapacityAh)) return undefined;
  const nominalCapacityAh = keys.nominalCapacityKey ? numeric(records.find(item => numeric(item[keys.nominalCapacityKey!]) !== undefined)?.[keys.nominalCapacityKey]) : undefined;
  const nominalVoltageV = keys.chemistry === "lfp" ? 3.2 : keys.chemistry === "ncm" ? 3.7 : 3.0;
  const packCapacityAh = limitingCapacityAh * parallel;
  const packEnergyKwh = series * nominalVoltageV * packCapacityAh / 1000;
  const nominalPackEnergyKwh = nominalCapacityAh === undefined
    ? undefined
    : series * nominalVoltageV * nominalCapacityAh * parallel / 1000;
  const energyLossPct = nominalPackEnergyKwh === undefined || nominalPackEnergyKwh <= 0
    ? undefined
    : Math.max(0, (nominalPackEnergyKwh - packEnergyKwh) / nominalPackEnergyKwh * 100);
  const topologyText = keys.topologyKey ? String(row?.[keys.topologyKey] ?? "").trim() : "";
  return {
    topologyLabel: topologyText || `${series}S${parallel}P`,
    packCapacityAh: round(packCapacityAh, 3),
    packEnergyKwh: round(packEnergyKwh, 4),
    ...(nominalPackEnergyKwh !== undefined ? { nominalPackEnergyKwh: round(nominalPackEnergyKwh, 4) } : {}),
    ...(energyLossPct !== undefined ? { energyLossPct: round(energyLossPct, 3) } : {}),
  };
}

function finite(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => value !== undefined);
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function spread(values: number[]): number | undefined {
  return values.length >= 2 ? Math.max(...values) - Math.min(...values) : undefined;
}

function coefficientOfVariation(values: number[]): number | undefined {
  const average = mean(values);
  if (average === undefined || average === 0 || values.length < 2) return undefined;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance) / average * 100;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle + 1]!) / 2;
}

function order(row: BatteryRecord, keys: { cycleKey?: string; timeKey?: string }): number {
  const cycle = keys.cycleKey ? numeric(row[keys.cycleKey]) ?? 0 : 0;
  const time = keys.timeKey ? numeric(row[keys.timeKey]) ?? 0 : 0;
  return cycle * 1_000_000_000 + time;
}

function numericRange(records: BatteryRecord[], key: string | undefined): [number, number] | undefined {
  if (!key) return undefined;
  const values = records.map(row => numeric(row[key])).filter((value): value is number => value !== undefined);
  return values.length ? [Math.min(...values), Math.max(...values)] : undefined;
}

function normalizedPercentRange(records: BatteryRecord[], key: string | undefined): [number, number] | undefined {
  const range = numericRange(records, key);
  if (!range) return undefined;
  return range.map(value => Math.abs(value) <= 1.5 ? value * 100 : value) as [number, number];
}

function normalizedPercent(value: unknown): number | undefined {
  const parsed = numeric(value);
  return parsed === undefined ? undefined : Math.abs(parsed) <= 1.5 ? parsed * 100 : parsed;
}
function numeric(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined; }
function uniqueText(records: BatteryRecord[], key: string | undefined): string[] { return key ? [...new Set(records.map(row => String(row[key] ?? "").trim()).filter(Boolean))] : []; }
function alias(fields: Map<string, string>, ...aliases: string[]): string | undefined { return aliases.map(value => fields.get(normalize(value))).find(Boolean); }
function normalize(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function round(value: number, digits: number): number { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
