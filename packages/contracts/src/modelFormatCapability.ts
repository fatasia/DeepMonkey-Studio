/** 工业模型格式的产品优先级；被排除的格式仍保留决策记录，避免后续误报支持。 */
export type ModelFormatScope = "core" | "optional" | "excluded";

export type ModelFormatFamily =
  | "runtime-scene"
  | "polygon-mesh"
  | "precise-cad"
  | "bim"
  | "drawing"
  | "scene-description"
  | "product-structure"
  | "quality"
  | "native-authoring"
  | "document-container";

export type ModelFormatDirection = "import" | "export" | "both";

/**
 * `planned` 仅表示进入路线图，不能展示为“已支持”；实现、运行和验证状态必须分别推进。
 */
export type ModelFormatImplementationStatus = "planned" | "in-development" | "implemented" | "excluded";
export type ModelFormatRuntimeStatus = "unavailable" | "degraded" | "available" | "not-applicable";
export type ModelFormatValidationStatus =
  | "unverified"
  | "fixture-validated"
  | "production-validated"
  | "failed"
  | "not-applicable";

export type ModelFormatFidelityDimension =
  | "visual-geometry"
  | "precise-geometry"
  | "assembly-hierarchy"
  | "instances-and-transforms"
  | "materials-and-textures"
  | "object-properties"
  | "pmi"
  | "animation"
  | "drawing-sheets"
  | "coordinate-system";

export type ModelFormatFidelityLevel = "unsupported" | "partial" | "full";

export interface ModelFormatFidelityTarget {
  dimension: ModelFormatFidelityDimension;
  minimum: Exclude<ModelFormatFidelityLevel, "unsupported">;
  required: boolean;
}

export interface ModelFormatValidationEvidence {
  id: string;
  kind: "fixture" | "integration" | "production-sample" | "performance";
  /** 可追溯到报告、制品或测试任务的稳定引用，不能填写不可访问的描述性文字。 */
  reference: string;
  checkedAt: string;
}

export interface ModelFormatCapability {
  id: string;
  label: string;
  extensions: readonly string[];
  family: ModelFormatFamily;
  direction: ModelFormatDirection;
  scope: ModelFormatScope;
  implementationStatus: ModelFormatImplementationStatus;
  runtimeStatus: ModelFormatRuntimeStatus;
  validationStatus: ModelFormatValidationStatus;
  fidelityTargets: readonly ModelFormatFidelityTarget[];
  validatedFidelity: Partial<Record<ModelFormatFidelityDimension, ModelFormatFidelityLevel>>;
  validationEvidence: readonly ModelFormatValidationEvidence[];
  decisionReason: string;
}

const fidelityRank: Record<ModelFormatFidelityLevel, number> = {
  unsupported: 0,
  partial: 1,
  full: 2
};

/**
 * 生产可用是严格判定：仅“代码已实现”或“页面有入口”都不够，必须有运行时和生产样本证据。
 */
export function isModelFormatProductionReady(capability: ModelFormatCapability): boolean {
  if (
    capability.scope === "excluded"
    || capability.implementationStatus !== "implemented"
    || capability.runtimeStatus !== "available"
    || capability.validationStatus !== "production-validated"
    || capability.validationEvidence.length === 0
  ) return false;

  return capability.fidelityTargets
    .filter((target) => target.required)
    .every((target) => {
      const actual = capability.validatedFidelity[target.dimension] ?? "unsupported";
      return fidelityRank[actual] >= fidelityRank[target.minimum];
    });
}

/** 目录一致性检查供 API、管理页和自动门禁共用。 */
export function validateModelFormatCapability(capability: ModelFormatCapability): string[] {
  const issues: string[] = [];
  if (!capability.id.trim()) issues.push("格式 ID 不能为空");
  if (capability.extensions.length === 0) issues.push("至少声明一个扩展名");
  if (capability.extensions.some((extension) => !/^[a-z0-9_]+$/.test(extension))) {
    issues.push("扩展名必须使用不含点号的小写字母、数字或下划线");
  }
  if (new Set(capability.extensions).size !== capability.extensions.length) issues.push("扩展名不能重复");
  if (new Set(capability.fidelityTargets.map((target) => target.dimension)).size !== capability.fidelityTargets.length) {
    issues.push("保真维度不能重复");
  }

  const excluded = capability.scope === "excluded";
  if (excluded && capability.implementationStatus !== "excluded") issues.push("排除格式的实现状态必须为 excluded");
  if (excluded && capability.runtimeStatus !== "not-applicable") issues.push("排除格式的运行状态必须为 not-applicable");
  if (excluded && capability.validationStatus !== "not-applicable") issues.push("排除格式的验证状态必须为 not-applicable");
  if (capability.validationStatus === "production-validated" && capability.validationEvidence.length === 0) {
    issues.push("生产验证必须提供可追溯证据");
  }
  return issues;
}
