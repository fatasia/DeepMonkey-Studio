import type { BatteryTrendPoint } from "./batteryResultPresentation";

export type BatteryCheckStatus = "pass" | "review" | "unknown";

export interface BatteryVerificationCheck {
  id: string;
  name: string;
  status: BatteryCheckStatus;
  value: string;
  detail: string;
}

export interface BatteryModelDiagnostic {
  task: "soc" | "soh" | "rul";
  name: string;
  confidence: string | undefined;
  version: string;
  runtime: string;
  reason: string;
}

export interface BatteryVerificationInput {
  soc?: Record<string, unknown>;
  soh?: Record<string, unknown>;
  rul?: Record<string, unknown>;
  nominalCapacityAh?: number;
  referenceCycleLife?: number;
}

/** 结论核验只消费模型真实输出；缺少输入时标注待核验，不补估算值。 */
export function batteryVerificationChecks(input: BatteryVerificationInput): BatteryVerificationCheck[] {
  return [
    socBalanceCheck(input),
    crossModelSohCheck(input),
    extrapolationCheck(input),
    lifeBoundaryCheck(input),
  ].filter((check): check is BatteryVerificationCheck => Boolean(check));
}

function socBalanceCheck(input: BatteryVerificationInput): BatteryVerificationCheck | undefined {
  const soc = input.soc;
  if (!soc) return undefined;
  const initialSoc = finite(soc.initialSoc);
  const finalSoc = finite(soc.finalSoc);
  const points = trendPoints(soc.points);
  const capacity = effectiveCapacityAh(input);
  if (initialSoc === undefined || finalSoc === undefined || points.length < 2 || capacity === undefined) {
    return {
      id: "soc-balance", name: "SOC 电量闭环", status: "unknown", value: "待核验",
      detail: "缺少 SOC 序列、有效容量或充放电量，暂不能执行电量闭环。",
    };
  }
  const netAh = points.reduce((sum, point, index) => {
    if (index === 0) return sum;
    const previous = points[index - 1]!;
    const dt = Math.max(0, point.x - previous.x);
    const current = (point.current + previous.current) / 2;
    return sum + current * dt / 3600;
  }, 0);
  const directResidual = Math.abs(finalSoc - clamp(initialSoc + netAh / capacity * 100, 0, 100));
  const invertedResidual = Math.abs(finalSoc - clamp(initialSoc - netAh / capacity * 100, 0, 100));
  const inverted = invertedResidual < directResidual;
  const residual = Math.min(directResidual, invertedResidual);
  const expected = clamp(initialSoc + (inverted ? -netAh : netAh) / capacity * 100, 0, 100);
  return {
    id: "soc-balance",
    name: "SOC 电量闭环",
    status: residual <= 5 ? "pass" : "review",
    value: `残差 ${formatNumber(residual, 2)}%`,
    detail: `按 ${formatNumber(capacity, 2)} Ah 有效容量积分预计末端 ${formatNumber(expected, 2)}%，模型输出为 ${formatNumber(finalSoc, 2)}%。${inverted ? "按放电为正约定积分。" : ""}`,
  };
}

function crossModelSohCheck(input: BatteryVerificationInput): BatteryVerificationCheck | undefined {
  const currentSoh = finite(input.soh?.currentSoh);
  const curve = Array.isArray(input.rul?.sohCurve) ? input.rul.sohCurve : [];
  const observation = record(input.rul?.rulObservation);
  const observedCycles = finite(observation?.observedSurvivalCycles);
  if (currentSoh === undefined || curve.length === 0) return undefined;
  const observedSoh = observedCurveSoh(curve, observedCycles);
  if (observedSoh === undefined) return undefined;
  const deviation = Math.abs(currentSoh - observedSoh);
  return {
    id: "soh-cross-model",
    name: "SOH 双模型一致性",
    status: deviation <= 3 ? "pass" : "review",
    value: `偏差 ${formatNumber(deviation, 1)} pp`,
    detail: `BMSFormer 当前 SOH ${formatNumber(currentSoh, 1)}%，BatteryMFormer 轨迹观测端 ${formatNumber(observedSoh, 1)}%；超过 3 个百分点时按偏低一侧复核。`,
  };
}

