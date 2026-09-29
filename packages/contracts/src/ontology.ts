import type { DataDatasetField } from "./data.js";
import type { SemanticMetricDefinition } from "./semantic.js";
import { fingerprint64Labeled } from "./fingerprint.js";

/**
 * H-C4-P0 本体契约：对象 / 关系 / 行动 / 语义四类资产统一进一个版本化的 OntologyPackage。
 *
 * 设计边界（ai-ontology-integration-plan-2026-09-29 §2/§6/§7）：
 * - 本体只声明业务语义、对象绑定与风险契约，不替代能力目录、数据集或 Harness。
 * - 自动识别（字段角色推断等）只产生候选（confirmed=false 的属性、无证据的边），
 *   候选不满足发布门禁，不会被发布（fail-closed）。
 * - 发布门禁九条逐条可测，任何一条失败即拒绝发布；能力目录或数据源指纹无法验证时
 *   同样拒绝（不静默通过）。
 * - 状态机：draft → review → published → retired；review 可驳回回 draft；
 *   published 可开新草稿版本（由存储层 clone），retired 是终态。
 */

export type OntologyStatus = "draft" | "review" | "published" | "retired";

export const ONTOLOGY_STATUSES: readonly OntologyStatus[] = ["draft", "review", "published", "retired"];

/** 状态机邻接表；retired 无出边（终态），published→draft 表示"基于已发布版本开新草稿"。 */
export const ONTOLOGY_STATUS_TRANSITIONS: Readonly<Record<OntologyStatus, readonly OntologyStatus[]>> = {
  draft: ["review"],
  review: ["draft", "published"],
  published: ["draft", "retired"],
  retired: [],
};

