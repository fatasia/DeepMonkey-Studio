export type ConversionQualityTier = "inspect" | "preview" | "visual-complete" | "engineering-verified";
export type ConversionQualityDimension = "geometry" | "structure" | "identity" | "coordinates" | "dependencies" | "topology" | "accuracy";

/** 转换引擎的机读运行证据；由转换器在产出 GLB 时如实填写，缺省项不得虚构。 */
export interface ConversionQualityMetrics {
  engine: string;
  workerVersion?: string;
  meshCount?: number;
  triangleCount?: number;
  instanceCount?: number;
  entityCounts?: Record<string, number>;
}

export interface ConversionQualityCheck {
  dimension: ConversionQualityDimension;
  passed: boolean;
  evidenceSha256?: string;
  reason?: string;
}

export interface ConversionQualityReport {
  schemaVersion: 1;
  profileId: string;
  tier: ConversionQualityTier;
  sourceHash: string;
  checks: ConversionQualityCheck[];
  losses: string[];
  approximations: string[];
  metrics?: ConversionQualityMetrics;
}

/** visual-complete 允许显式声明的保真损失，但每条必须可机读，禁止叙述性文字。 */
const LOSS_TAG = /^[a-z0-9][a-z0-9._:-]*$/;
const SAFE_COUNT = (value: number | undefined) => value === undefined || (Number.isSafeInteger(value) && value >= 0);

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
    if (required.some(dimension => !report.checks.some(check => check.dimension === dimension && check.passed))) throw new Error("正式质量档缺少完整必需证据");
    if (report.losses.some(loss => !LOSS_TAG.test(loss))) throw new Error("正式质量档的损失必须是机器可读标签");
    if (report.tier === "engineering-verified" && (report.losses.length || report.approximations.length)) throw new Error("工程验证档不能包含未关闭损失或近似项");
  }
  const metrics = report.metrics;
  if (metrics !== undefined) {
    if (!metrics || typeof metrics !== "object" || typeof metrics.engine !== "string" || !metrics.engine.trim()) throw new Error("转换质量引擎标识无效");
    if (metrics.workerVersion !== undefined && typeof metrics.workerVersion !== "string") throw new Error("转换质量 worker 版本无效");
    if (![metrics.meshCount, metrics.triangleCount, metrics.instanceCount].every(SAFE_COUNT)) throw new Error("转换质量计数无效");
    if (metrics.entityCounts !== undefined) {
      const entries = Object.entries(metrics.entityCounts);
      if (entries.some(([key, count]) => !key.trim() || !Number.isSafeInteger(count) || count < 0)) throw new Error("转换质量实体计数无效");
    }
  }
}

/** 转换器草稿：sourceHash 由执行器用已核验的输入哈希回填，转换器不得自行声称。 */
export type ConversionQualityDraft = Omit<ConversionQualityReport, "sourceHash">;
