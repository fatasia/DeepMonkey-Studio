import type { IndustrialStudyRecord } from "@bim-studio/contracts";

export interface IndustrialStudyComparisonItem {
  key: keyof IndustrialStudyRecord["fingerprints"];
  label: string;
  status: "same" | "changed" | "missing";
}

const LABELS: Record<IndustrialStudyComparisonItem["key"], string> = {
  input: "工况输入",
  scene: "场景",
  model: "模型",
  version: "引擎版本",
  evidence: "结果证据",
};

export function compareIndustrialStudies(
  candidate: IndustrialStudyRecord,
  baseline: IndustrialStudyRecord,
): IndustrialStudyComparisonItem[] {
  return (Object.keys(LABELS) as IndustrialStudyComparisonItem["key"][]).map((key) => {
    const left = candidate.fingerprints[key];
    const right = baseline.fingerprints[key];
    return {
      key,
      label: LABELS[key],
      status: !left || !right ? "missing" : left === right ? "same" : "changed",
    };
  });
}
