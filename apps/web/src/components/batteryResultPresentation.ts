export type BatteryAnalysisTask = "soc" | "soh" | "rul";

export interface BatteryTrendPoint {
  x: number;
  y: number;
}

/** 只从模型真实输出提取轨迹；数据不足时返回空数组，不补点或生成演示曲线。 */
export function batteryTrendPoints(
  task: BatteryAnalysisTask,
  result: Record<string, unknown>,
): BatteryTrendPoint[] {
  if (task === "soc") return arrayValue(result.points).flatMap((item, index) => {
    const point = objectValue(item);
    const y = finiteNumber(point?.estimatedSoc);
    if (y === undefined) return [];
    return [{ x: finiteNumber(point?.time) ?? index, y }];
  });
  if (task === "rul") return arrayValue(result.sohCurve).flatMap((item, index) => {
    const point = objectValue(item);
    const y = finiteNumber(point?.soh);
    if (y === undefined) return [];
    return [{ x: finiteNumber(point?.cycle) ?? index + 1, y }];
  });
  return [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