export function canTransitionOntologyStatus(from: OntologyStatus, to: OntologyStatus): boolean {
  return ONTOLOGY_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function ontologyStatusLabel(status: OntologyStatus): string {
  return { draft: "草稿", review: "待评审", published: "已发布", retired: "已退役" }[status];
}

/** 属性类型；json 仅作透传容器，不做结构校验（第一阶段不做 OWL/深度 Schema 推理）。 */
export type OntologyPropertyType = "string" | "number" | "boolean" | "datetime" | "enum" | "json";

export const ONTOLOGY_PROPERTY_TYPES: readonly OntologyPropertyType[] = [
  "string", "number", "boolean", "datetime", "enum", "json",
];

export interface OntologyProperty {
  key: string;
  label: string;
  type: OntologyPropertyType;
  description?: string;
  unit?: string;
  /** type=enum 时的合法取值。 */
  enumValues?: string[];
  /** 业务必填属性；参与发布校验但不参与数据写入。 */
  required?: boolean;
  /**
   * false = 自动识别生成的候选，尚未人工确认。
   * 发布门禁 1 要求主键属性与全部属性 confirmed，未确认候选阻止发布。
   */
  confirmed: boolean;
}

export type OntologySourceKind = "dataset" | "pipeline" | "scene-tree" | "api" | "manual";

export interface OntologySourceBinding {
  kind: OntologySourceKind;
  /** dataset/pipeline 取数据集或管道 id；scene-tree 取场景 id；api/manual 取说明性标识。 */
  sourceId: string;
  /** 属性 ← 来源字段的映射；发布门禁 1 校验映射到的属性存在。 */
  fieldMappings: Array<{ propertyKey: string; fieldKey: string }>;
  /**
   * 来源 Schema 指纹（数据集字段签名）；发布门禁 8 与服务端当前指纹比对。
   * 缺失或比对失败且未显式复核 → 拒绝发布（fail-closed）。
   */
  schemaFingerprint?: string;
  /** 人工确认"我已核对过漂移"；仅在指纹一致时无需填写。 */
  driftReviewed?: boolean;
  note?: string;
}

/** 对象身份映射：不同来源中的外部编码统一到 canonicalId。 */
export interface OntologyIdentityMapping {
  objectKey: string;
  canonicalId: string;
  sources: Array<{ sourceKind: OntologySourceKind; sourceId: string; externalId: string }>;
}

export interface OntologyObjectType {
  id: string;
  /** 包内唯一标识（引用目标），发布后不可改（关系/行动按 key 引用）。 */
  key: string;
  label: string;
  domain: string;
  description?: string;
  /** 主键属性 key 列表；必须全部指向 confirmed 属性。 */
  primaryKeys: string[];
  /** 展示字段 key；缺省回落第一个主键。 */
  displayKey?: string;
  properties: OntologyProperty[];
  sourceBindings: OntologySourceBinding[];
  aliases: string[];
  identityMappings: OntologyIdentityMapping[];
  status: OntologyStatus;
  version: number;
  owner: string;
}

export interface OntologyRelationKeyMapping {
  sourceField: string;
  targetField: string;
}

export interface OntologyRelationType {
  id: string;
  key: string;
  label: string;
  /** 两端为对象 key；发布门禁 2 校验存在。 */
  sourceObject: string;
  targetObject: string;
  cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  direction: "directed" | "undirected";
  properties: OntologyProperty[];
  /** 键映射：sourceField 属于 sourceObject 属性，targetField 属于 targetObject 属性。 */
  keyMapping: OntologyRelationKeyMapping;
  /** 关系来源与理由：没有证据的边不允许保存进已发布包。 */
  source: { kind: OntologySourceKind; sourceId?: string; note: string };
  validTime?: { from?: string; to?: string };
  evidence: Array<{ source: string; sampleCount?: number; recordedAt: string }>;
  status: OntologyStatus;
  version: number;
}

export type OntologyActionEffect = "read" | "analyze" | "internal-write" | "external-write" | "control";

export type OntologyActionRisk = "low" | "medium" | "high" | "critical";

/** 前置条件第一阶段是声明式描述（label + 表达式文本），执行侧由 Harness 落地。 */
export interface OntologyCondition {
  label: string;
  expression?: string;
}

export interface OntologyToolBinding {
  kind: "capability" | "mcp" | "api" | "workflow";
  id: string;
  /** 发布门禁 3：版本必须明确；与能力目录比对（fail-closed）。 */
  version: string;
}

export interface OntologyActionType {
  id: string;
  key: string;
  label: string;
  /** 绑定对象 key；发布门禁 2 同源校验存在。 */
  boundObject: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  toolBinding: OntologyToolBinding;
  preconditions: OntologyCondition[];
  effect: OntologyActionEffect;
  riskLevel: OntologyActionRisk;
  approvalRequired: boolean;
  idempotencyRequired: boolean;
  /** 影响范围：对象 key 或范围标识；发布门禁 6 要求非空（权限范围可计算）。 */
  impactScope: string[];
  /** 授权范围声明；发布门禁 6 要求非空。 */
  authorizedScopes: string[];
  rollback?: string;
  evidenceRequired: boolean;
  status: OntologyStatus;
  version: number;
}

/** 事件：对象上的状态变化声明；P0 只做登记与绑定校验，不做事件引擎。 */
export interface OntologyEventType {
  id: string;
  key: string;
  label: string;
  boundObject: string;
  description?: string;
  status: OntologyStatus;
  version: number;
}

/** 证据要求：来源 + 指纹 + 时间；发布包级证据在 evidence 中逐条登记。 */
export interface RequirementEvidence {
  source: string;
  /** 内容指纹（fingerprint64 等十六进制）；空指纹视为无证据。 */
  fingerprint: string;
  recordedAt: string;
  note?: string;
}

export interface OntologyPolicyRef {
  id: string;
  description?: string;
  /** 策略作用对象：对象 key、行动 key 或通配范围。 */
  scope: string[];
}

/** 黄金问题：发布前必须全部回放通过（门禁 7）。 */
export interface OntologyGoldenQuestion {
  id: string;
  question: string;
  expectedBehavior?: string;
  passed: boolean;
  passedAt?: string;
  note?: string;
}

/** 本体包：对象 / 关系 / 行动 / 事件 / 指标 / 身份 / 证据 / 策略的版本化聚合。 */
export interface OntologyPackage {
  schemaVersion: 1;
  id: string;
  name: string;
  domain: string;
  description?: string;
  /** 已发布版本号；0 = 从未发布；发布成功 +1；草稿修改不动它。 */
  version: number;
  /** 草稿修订号；每次保存 +1，由服务端控制（对齐 SemanticModelRecord.revision）。 */
  revision: number;
  objects: OntologyObjectType[];
  relations: OntologyRelationType[];
  actions: OntologyActionType[];
  events: OntologyEventType[];
  /** 复用既有语义指标契约；本体指标与语义模型指标同一口径。 */
  metrics: SemanticMetricDefinition[];
  identityMappings: OntologyIdentityMapping[];
  goldenQuestions: OntologyGoldenQuestion[];
  policies: OntologyPolicyRef[];
  evidence: RequirementEvidence[];
  /** 门禁 9：影响分析已完成且无未评审高风险依赖。 */
  impactReviewed: boolean;
  impactReviewedBy?: string;
  status: OntologyStatus;
  owner: string;
  createdAt: string;
  updatedAt: string;
}

/** 发布快照：可回滚的最小单位；fingerprint 用于审计与版本列表。 */
export interface OntologyPackageSnapshot {
  snapshotId: string;
  packageId: string;
  version: number;
  fingerprint: string;
  publishedAt: string;
  publishedBy: string;
  package: OntologyPackage;
}

/** 回滚 / 状态流转历史条目（版本列表一并返回，可审计）。 */
export interface OntologyHistoryEntry {
  at: string;
  by: string;
  action: "create" | "publish" | "rollback" | "retire" | "review-submit" | "review-reject" | "new-draft-version";
  detail?: string;
  fromVersion?: number;
  toVersion?: number;
}

/** 服务端发布上下文：能力目录与数据源当前指纹；缺失即 fail-closed 拒绝对应门禁。 */
export interface OntologyPublishContext {
  /** 能力目录快照；缺省 = 门禁 3 直接失败（不静默放行）。 */
  capabilities?: Array<{ id: string; version: string; kind: string }>;
  /** 来源 sourceId → 当前 Schema 指纹；缺某来源 = 门禁 8 对该来源失败。 */
  datasetSchemas?: Record<string, string>;
}

export interface OntologyPublishGateResult {
  /** 门禁编号 1..9，与方案 §7 发布门禁一一对应。 */
  gateId: number;
  label: string;
  passed: boolean;
  errors: string[];
}

export interface OntologyPublishGateReport {
  ok: boolean;
  gates: OntologyPublishGateResult[];
  /** 汇总错误，便于 UI 与路由直接展示。 */
  errors: string[];
}

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * 数据源 Schema 指纹：字段签名（key+type+label，含计算字段）按 key 排序后取组合指纹。
 * 客户端（本体工作区）与服务端（发布门禁 8）共用同一口径；字段增删改即漂移。
 */
export function datasetSchemaFingerprint(dataset: Pick<{ fields: DataDatasetField[]; computedFields?: Array<{ key: string; label?: string; type: string }> }, "fields" | "computedFields">): string {
  const fields = [
    ...dataset.fields.map((field) => ({ key: field.key, type: field.type, label: field.label ?? "" })),
    ...(dataset.computedFields ?? []).map((field) => ({ key: field.key, type: field.type, label: field.label ?? "" })),
  ].sort((a, b) => a.key.localeCompare(b.key));
  return fingerprint64Labeled([
    ["kind", "dataset-schema"],
    ["fields", fields],
  ]);
}

export function isValidOntologyIdentifier(key: string): boolean {
  return IDENTIFIER_PATTERN.test(key);
}

/** 稳定指纹输入：只取影响语义的字段，序列化顺序确定；剔除状态/版本等易变位。 */
export function ontologyPackageFingerprint(pkg: OntologyPackage): string {
  const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
  const stripVolatile = <T extends { status: OntologyStatus; version: number }>(item: T): Omit<T, "status" | "version"> => {
    const clone = structuredClone(item);
    delete (clone as { status?: OntologyStatus }).status;
    delete (clone as { version?: number }).version;
    return clone;
  };
  const payload = JSON.stringify({
    id: pkg.id,
    objects: [...pkg.objects].sort(byKey).map(stripVolatile),
    relations: [...pkg.relations].sort(byKey).map(stripVolatile),
    actions: [...pkg.actions].sort(byKey).map(stripVolatile),
    events: [...pkg.events].sort(byKey).map(stripVolatile),
    metrics: [...pkg.metrics].sort(byKey),
    identityMappings: pkg.identityMappings,
    goldenQuestions: pkg.goldenQuestions,
    policies: pkg.policies,
    evidence: pkg.evidence,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, "0")}${payload.length.toString(16)}`;
}

/**
 * 形状校验：任何状态下保存都应通过的基础完整性（identifier 唯一、引用存在、
 * 身份映射合法、revision 合法）。发布九条门禁在此之上执行。
 * 返回错误列表，空数组表示通过。
 */
export function validateOntologyPackageShape(pkg: OntologyPackage): string[] {
  const errors: string[] = [];
  const push = (message: string) => errors.push(message);

  if (!pkg.name?.trim()) push("本体包名称不能为空");
  if (!pkg.domain?.trim()) push("本体包必须声明业务域");
  if (!pkg.owner?.trim()) push("本体包必须声明 Owner");
  if (!Number.isInteger(pkg.revision) || pkg.revision < 0) push("revision 必须是非负整数");
  if (!Number.isInteger(pkg.version) || pkg.version < 0) push("version 必须是非负整数");
  if (!ONTOLOGY_STATUSES.includes(pkg.status)) push(`状态 ${String(pkg.status)} 无效`);

  const objectKeys = new Set<string>();
  const assertAssetKeys = (items: Array<{ key: string; id?: string }>, kind: string) => {    const seen = new Set<string>();
    const seenIds = new Set<string>();
    for (const item of items) {
      if (!item.key || !IDENTIFIER_PATTERN.test(item.key)) {
        push(`${kind}标识 ${item.key || "(空)"} 必须以字母开头，只能包含字母、数字和下划线`);
      } else if (seen.has(item.key)) {
        push(`${kind}标识 ${item.key} 在包内重复`);
      }
      if (item.key) seen.add(item.key);
      if (item.id !== undefined) {
        if (!item.id.trim()) push(`${kind} ${item.key || "(未命名)"} 缺少 id`);
        else if (seenIds.has(item.id)) push(`${kind} id ${item.id} 在包内重复`);
        else seenIds.add(item.id);
      }
    }
  };
  assertAssetKeys(pkg.objects, "对象");
  for (const object of pkg.objects) if (object.key) objectKeys.add(object.key);

  for (const object of pkg.objects) {
    const propertyKeys = new Set<string>();
    for (const property of object.properties) {
      if (!property.key || !IDENTIFIER_PATTERN.test(property.key)) {
        push(`对象 ${object.key} 属性标识 ${property.key || "(空)"} 非法`);
      } else if (propertyKeys.has(property.key)) {
        push(`对象 ${object.key} 属性 ${property.key} 重复`);
      }
      if (property.key) propertyKeys.add(property.key);
      if (!ONTOLOGY_PROPERTY_TYPES.includes(property.type)) {
        push(`对象 ${object.key} 属性 ${property.key} 类型 ${String(property.type)} 无效`);
      }
      if (!property.label?.trim()) push(`对象 ${object.key} 属性 ${property.key} 缺少名称`);
      if (property.type === "enum" && !(property.enumValues?.length)) {
        push(`对象 ${object.key} 枚举属性 ${property.key} 必须声明枚举值`);
      }
    }
    for (const primaryKey of object.primaryKeys) {
      if (!propertyKeys.has(primaryKey)) push(`对象 ${object.key} 主键 ${primaryKey} 不是已声明属性`);
    }
    if (object.displayKey && !propertyKeys.has(object.displayKey)) {
      push(`对象 ${object.key} 展示字段 ${object.displayKey} 不是已声明属性`);
    }
  }

  for (const relation of pkg.relations) {
    for (const [side, objectKey] of [["sourceObject", relation.sourceObject], ["targetObject", relation.targetObject]] as const) {
      if (!objectKeys.has(objectKey)) push(`关系 ${relation.key} 的${side === "sourceObject" ? "来源对象" : "目标对象"} ${objectKey || "(空)"} 不存在`);
    }
    const sourceObject = pkg.objects.find((object) => object.key === relation.sourceObject);
    const targetObject = pkg.objects.find((object) => object.key === relation.targetObject);
    if (sourceObject && relation.keyMapping?.sourceField && !sourceObject.properties.some((property) => property.key === relation.keyMapping.sourceField)) {
      push(`关系 ${relation.key} 键映射源字段 ${relation.keyMapping.sourceField} 不在对象 ${sourceObject.key} 属性中`);
    }
    if (targetObject && relation.keyMapping?.targetField && !targetObject.properties.some((property) => property.key === relation.keyMapping.targetField)) {
      push(`关系 ${relation.key} 键映射目标字段 ${relation.keyMapping.targetField} 不在对象 ${targetObject.key} 属性中`);
    }
    if (!relation.source?.note?.trim()) push(`关系 ${relation.key} 必须说明建立理由（来源备注）`);
  }

  for (const action of pkg.actions) {
    if (!objectKeys.has(action.boundObject)) push(`行动 ${action.key} 绑定的对象 ${action.boundObject || "(空)"} 不存在`);
  }
  for (const event of pkg.events) {
    if (!objectKeys.has(event.boundObject)) push(`事件 ${event.key} 绑定的对象 ${event.boundObject || "(空)"} 不存在`);
  }

  const canonicalIds = new Set<string>();
  const externalSeen = new Set<string>();
  for (const mapping of [...pkg.identityMappings, ...pkg.objects.flatMap((object) => object.identityMappings.map((item) => ({ ...item, objectKey: object.key })))]) {
    if (!objectKeys.has(mapping.objectKey)) push(`身份映射 ${mapping.canonicalId} 指向的对象 ${mapping.objectKey} 不存在`);
    if (!mapping.canonicalId?.trim()) push("身份映射缺少 canonicalId");
    else if (canonicalIds.has(mapping.canonicalId)) push(`身份映射 canonicalId ${mapping.canonicalId} 重复`);
    if (mapping.canonicalId) canonicalIds.add(mapping.canonicalId);
    if (!mapping.sources?.length) push(`身份映射 ${mapping.canonicalId} 至少需要一个外部来源`);
    for (const source of mapping.sources ?? []) {
      const externalKey = `${source.sourceKind}:${source.sourceId}:${source.externalId}`;
      if (externalSeen.has(externalKey)) push(`外部身份 ${externalKey} 被映射到多个 canonicalId`);
      externalSeen.add(externalKey);
    }
  }

  const metricKeys = new Set<string>();
  for (const metric of pkg.metrics) {
    if (!metric.key || !IDENTIFIER_PATTERN.test(metric.key)) push(`指标标识 ${metric.key || "(空)"} 非法`);
    else if (metricKeys.has(metric.key)) push(`指标标识 ${metric.key} 在包内重复`);
    if (metric.key) metricKeys.add(metric.key);
  }
  for (const question of pkg.goldenQuestions) {
    if (!question.question?.trim()) push(`黄金问题 ${question.id || "(未命名)"} 内容为空`);
  }
  for (const item of pkg.evidence) {
    if (!item.source?.trim() || !item.fingerprint?.trim()) push("包级证据必须包含来源与指纹");
    if (item.recordedAt && Number.isNaN(Date.parse(item.recordedAt))) push(`证据 ${item.source} 的记录时间无效`);
  }
  return errors;
}

/** 门禁标签：编号与方案 §7 发布门禁逐条对应（第 10 条"生成可回滚快照"由发布动作本身保证）。 */
export const ONTOLOGY_PUBLISH_GATE_LABELS: Readonly<Record<number, string>> = {
  1: "对象主键、属性类型和来源完整",
  2: "关系两端对象存在，键映射可验证",
  3: "行动绑定的能力已存在且版本明确",
  4: "行动输入输出符合 Schema",
  5: "高风险行动有审批、幂等和回滚说明",
  6: "权限范围可计算",
  7: "相关黄金问题回放通过",
  8: "数据源 Schema 未发生未处理漂移",
  9: "影响分析无未评审高风险依赖",
};

const WRITE_EFFECTS: readonly OntologyActionEffect[] = ["external-write", "control"];

function gate(gateId: number, errors: string[]): OntologyPublishGateResult {
  return { gateId, label: ONTOLOGY_PUBLISH_GATE_LABELS[gateId] ?? `门禁 ${gateId}`, passed: errors.length === 0, errors };
}

/**
 * 发布门禁九条（fail-closed）：
 * 只对"将要发布的内容"校验（包内全部资产必须处于可发布状态——本函数假定调用方
 * 在发布前把包与资产状态统一置为 review/published 流转中，资产级 status 以包状态为准）。
 * ctx 缺失（能力目录、来源指纹）对应门禁直接失败，不静默通过。
 */
export function validateOntologyPublishGate(pkg: OntologyPackage, ctx: OntologyPublishContext): OntologyPublishGateReport {
  const gates: OntologyPublishGateResult[] = [];

  // 门禁 1：对象主键、属性类型和来源完整。
  const g1: string[] = [];
  for (const object of pkg.objects) {
    if (!object.label?.trim()) g1.push(`对象 ${object.key} 缺少名称`);
    if (!object.primaryKeys.length) g1.push(`对象 ${object.key} 未声明主键`);
    for (const primaryKey of object.primaryKeys) {
      const property = object.properties.find((item) => item.key === primaryKey);
      if (!property) g1.push(`对象 ${object.key} 主键 ${primaryKey} 不是已声明属性`);
      else if (!property.confirmed) g1.push(`对象 ${object.key} 主键属性 ${primaryKey} 尚未人工确认`);
    }
    for (const property of object.properties) {
      if (!property.confirmed) g1.push(`对象 ${object.key} 属性 ${property.key} 是待确认候选，发布前必须人工确认`);
      if (!ONTOLOGY_PROPERTY_TYPES.includes(property.type)) g1.push(`对象 ${object.key} 属性 ${property.key} 类型无效`);
    }
    if (!object.sourceBindings.length) g1.push(`对象 ${object.key} 没有任何来源绑定`);
    for (const binding of object.sourceBindings) {
      if (binding.kind === "manual") {
        if (!binding.note?.trim()) g1.push(`对象 ${object.key} 的人工来源必须说明理由`);
        continue;
      }
      if (!binding.sourceId?.trim()) g1.push(`对象 ${object.key} 来源绑定缺少来源标识`);
      for (const mapping of binding.fieldMappings) {
        if (!object.properties.some((property) => property.key === mapping.propertyKey)) {
          g1.push(`对象 ${object.key} 来源映射指向不存在的属性 ${mapping.propertyKey}`);
        }
      }
    }
  }
  gates.push(gate(1, g1));

  // 门禁 2：关系两端对象存在，键映射可验证，边必须有证据。
  const g2: string[] = [];
  const objectKeys = new Set(pkg.objects.map((object) => object.key));
  for (const relation of pkg.relations) {
    if (!objectKeys.has(relation.sourceObject)) g2.push(`关系 ${relation.key} 来源对象 ${relation.sourceObject} 不存在`);
    if (!objectKeys.has(relation.targetObject)) g2.push(`关系 ${relation.key} 目标对象 ${relation.targetObject} 不存在`);
    if (!relation.keyMapping?.sourceField || !relation.keyMapping?.targetField) {
      g2.push(`关系 ${relation.key} 缺少键映射`);
    } else {
      const sourceObject = pkg.objects.find((object) => object.key === relation.sourceObject);
      const targetObject = pkg.objects.find((object) => object.key === relation.targetObject);
      if (sourceObject && !sourceObject.properties.some((property) => property.key === relation.keyMapping.sourceField && property.confirmed)) {
        g2.push(`关系 ${relation.key} 键映射源字段 ${relation.keyMapping.sourceField} 未确认或不存在`);
      }
      if (targetObject && !targetObject.properties.some((property) => property.key === relation.keyMapping.targetField && property.confirmed)) {
        g2.push(`关系 ${relation.key} 键映射目标字段 ${relation.keyMapping.targetField} 未确认或不存在`);
      }
    }
    if (!relation.evidence.length) g2.push(`关系 ${relation.key} 没有任何证据（样例或来源），不允许发布`);
    for (const item of relation.evidence) {
      if (!item.source?.trim()) g2.push(`关系 ${relation.key} 存在无来源的证据条目`);
      if (!item.recordedAt || Number.isNaN(Date.parse(item.recordedAt))) g2.push(`关系 ${relation.key} 证据时间无效`);
    }
  }
  gates.push(gate(2, g2));

  // 门禁 3：行动绑定的能力已存在且版本明确。fail-closed：目录缺失即失败。
  // 只有 kind="capability" 的绑定在能力目录中核对；mcp/api/workflow 只要求标识与版本明确。
  const g3: string[] = [];
  if (!ctx.capabilities) g3.push("能力目录不可用，无法验证行动绑定（fail-closed）");
  else {
    for (const action of pkg.actions) {
      if (!action.toolBinding.id.trim()) g3.push(`行动 ${action.key} 绑定缺少能力标识`);
      if (!action.toolBinding.version.trim()) g3.push(`行动 ${action.key} 绑定能力缺少版本`);
      if (action.toolBinding.kind !== "capability") continue;
      const capability = ctx.capabilities.find((item) => item.id === action.toolBinding.id);
      if (!capability) g3.push(`行动 ${action.key} 绑定的能力 ${action.toolBinding.id || "(空)"} 不在能力目录中`);
      else if (capability.version !== action.toolBinding.version) {
        g3.push(`行动 ${action.key} 绑定能力 ${action.toolBinding.id} 版本 ${action.toolBinding.version} 与目录版本 ${capability.version} 不一致`);
      }
    }
  }
  gates.push(gate(3, g3));

  // 门禁 4：行动输入输出符合 Schema（第一阶段校验 JSON Schema 对象骨架）。
  const g4: string[] = [];
  const schemaErrors = (action: OntologyActionType, which: "inputSchema" | "outputSchema") => {
    const schema = action[which];
    const found: string[] = [];
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      found.push(`行动 ${action.key} ${which === "inputSchema" ? "输入" : "输出"}Schema 缺失`);
      return found;
    }
    if (schema.type !== "object") found.push(`行动 ${action.key} ${which === "inputSchema" ? "输入" : "输出"}Schema 根类型必须是 object`);
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
      found.push(`行动 ${action.key} ${which === "inputSchema" ? "输入" : "输出"}Schema 缺少 properties 声明`);
    }
    return found;
  };
  for (const action of pkg.actions) {
    g4.push(...schemaErrors(action, "inputSchema"));
    g4.push(...schemaErrors(action, "outputSchema"));
  }
  gates.push(gate(4, g4));

  // 门禁 5：高风险行动有审批、幂等和回滚说明。
  const g5: string[] = [];
  for (const action of pkg.actions) {
    if (action.riskLevel === "high" || action.riskLevel === "critical") {
      if (!action.approvalRequired) g5.push(`行动 ${action.key} 高风险但未要求审批`);
      if (!action.idempotencyRequired) g5.push(`行动 ${action.key} 高风险但未要求幂等键`);
      if (!action.rollback?.trim()) g5.push(`行动 ${action.key} 高风险但缺少回滚说明`);
    }
    if (WRITE_EFFECTS.includes(action.effect)) {
      if (action.riskLevel === "low") g5.push(`行动 ${action.key} 效果为 ${action.effect} 但风险级别为 low，请重新评估`);
      if (!action.approvalRequired) g5.push(`行动 ${action.key} 写入/控制效果必须要求审批`);
      if (!action.evidenceRequired) g5.push(`行动 ${action.key} 写入/控制效果必须要求证据回执`);
    }
  }
  gates.push(gate(5, g5));

  // 门禁 6：权限范围可计算。
  const g6: string[] = [];
  for (const action of pkg.actions) {
    if (!action.impactScope.length) g6.push(`行动 ${action.key} 影响范围为空，权限无法计算`);
    if (!action.authorizedScopes.length) g6.push(`行动 ${action.key} 授权范围为空，权限无法计算`);
  }
  for (const object of pkg.objects) {
    if (!object.owner?.trim()) g6.push(`对象 ${object.key} 缺少 Owner`);
  }
  if (!pkg.owner?.trim()) g6.push("本体包缺少 Owner");
  gates.push(gate(6, g6));

  // 门禁 7：黄金问题回放通过。
  const g7: string[] = [];
  if (!pkg.goldenQuestions.length) g7.push("未登记任何黄金问题，无法证明口径可回放");
  for (const question of pkg.goldenQuestions) {
    if (!question.passed) g7.push(`黄金问题「${question.question || question.id}」未回放通过`);
    else if (!question.passedAt) g7.push(`黄金问题「${question.question || question.id}」缺少回放时间`);
  }
  gates.push(gate(7, g7));

  // 门禁 8：数据源 Schema 未发生未处理漂移。fail-closed：指纹未知即失败。
  // manual 无 Schema 概念，跳过；scene-tree/api 可选带指纹，无指纹时必须人工复核。
  const g8: string[] = [];
  for (const object of pkg.objects) {
    for (const binding of object.sourceBindings) {
      if (binding.kind === "manual") continue;
      if (!binding.schemaFingerprint) {
        if (!binding.driftReviewed) g8.push(`对象 ${object.key} 来源 ${binding.sourceId} 无 Schema 指纹且未人工复核漂移`);
        continue;
      }
      const current = ctx.datasetSchemas?.[binding.sourceId];
      if (current === undefined) {
        // 有指纹但服务端取不到当前值：可能是来源已删除，同样无法证明未漂移。
        g8.push(`对象 ${object.key} 来源 ${binding.sourceId} 当前指纹不可得，无法验证漂移（fail-closed）`);
      } else if (current !== binding.schemaFingerprint && !binding.driftReviewed) {
        g8.push(`对象 ${object.key} 来源 ${binding.sourceId} Schema 已漂移且未人工复核`);
      }
    }
  }
  gates.push(gate(8, g8));

  // 门禁 9：影响分析无未评审高风险依赖。
  const g9: string[] = [];
  if (!pkg.impactReviewed) g9.push("影响分析未完成（impactReviewed=false）");
  if (pkg.impactReviewed && !pkg.impactReviewedBy?.trim()) g9.push("影响分析缺少复核人");
  const highRiskActions = pkg.actions.filter((action) => action.riskLevel === "high" || action.riskLevel === "critical");
  if (highRiskActions.length && !pkg.policies.length) {
    g9.push("包含高风险行动但未声明任何策略引用（policies 为空）");
  }
  gates.push(gate(9, g9));

  const errors = gates.flatMap((item) => item.errors);
  return { ok: errors.length === 0, gates, errors };
}

/** 创建空白草稿包（UI 与 API 共用同一初始形态）。 */
export function newOntologyPackage(domain: string, owner: string, now = new Date().toISOString()): OntologyPackage {
  return {
    schemaVersion: 1,
    id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `pkg-${Math.random().toString(36).slice(2)}`,
    name: "",
    domain,
    version: 0,
    revision: 0,
    objects: [],
    relations: [],
    actions: [],
    events: [],
    metrics: [],
    identityMappings: [],
    goldenQuestions: [],
    policies: [],
    evidence: [],
    impactReviewed: false,
    status: "draft",
    owner,
    createdAt: now,
    updatedAt: now,
  };
}
