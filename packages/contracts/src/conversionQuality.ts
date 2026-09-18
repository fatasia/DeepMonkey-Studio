export type ConversionQualityTier = "inspect" | "preview" | "visual-complete" | "engineering-verified";
export type ConversionQualityDimension = "geometry" | "structure" | "identity" | "coordinates" | "dependencies" | "topology" | "accuracy";
export interface ConversionQualityReport {
  schemaVersion: 1;
  profileId: string;
  tier: ConversionQualityTier;
  sourceHash: string;
  checks: { dimension: ConversionQualityDimension; passed: boolean; evidenceSha256?: string; reason?: string }[];
  losses: string[];
  approximations: string[];
}

/** 质量声明只能覆盖明确 profile；inspect/preview 永远不是发布凭证。 */
export function assertConversionQualityReport(value: unknown): asserts value is ConversionQualityReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("转换质量报告必须是对象");
  const report = value as ConversionQualityReport;
  if (report.schemaVersion !== 1 || typeof report.profileId !== "string" || !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(report.profileId)) throw new Error("转换质量 profile 无效");
  if (!["inspect", "preview", "visual-complete", "engineering-verified"].includes(report.tier)) throw new Error("转换质量档无效");
  if (typeof report.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(report.sourceHash)) throw new Error("转换质量源哈希无效");
  for (const list of [report.losses, report.approximations]) {
    if (!Array.isArray(list) || list.some(item => typeof item !== "string" || !item.trim())) throw new Error("转换质量损失与近似项无效");
  }
  if (!Array.isArray(report.checks)) throw new Error("转换质量检查项无效");
  const dimensions = new Set<string>();
  for (const check of report.checks) {
    if (!check || !["geometry", "structure", "identity", "coordinates", "dependencies", "topology", "accuracy"].includes(check.dimension)
      || dimensions.has(check.dimension) || typeof check.passed !== "boolean") throw new Error("转换质量检查维度重复或无效");
    dimensions.add(check.dimension);
    if (check.passed && (typeof check.evidenceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(check.evidenceSha256))) throw new Error("通过的质量检查必须具有证据哈希");
    if (!check.passed && (typeof check.reason !== "string" || !check.reason.trim())) throw new Error("未通过的质量检查必须说明原因");
  }
  if (report.tier === "visual-complete" || report.tier === "engineering-verified") {
    const required = ["geometry", "structure", "identity", "coordinates", "dependencies", ...(report.tier === "engineering-verified" ? ["topology", "accuracy"] : [])];
    if (report.losses.length || required.some(dimension => !report.checks.some(check => check.dimension === dimension && check.passed))) throw new Error("正式质量档缺少完整必需证据或仍有损失");
    if (report.tier === "engineering-verified" && report.approximations.length) throw new Error("工程验证档不能包含未关闭近似项");
  }
}
