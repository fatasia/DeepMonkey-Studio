import type { PlantLiteStudyRecord } from "@bim-studio/contracts";

export interface PlantLiteMeasurementWindow {
  totalMinutes: number;
  warmupMinutes: number;
  measurementMinutes: number;
}

/** 旧记录未保存 warmupMinutes，按合同明确解释为零预热。 */
export function plantLiteMeasurementWindow(study: PlantLiteStudyRecord): PlantLiteMeasurementWindow {
  const totalMinutes = study.execution.limits.durationMinutes;
  const warmupMinutes = study.execution.limits.warmupMinutes ?? 0;
  return { totalMinutes, warmupMinutes, measurementMinutes: Math.max(0, totalMinutes - warmupMinutes) };
}

export function plantLiteMeasurementEvidenceText(study: PlantLiteStudyRecord): string {
  const window = plantLiteMeasurementWindow(study);
  return `总运行 ${formatMinutes(window.totalMinutes)} · 预热 ${formatMinutes(window.warmupMinutes)} · 正式统计 ${formatMinutes(window.measurementMinutes)}；系统从空状态连续运行，指标只采集正式窗口。`;
}

function formatMinutes(value: number): string {
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 分钟`;
}
