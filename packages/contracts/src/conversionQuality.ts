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
  physicsReadiness?: PhysicsReadinessDeclaration;
}

/** 与 T17 collider 生成策略字典对齐；mixed 表示多种策略并存于同一证据文件。 */
export type PhysicsColliderStrategy = "convex-hull" | "simplified-mesh" | "mixed";

/** collider 派生物证据：指向包文件 id 或 sidecar（如 physics:colliders / colliders.json），不得虚构。 */
export interface PhysicsColliderEvidence {
  evidenceId: string;
  strategy: PhysicsColliderStrategy;
  evidenceSha256: string;
  /** true 时 collider 只能按近似体消费（T17 approximate 语义），声明 physics-ready 必须附原因。 */
  approximate?: boolean;
}

/** D1 physics-ready 资产档：两档声明；inspect/preview 质量档永远不得声明 physics-ready。 */
export type PhysicsReadinessTier = "physics-ready" | "geometry-only";

export interface PhysicsReadinessDeclaration {
  tier: PhysicsReadinessTier;
  /** tier=physics-ready 时必填：physics-ready 必须有可追溯 collider 证据。 */
  colliderEvidence?: PhysicsColliderEvidence;
  /** geometry-only 必填原因；physics-ready 且证据 approximate 时必填说明。 */
  reason?: string;
}

/** visual-complete 允许显式声明的保真损失，但每条必须可机读，禁止叙述性文字。 */
const LOSS_TAG = /^[a-z0-9][a-z0-9._:-]*$/;
/** collider 证据 id（如 physics:colliders），与包文件 id / sidecar 名对齐的稳定标识。 */
const PHYSICS_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
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
  const physics = report.physicsReadiness;
  if (physics !== undefined) {
    if (!physics || typeof physics !== "object") throw new Error("physicsReadiness 必须是对象");
    if (!["physics-ready", "geometry-only"].includes(physics.tier)) throw new Error("physicsReadiness 档位无效");
    const evidence = physics.colliderEvidence;
    if (physics.tier === "physics-ready") {
      // physics-ready 必须携带可追溯 collider 证据；inspect/preview 永远不能冒充。
      if (["inspect", "preview"].includes(report.tier)) throw new Error("inspect/preview 质量档不得声明 physics-ready");
      if (!evidence || typeof evidence !== "object") throw new Error("physics-ready 必须携带 collider 证据");
      if (!PHYSICS_EVIDENCE_ID.test(evidence.evidenceId)) throw new Error("collider 证据 id 无效");
      if (!["convex-hull", "simplified-mesh", "mixed"].includes(evidence.strategy)) throw new Error("collider 策略无效");
      if (!/^[a-f0-9]{64}$/.test(evidence.evidenceSha256)) throw new Error("collider 证据哈希无效");
      if (evidence.approximate === true && !(typeof physics.reason === "string" && physics.reason.trim())) throw new Error("近似 collider 的 physics-ready 必须说明原因");
    } else {
      if (!(typeof physics.reason === "string" && physics.reason.trim())) throw new Error("geometry-only 必须说明原因");
      if (evidence !== undefined) {
        if (!evidence || typeof evidence !== "object" || !PHYSICS_EVIDENCE_ID.test(evidence.evidenceId)
          || !["convex-hull", "simplified-mesh", "mixed"].includes(evidence.strategy)
          || !/^[a-f0-9]{64}$/.test(evidence.evidenceSha256)) throw new Error("geometry-only 携带的 collider 证据无效");
      }
    }
  }
}

/** 转换器草稿：sourceHash 由执行器用已核验的输入哈希回填，转换器不得自行声称。 */
export type ConversionQualityDraft = Omit<ConversionQualityReport, "sourceHash">;
