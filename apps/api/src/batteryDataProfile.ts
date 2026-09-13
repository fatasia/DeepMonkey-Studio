type BatteryRecord = Record<string, string | number>;

export function batteryDataProfile(records: BatteryRecord[]): Record<string, unknown> {
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
  })).filter((item): item is { cellId: string; moduleId: string; sohPct: number } => item.sohPct !== undefined);
  if (values.length < 2) return undefined;
  values.sort((left, right) => left.sohPct - right.sohPct);
  const weakest = values[0]!;
  const mean = values.reduce((sum, item) => sum + item.sohPct, 0) / values.length;
  const spread = values.at(-1)!.sohPct - weakest.sohPct;
  return {
    assessedCells: values.length,
    meanSohPct: round(mean, 3),
    weakestSohPct: round(weakest.sohPct, 3),
    sohSpreadPct: round(spread, 3),
    weakestCellId: weakest.cellId,
    ...(weakest.moduleId ? { weakestModuleId: weakest.moduleId } : {}),
    riskLevel: spread >= 5 ? "high" : spread >= 2 ? "medium" : "low",
  };
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
