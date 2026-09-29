import type {
  DataDatasetField,
  DataDatasetRecord,
  OntologyActionType,
  OntologyObjectType,
  OntologyPackage,
  OntologyProperty,
  OntologyPublishGateReport,
  OntologyRelationType,
  OntologyStatus,
} from "@bim-studio/contracts";
import { datasetSchemaFingerprint, newOntologyPackage } from "@bim-studio/contracts";
import { inferSemanticRole, type DataSemanticRole } from "../ai/dataSemanticContext";

export type OntologyAssetKind = "objects" | "relations" | "actions";

export const ONTOLOGY_ASSET_KINDS: readonly OntologyAssetKind[] = ["objects", "relations", "actions"];

const ROLE_TYPE_MAP: Record<DataSemanticRole, OntologyProperty["type"]> = {
  device: "string",
  measurementPoint: "string",
  metric: "number",
  space: "string",
  maintenanceEvent: "string",
  time: "datetime",
};

export function newOntologyDraft(owner: string): OntologyPackage {
  return newOntologyPackage("manufacturing", owner);
}

export function ontologyUniqueKey(prefix: string, items: readonly { key: string }[]): string {
  const keys = new Set(items.map((item) => item.key));
  let index = 1;
  while (keys.has(`${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}

export function newObjectDraft(pkg: OntologyPackage): OntologyObjectType {
  return {
    id: crypto.randomUUID(),
    key: ontologyUniqueKey("object", pkg.objects),
    label: "",
    domain: pkg.domain,
    primaryKeys: [],
    properties: [],
    sourceBindings: [],
    aliases: [],
    identityMappings: [],
    status: "draft",
    version: 1,
    owner: pkg.owner,
  };
}

export function newRelationDraft(pkg: OntologyPackage): OntologyRelationType {
  const first = pkg.objects[0]?.key ?? "";
  return {
    id: crypto.randomUUID(),
    key: ontologyUniqueKey("relation", pkg.relations),
    label: "",
    sourceObject: first,
    targetObject: pkg.objects[1]?.key ?? first,
    cardinality: "one-to-many",
    direction: "directed",
    properties: [],
    keyMapping: { sourceField: "", targetField: "" },
    source: { kind: "dataset", note: "" },
    evidence: [],
    status: "draft",
    version: 1,
  };
}

export function newActionDraft(pkg: OntologyPackage): OntologyActionType {
  return {
    id: crypto.randomUUID(),
    key: ontologyUniqueKey("action", pkg.actions),
    label: "",
    boundObject: pkg.objects[0]?.key ?? "",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    toolBinding: { kind: "capability", id: "", version: "" },
    preconditions: [],
    effect: "read",
    riskLevel: "low",
    approvalRequired: false,
    idempotencyRequired: false,
    impactScope: [],
    authorizedScopes: [],
    evidenceRequired: true,
    status: "draft",
    version: 1,
  };
}

/**
 * 从数据集字段生成对象属性候选（H-C4-P0"自动识别只生成候选,不直接发布"）：
 * - inferSemanticRole 命中 → 属性类型按角色推导,备注标注建议角色；
 * - 未命中/歧义 → 类型回落 string,进入"待确认"；
 * - 全部候选 confirmed=false,必须人工逐个确认才满足发布门禁 1。
 */
export function objectPropertiesFromDataset(dataset: DataDatasetRecord): Array<OntologyProperty & { suggestedRole?: DataSemanticRole }> {
  const build = (field: DataDatasetField): OntologyProperty & { suggestedRole?: DataSemanticRole } => {
    const role = inferSemanticRole(field);
    return {
      key: field.key,
      label: field.label?.trim() || field.key,
      type: role ? ROLE_TYPE_MAP[role] : field.type === "number" ? "number" : field.type === "boolean" ? "boolean" : field.type === "datetime" ? "datetime" : "string",
      confirmed: false,
      ...(role ? { description: `自动识别建议角色:${role}`, suggestedRole: role } : {}),
    };
  };
  return [...new Map([...dataset.fields, ...(dataset.computedFields ?? [])].map((field) => [field.key, build(field)])).values()];
}

/** 生成数据集来源绑定（含服务端同口径 Schema 指纹与字段映射）。 */
export function datasetSourceBinding(properties: readonly { key: string }[], dataset: DataDatasetRecord): OntologyObjectType["sourceBindings"][number] {
  return {
    kind: "dataset",
    sourceId: dataset.id,
    fieldMappings: properties.map((property) => ({ propertyKey: property.key, fieldKey: property.key })),
    schemaFingerprint: datasetSchemaFingerprint(dataset),
  };
}

/** 状态 → 颜色语义 + 图标名 + 文字（三重编码,不依赖颜色单独表达）。 */
export function ontologyStatusPresentation(status: OntologyStatus): { label: string; tone: "draft" | "review" | "published" | "retired"; icon: string } {
  switch (status) {
    case "published": return { label: "已发布", tone: "published", icon: "CheckCircle2" };
    case "review": return { label: "待评审", tone: "review", icon: "Eye" };
    case "retired": return { label: "已退役", tone: "retired", icon: "Archive" };
    default: return { label: "草稿", tone: "draft", icon: "PencilLine" };
  }
}

export function summarizeGate(report: OntologyPublishGateReport): { passed: number; total: number; failedGates: Array<{ gateId: number; label: string; errors: string[] }> } {
  const failedGates = report.gates.filter((gate) => !gate.passed).map(({ gateId, label, errors }) => ({ gateId, label, errors }));
  return { passed: report.gates.length - failedGates.length, total: report.gates.length, failedGates };
}

/** 拆分服务端"；(分隔）错误串,与 semanticSaveErrors 同一口径。 */
export function ontologySaveErrors(error: unknown): string[] {
  return (error instanceof Error ? error.message : String(error)).split("；").filter(Boolean);
}

/** 未保存包（无 id 或空名）不可发布；published/retired 包只读。 */
export function packageEditMode(status: OntologyStatus): "editable" | "readonly" {
  return status === "draft" || status === "review" ? "editable" : "readonly";
}