function extrapolationCheck(input: BatteryVerificationInput): BatteryVerificationCheck | undefined {
  const predicted = finite(input.rul?.predictedCycleLife);
  const observed = finite(record(input.rul?.rulObservation)?.observedSurvivalCycles);
  if (predicted === undefined || observed === undefined || observed <= 0) return undefined;
  const remaining = Math.max(0, predicted - observed);
  const ratio = remaining / observed;
  return {
    id: "life-extrapolation",
    name: "未来寿命外推距离",
    status: ratio <= 4 ? "pass" : "review",
    value: `${formatNumber(ratio, 2)}×`,
    detail: `已观测 ${formatNumber(observed, 0)} 圈，需继续外推 ${formatNumber(remaining, 0)} 圈至预测寿命 ${formatNumber(predicted, 0)} 圈；未来段超过已观测段 4× 时应补充长循环数据。`,
  };
}

function lifeBoundaryCheck(input: BatteryVerificationInput): BatteryVerificationCheck | undefined {
  const observation = record(input.rul?.rulObservation);
  const lowerBound = finite(observation?.lifetimeLowerBoundCycles);
  const rightCensored = observation?.targetSemantics === "right-censored-lower-bound";
  if (rightCensored && lowerBound !== undefined) {
    const threshold = finite(observation?.targetThresholdPct);
    return {
      id: "life-boundary",
      name: "寿命观测边界",
      status: "pass",
      value: `右删失 · ≥${formatNumber(lowerBound, 0)} 圈`,
      detail: `电芯已实测至 ${formatNumber(lowerBound, 0)} 圈且尚未达到 ${threshold === undefined ? "目标" : formatNumber(threshold, 0)}% SOH；该值是可信寿命下界，模型预测的后续圈数属于外推点估计。`,
    };
  }
  const reference = input.referenceCycleLife;
  if (reference === undefined || reference <= 0 || !input.rul) return undefined;
  const candidates: Array<{ label: string; life: number }> = [];
  const comparison = record(record(input.rul.expertRouting)?.candidateComparison);
  const standard = finite(record(comparison?.standard)?.predictedCycleLife);
  const pinn = finite(record(comparison?.pinn)?.predictedCycleLife);
  if (standard !== undefined) candidates.push({ label: "标准专家", life: standard });
  if (pinn !== undefined) candidates.push({ label: "PINN 影子专家", life: pinn });
  const main = finite(input.rul.predictedCycleLife);
  if (candidates.length === 0 && main !== undefined) candidates.push({ label: "主轨迹", life: main });
  if (candidates.length === 0) return undefined;
  const ranked = candidates.map(candidate => ({
    ...candidate,
    errorPct: Math.abs(candidate.life - reference) / reference * 100,
  })).sort((left, right) => left.errorPct - right.errorPct);
  const best = ranked[0]!;
  return {
    id: "life-boundary",
    name: "参考寿命核验",
    status: best.errorPct <= 20 ? "pass" : "review",
    value: `${best.label}更接近 · 参考 ${formatNumber(reference, 0)} 圈`,
    detail: ranked.map(item => `${item.label}偏差 ${formatNumber(item.errorPct, 1)}%`).join("；") + "。",
  };
}

