import type { IndustrialStudyRecord } from "@bim-studio/contracts";

export type OperationsStudyAction =
  | { kind: "reproduce-plant-lite"; sourceRecordId: string }
  | { kind: "reproduce-what-if"; sourceRecordId: string }
  | { kind: "open-validation-workbench"; sourceRecordId: string };

export function resolveOperationsStudyAction(study: IndustrialStudyRecord): OperationsStudyAction {
  if (study.type === "plant-lite") return { kind: "reproduce-plant-lite", sourceRecordId: study.sourceRecordId };
  if (study.type === "what-if") return { kind: "reproduce-what-if", sourceRecordId: study.sourceRecordId };
  return { kind: "open-validation-workbench", sourceRecordId: study.sourceRecordId };
}
