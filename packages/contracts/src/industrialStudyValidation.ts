import type { IndustrialStudyRecord } from "./industrialStudy.js";

export type IndustrialStudyEvidenceGap =
  | "scenario-input"
  | "execution"
  | "input-fingerprint"
  | "scene-fingerprint"
  | "model-fingerprint"
  | "version-fingerprint"
  | "result-evidence";

/** 根据记录实际引用的上下文判断证据完整性，不要求无场景的 What-if 伪造场景/模型证据。 */
export function industrialStudyEvidenceGaps(record: IndustrialStudyRecord): IndustrialStudyEvidenceGap[] {
  const gaps: IndustrialStudyEvidenceGap[] = [];
  if (record.scenarioInput === null) gaps.push("scenario-input");
  if (!record.execution) gaps.push("execution");
  if (!record.fingerprints.input) gaps.push("input-fingerprint");
  if (record.context.sceneId && !record.fingerprints.scene) gaps.push("scene-fingerprint");
  if (record.context.objectIds.length > 0 && !record.fingerprints.model) gaps.push("model-fingerprint");
  if (!record.fingerprints.version) gaps.push("version-fingerprint");
  if (record.result && !record.fingerprints.evidence) gaps.push("result-evidence");
  return gaps;
}