export function batteryConfidenceDiagnostics(input: BatteryVerificationInput): BatteryModelDiagnostic[] {
  const diagnostics: BatteryModelDiagnostic[] = [];
  if (input.soc) diagnostics.push({
    task: "soc",
    name: "SOCFormer",
    confidence: confidenceValue(input.soc),
    version: versionOf(input.soc),
    runtime: runtimeOf(input.soc),
    reason: strings(input.soc.warnings).find(item => /门槛|回退|checkpoint|参考 SOC|化学体系|域/i.test(item))
      ?? (confidenceValue(input.soc) === "high"
        ? "checkpoint 与本次输入均通过 high 门槛。"
        : "完成本次估计；未满足全部 high 门槛条件，按中等置信处理。"),
  });
  if (input.soh) diagnostics.push({
    task: "soh",
    name: "BMSFormer",
    confidence: confidenceValue(input.soh),
    version: versionOf(input.soh),
    runtime: runtimeOf(input.soh),
    reason: strings(input.soh.warnings)[0] ?? "checkpoint 与化学体系子域均通过验收。",
  });
  if (input.rul) diagnostics.push({
    task: "rul",
    name: "BatteryMFormer",
    confidence: confidenceValue(input.rul),
    version: versionOf(input.rul),
    runtime: runtimeOf(input.rul),
    reason: strings(input.rul.warnings).find(item => /覆盖|子集|工况|门槛/.test(item))
      ?? strings(input.rul.warnings).find(item => /外推/.test(item))
      ?? strings(input.rul.warnings)[0]
      ?? "寿命轨迹模型已参与联合判断。",
  });
  return diagnostics;
}

/** 合并多个模型输出的警告，保持原有顺序去重。 */
export function mergeUniqueText(...lists: unknown[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const item of strings(list)) {
      if (seen.has(item)) continue;
      seen.add(item);
      merged.push(item);
    }
  }
  return merged;
}

/** 综合置信取参与模型中的最低档，不抬高整体结论。 */
export function batteryCombinedConfidence(input: BatteryVerificationInput): string | undefined {
  const ranks = [input.soc, input.soh, input.rul]
    .filter((result): result is Record<string, unknown> => Boolean(result))
    .map(result => confidenceRank(confidenceValue(result)));
  if (!ranks.length) return undefined;
  const lowest = Math.min(...ranks);
  return lowest >= 3 ? "high" : lowest === 2 ? "medium" : "low";
}

function observedCurveSoh(curve: unknown[], observedCycles: number | undefined): number | undefined {
  const points = curve.flatMap(item => {
    const point = record(item);
    const cycle = finite(point?.cycle);
    const soh = finite(point?.soh);
    return cycle === undefined || soh === undefined ? [] : [{ cycle, soh }];
  });
  if (!points.length) return undefined;
  if (observedCycles === undefined) return points[0]!.soh;
  const observed = points.filter(point => point.cycle <= observedCycles);
  return (observed.at(-1) ?? points[0])!.soh;
}

function effectiveCapacityAh(input: BatteryVerificationInput): number | undefined {
  const nominal = input.nominalCapacityAh;
  if (nominal === undefined || nominal <= 0) return undefined;
  const currentSoh = finite(input.soh?.currentSoh);
  return currentSoh === undefined ? nominal : nominal * currentSoh / 100;
}

function trendPoints(value: unknown): Array<BatteryTrendPoint & { current: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const point = record(item);
    const time = finite(point?.time) ?? index;
    const current = finite(point?.current);
    return current === undefined ? [] : [{ x: time, y: finite(point?.estimatedSoc) ?? 0, current }];
  });
}

function confidenceValue(result: Record<string, unknown>): string | undefined {
  return typeof result.confidence === "string" ? result.confidence : undefined;
}

function confidenceRank(confidence: string | undefined): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

function versionOf(result: Record<string, unknown>): string {
  return typeof result.modelVersion === "string" ? result.modelVersion : "—";
}

function runtimeOf(result: Record<string, unknown>): string {
  const runtime = record(result.runtimeExecution);
  if (runtime?.actual === "onnx") return "ONNX Runtime";
  if (runtime?.fellBack === true) return "兼容运行时";
  return typeof runtime?.actual === "string" ? runtime.actual : "—";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatNumber(value: number, digits: number): string {
  return value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
