import { fingerprint64Labeled } from "./fingerprint.js";
import type { OntologyActionEffect, OntologyActionRisk, OntologyCondition } from "./ontology.js";

/**
 * H-C4-P3「Harness 行动路径」契约（2026-09-29 主线程晋升 packages/contracts；api 消费方经 @bim-studio/contracts 引用）。
 *
 * 链路（ai-ontology-integration-plan-2026-09-29 §4.5 / 剩余任务清单 H-C4-P3）：
 *   计划(假设跳) → 预览 → 审批(按需) → 执行(只走既有工具网关) → 回执(ProvenanceLedger 第三跳)。
 *
 * 与既有三跳账本的关系：复用 ProvenanceLedgerStore 的同一文档、同一串行化提交与
 * fail-closed 形状过滤纪律，新增"行动链"节点族（plan → execution → receipt），
 * 与仿真假设链（hypothesis → kernel-run → verdict）互不混写——行动回执不是仿真判定，
 * 不得伪造 tolerance/verdict 语义。
 *
 * 拒绝矩阵（fail-closed，不得放行猜测）：
 * - ontology-action-unbound          行动无本体绑定（行动不存在/绑定对象不存在/包未发布面）
 * - ontology-package-not-published   所属本体包未发布
 * - ontology-precondition-unknown    前置条件无法评估（未知即拒绝，不猜）
 * - ontology-precondition-failed     前置条件评估失败
 * - ontology-scope-exceeded          权限超范围（角色下限/授权范围不含请求 scope）
 */

/** 行动效果：与 contracts.OntologyActionType.effect 同一口径（单一来源，不另立枚举）。 */
export type OntologyActionPathEffect = OntologyActionEffect;

/** 显式拒绝理由码：任何拒绝必须携带其一，客户端不得从 message 反推。 */
export const ONTOLOGY_ACTION_REJECTION_CODES = {
  unbound: "ontology-action-unbound",
  packageNotPublished: "ontology-package-not-published",
  targetInvalid: "ontology-target-invalid",
  toolNotAllowed: "ontology-tool-not-allowed",
  scopeExceeded: "ontology-scope-exceeded",
  preconditionUnknown: "ontology-precondition-unknown",
  preconditionFailed: "ontology-precondition-failed",
  approvalRequired: "ontology-approval-required",
  invalidArguments: "ontology-invalid-arguments",
  runtimeUnavailable: "ontology-runtime-unavailable",
} as const;

export type OntologyActionRejectionCode =
  (typeof ONTOLOGY_ACTION_REJECTION_CODES)[keyof typeof ONTOLOGY_ACTION_REJECTION_CODES];

export class OntologyActionRejectionError extends Error {
  constructor(readonly code: OntologyActionRejectionCode, message: string) {
    super(message);
    this.name = "OntologyActionRejectionError";
  }
}

/** 行动执行的服务不可用（账本未绑定等装配缺口）：同样 fail-closed 拒绝，不降级放行。 */
export class OntologyActionRuntimeError extends Error {
  constructor(readonly code: "ontology-runtime-unavailable", message: string) {
    super(message);
    this.name = "OntologyActionRuntimeError";
  }
}

/** 计划输入：目标必须是 canonicalObjectId（对象身份），不允许用自由文本指代对象。 */
export interface OntologyActionPlanInput {
  /** 缺省时在已发布包中按 actionKey 唯一检索；命中多包即拒绝（不猜）。 */
  packageId?: string;
  actionKey: string;
  target: { objectKey: string; canonicalId: string };
  arguments: Record<string, unknown>;
  /** 请求的授权范围声明；必须落在行动 authorizedScopes 内。 */
  scope?: string;
  /** 幂等键；缺省由 包+行动+目标+参数 派生稳定指纹。 */
  idempotencyKey?: string;
}

/** 对象路径一步：根步携带 canonicalObjectId；邻域步是类型级（1–2 跳关系邻域）。 */
export interface OntologyActionPathStep {
  objectKey: string;
  /** 仅根步（行动直接目标）携带实例身份。 */
  canonicalId?: string;
  /** 到达该步所经的关系 key；根步缺省。 */
  relationKey?: string;
  hops: 0 | 1 | 2;
}

export interface OntologyActionPreconditionResult {
  label: string;
  expression?: string;
  status: "passed" | "failed" | "unknown";
}

/** 影响范围：类型级 1–2 跳关系邻域（实例级展开属图谱职责，本层不复制）。 */
export interface OntologyActionImpactRef {
  objectKey: string;
  relationKey: string;
  hops: 1 | 2;
}

export interface OntologyActionPreview {
  packageId: string;
  packageVersion: number;
  ontologyStatus: "published";
  actionKey: string;
  actionLabel: string;
  actionVersion: number;
  boundObject: string;
  target: { objectKey: string; canonicalId: string };
  /** 对象路径：根（canonicalObjectId）+ 1–2 跳关系邻域。 */
  objectPath: OntologyActionPathStep[];
  /** 影响范围（1–2 跳关系邻域）。 */
  impact: OntologyActionImpactRef[];
  preconditions: OntologyActionPreconditionResult[];
  risk: OntologyActionRisk;
  effect: OntologyActionPathEffect;
  approvalRequired: boolean;
  idempotencyKey: string;
  rollback?: string;
  toolBinding: { kind: string; id: string; version: string };
  /** 计划指纹：行动链第一跳（假设跳）的链键。 */
  planFingerprint: string;
  /** 审批范围指纹：与工具网关对调用的 scope 指纹一致，审批必须逐字回传。 */
  approvalScopeFingerprint: string;
  /** false = 存在 blockingReasons，执行将被拒绝。 */
  executable: boolean;
  blockingReasons: Array<{ code: OntologyActionRejectionCode; message: string }>;
}

/** 行动回执（API 面）：账本 receipt 节点的对外投影。 */
export interface OntologyActionReceipt {
  planFingerprint: string;
  inputFingerprint: string;
  /** 64 位工具范围指纹（既有审批机制口径）；与执行节点一致。 */
  toolScopeFingerprint?: string;
  receiptFingerprint: string;
  idempotencyKey: string;
  status: "executed" | "failed" | "blocked";
  reasonCode?: string;
  digest: string;
  evidenceFingerprints: string[];
  receiptedAt: string;
  /** 同幂等键重放时 true：未重复执行，返回既有回执。 */
  replayed?: boolean;
}

export type OntologyExecuteOutcome =
  | { status: "executed" | "failed" | "blocked"; receipt: OntologyActionReceipt }
  | { status: "awaiting-approval"; preview: OntologyActionPreview }
  | { status: "rejected"; code: OntologyActionRejectionCode; message: string };

/** 前置条件评估器：第一阶段由宿主注入（Harness 落地点）；缺省恒 unknown（fail-closed）。 */
export type OntologyPreconditionEvaluator = (
  condition: OntologyCondition,
  context: { projectId: string; actionKey: string; canonicalId: string },
) => "passed" | "failed" | "unknown";

const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
export const ONTOLOGY_ACTION_DIGEST_MAX_CHARS = 300;

export function requireActionFingerprint(value: string, field: string): string {
  if (!FINGERPRINT_PATTERN.test(value)) throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments, `${field} 必须是 16 位小写十六进制指纹`);
  return value;
}

/** 摘要截断：超长显式标记，不静默丢字（对齐 provenance.provenanceDigest 纪律）。 */
export function actionDigest(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ONTOLOGY_ACTION_DIGEST_MAX_CHARS
    ? `${trimmed.slice(0, ONTOLOGY_ACTION_DIGEST_MAX_CHARS)}…[已截断]`
    : trimmed;
}

/** 计划指纹：包版本+行动版本+目标身份+参数（canonical 序列化）确定；微扰参数即新计划。 */
export function planActionFingerprint(input: {
  packageId: string;
  packageVersion: number;
  actionKey: string;
  actionVersion: number;
  boundObject: string;
  canonicalId: string;
  arguments: Record<string, unknown>;
}): string {
  return fingerprint64Labeled([["ontology-action-plan", {
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    actionKey: input.actionKey,
    actionVersion: input.actionVersion,
    boundObject: input.boundObject,
    canonicalId: input.canonicalId,
    arguments: input.arguments,
  }]]);
}

/** 幂等键派生：同包同行动同目标同参数 → 同键（重复提交不重复执行）。 */
export function deriveActionIdempotencyKey(input: {
  packageId: string;
  actionKey: string;
  canonicalId: string;
  arguments: Record<string, unknown>;
}): string {
  return fingerprint64Labeled([["ontology-action-idempotency", {
    packageId: input.packageId,
    actionKey: input.actionKey,
    canonicalId: input.canonicalId,
    arguments: input.arguments,
  }]]);
}

// ---------------------------------------------------------------------------
// 行动三跳链节点（假设跳=计划 / 执行跳=工具执行 / 回执跳=行动回执）
// ---------------------------------------------------------------------------

export interface AiProvenanceActionPlanNode {
  kind: "action-plan";
  /** nodeId = planFingerprint（同指纹重提是同一计划，幂等 upsert）。 */
  nodeId: string;
  planFingerprint: string;
  packageId: string;
  packageVersion: number;
  actionKey: string;
  actionVersion: number;
  boundObject: string;
  /** 行动直接目标的 canonicalObjectId。 */
  canonicalId: string;
  riskLevel: OntologyActionRisk;
  effect: OntologyActionPathEffect;
  approvalRequired: boolean;
  idempotencyKey: string;
  /** 计划结构化摘要（≤300 字符），不存参数原文。 */
  digest: string;
  plannedAt: string;
}

export interface AiProvenanceActionExecutionNode {
  kind: "action-execution";
  /** nodeId = action-exec:<inputFingerprint>；同计划同参数重试幂等 upsert。 */
  nodeId: string;
  planFingerprint: string;
  /** 16 位链内指纹：由工具调用范围指纹派生（保持账本 16 位指纹不变量）。 */
  inputFingerprint: string;
  /** 64 位工具范围指纹（aiToolScopeFingerprint，SHA-256）：既有审批机制的审批对象，审计回溯用。 */
  toolScopeFingerprint?: string;
  toolId: string;
  executedAt: string;
}

export interface AiProvenanceActionReceiptNode {
  kind: "action-receipt";
  /** nodeId = action-receipt:<receiptFingerprint>。 */
  nodeId: string;
  planFingerprint: string;
  inputFingerprint: string;
  /** 64 位工具范围指纹（与执行节点一致），既有审批/审计口径的回执侧留痕。 */
  toolScopeFingerprint?: string;
  receiptFingerprint: string;
  idempotencyKey: string;
  status: "executed" | "failed" | "blocked";
  reasonCode?: string;
  digest: string;
  evidenceFingerprints: string[];
  receiptedAt: string;
  /** 全字段完整性指纹；读回重算比对，不一致即链断并如实暴露。 */
  integrityFingerprint: string;
}

export type AiProvenanceActionNode = AiProvenanceActionPlanNode | AiProvenanceActionExecutionNode | AiProvenanceActionReceiptNode;

export function buildOntologyActionPlanNode(input: Omit<AiProvenanceActionPlanNode, "kind" | "nodeId">): AiProvenanceActionPlanNode {
  requireActionFingerprint(input.planFingerprint, "planFingerprint");
  requireIso(input.plannedAt, "plannedAt");
  if (!input.idempotencyKey.trim()) throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments, "行动计划缺少幂等键");
  return {
    kind: "action-plan",
    nodeId: input.planFingerprint,
    planFingerprint: input.planFingerprint,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    actionKey: input.actionKey,
    actionVersion: input.actionVersion,
    boundObject: input.boundObject,
    canonicalId: input.canonicalId,
    riskLevel: input.riskLevel,
    effect: input.effect,
    approvalRequired: input.approvalRequired,
    idempotencyKey: input.idempotencyKey,
    digest: actionDigest(input.digest),
    plannedAt: input.plannedAt,
  };
}

export function buildOntologyActionExecutionNode(input: Omit<AiProvenanceActionExecutionNode, "kind" | "nodeId">): AiProvenanceActionExecutionNode {
  requireActionFingerprint(input.planFingerprint, "planFingerprint");
  requireActionFingerprint(input.inputFingerprint, "inputFingerprint");
  requireIso(input.executedAt, "executedAt");
  if (!input.toolId.trim()) throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments, "行动执行缺少工具标识");
  if (input.toolScopeFingerprint !== undefined && (!input.toolScopeFingerprint.trim() || input.toolScopeFingerprint.length > 128)) {
    throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments, "行动执行的工具范围指纹无效");
  }
  return {
    kind: "action-execution",
    nodeId: `action-exec:${input.inputFingerprint}`,
    planFingerprint: input.planFingerprint,
    inputFingerprint: input.inputFingerprint,
    ...(input.toolScopeFingerprint ? { toolScopeFingerprint: input.toolScopeFingerprint } : {}),
    toolId: input.toolId,
    executedAt: input.executedAt,
  };
}

/** 回执完整性指纹：除 integrityFingerprint 外全字段掺入（含状态与理由码）。 */
export function actionReceiptIntegrityFingerprint(node: Omit<AiProvenanceActionReceiptNode, "integrityFingerprint">): string {
  return fingerprint64Labeled([["ontology-action-receipt-integrity", node]]);
}

export function buildOntologyActionReceiptNode(input: Omit<AiProvenanceActionReceiptNode, "kind" | "nodeId" | "integrityFingerprint">): AiProvenanceActionReceiptNode {
  requireActionFingerprint(input.planFingerprint, "planFingerprint");
  requireActionFingerprint(input.inputFingerprint, "inputFingerprint");
  requireActionFingerprint(input.receiptFingerprint, "receiptFingerprint");
  requireIso(input.receiptedAt, "receiptedAt");
  if (!input.idempotencyKey.trim()) throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments, "行动回执缺少幂等键");
  const base: Omit<AiProvenanceActionReceiptNode, "integrityFingerprint"> = {
    kind: "action-receipt",
    nodeId: `action-receipt:${input.receiptFingerprint}`,
    planFingerprint: input.planFingerprint,
    inputFingerprint: input.inputFingerprint,
    ...(input.toolScopeFingerprint ? { toolScopeFingerprint: input.toolScopeFingerprint } : {}),
    receiptFingerprint: input.receiptFingerprint,
    idempotencyKey: input.idempotencyKey,
    status: input.status,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    digest: actionDigest(input.digest),
    evidenceFingerprints: [...input.evidenceFingerprints],
    receiptedAt: input.receiptedAt,
  };
  return { ...base, integrityFingerprint: actionReceiptIntegrityFingerprint(base) };
}

/** 回执指纹：计划+输入+状态+输出摘要确定；同输入确定性重跑同指纹（幂等 upsert）。 */
export function receiptFingerprintOf(input: {
  planFingerprint: string;
  inputFingerprint: string;
  status: AiProvenanceActionReceiptNode["status"];
  outputDigest: string;
}): string {
  return fingerprint64Labeled([["ontology-action-receipt", {
    planFingerprint: input.planFingerprint,
    inputFingerprint: input.inputFingerprint,
    status: input.status,
    outputDigest: input.outputDigest,
  }]]);
}

/**
 * 执行节点输入指纹：由 64 位工具范围指纹（aiToolScopeFingerprint，既有审批机制口径）
 * 派生 16 位链内指纹，保持账本指纹不变量；两枚指纹都落账，审批回溯不断链。
 */
export function actionInputFingerprint(toolScopeFingerprint: string): string {
  return fingerprint64Labeled([["ontology-action-input", toolScopeFingerprint]]);
}

// ---------------------------------------------------------------------------
// 行动链装配（纯函数，账本侧调用；断链如实暴露，不静默修复）
// ---------------------------------------------------------------------------

export interface AiProvenanceActionEdge {
  from: string;
  to: string;
  relation: "planned" | "executed" | "receipted";
}

export interface AiProvenanceActionChain {
  plan: AiProvenanceActionPlanNode;
  executions: AiProvenanceActionExecutionNode[];
  receipts: AiProvenanceActionReceiptNode[];
  edges: AiProvenanceActionEdge[];
  integrity: "intact" | "broken";
  breaks: Array<{ nodeId: string; code: "receipt-integrity-mismatch" | "receipt-missing-execution" | "execution-missing-plan"; detail: string }>;
}

export interface AiProvenanceActionQuery {
  planFingerprint?: string;
  receiptFingerprint?: string;
  idempotencyKey?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface OntologyActionRecords {
  plans: AiProvenanceActionPlanNode[];
  executions: AiProvenanceActionExecutionNode[];
  receipts: AiProvenanceActionReceiptNode[];
}

export interface AiProvenanceActionTrace {
  query: AiProvenanceActionQuery;
  /** false = 未命中：调用方必须如实呈现"无档案记录"，不得伪造链。 */
  matched: boolean;
  chains: AiProvenanceActionChain[];
  integrity: { intact: boolean; brokenNodes: string[] };
}

/** fail-closed 校验查询：指纹/时间窗/limit 边界；非法即抛，不让自由查询进账本。 */
export function validateOntologyActionQuery(value: unknown): AiProvenanceActionQuery {
  const source = asRecord(value, "query");
  const planFingerprint = optionalFingerprint(source.planFingerprint, "query.planFingerprint");
  const receiptFingerprint = optionalFingerprint(source.receiptFingerprint, "query.receiptFingerprint");
  const idempotencyKey = optionalText(source.idempotencyKey, "query.idempotencyKey");
  const since = optionalIso(source.since, "query.since");
  const until = optionalIso(source.until, "query.until");
  let limit: number | undefined;
  if (source.limit !== undefined) {
    if (typeof source.limit !== "number" || !Number.isInteger(source.limit) || source.limit < 1 || source.limit > 100) {
      throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments, "query.limit 必须是 1 至 100 的整数");
    }
    limit = source.limit;
  }
  if (since && until && since > until) throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments, "query.since 不得晚于 query.until");
  return {
    ...(planFingerprint ? { planFingerprint } : {}),
    ...(receiptFingerprint ? { receiptFingerprint } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

/**
 * 纯装配：把行动记录组装成 计划→执行→回执 链集合。
 * - 完整性核查覆盖全库回执（不只命中链）：重算完整性指纹，漂移即 brokenNodes；
 * - 断链（回执缺执行、执行缺计划）如实入 breaks；
 * - 只计划未执行是诚实状态：链如实呈现空执行段，不伪造运行。
 */
export function assembleOntologyActionChains(records: OntologyActionRecords, query: AiProvenanceActionQuery): AiProvenanceActionTrace {
  const brokenNodes: string[] = [];
  for (const receipt of records.receipts) {
    const { integrityFingerprint: _ignored, ...rest } = receipt;
    if (actionReceiptIntegrityFingerprint(rest) !== receipt.integrityFingerprint) brokenNodes.push(receipt.nodeId);
  }

  const plansByFingerprint = new Map(records.plans.map((node) => [node.planFingerprint, node]));
  const executionsByPlan = groupBy(records.executions, (node) => node.planFingerprint);
  const executionsByInput = new Map(records.executions.map((node) => [node.nodeId, node]));
  const receiptsByPlan = groupBy(records.receipts, (node) => node.planFingerprint);
  const receiptsByFingerprint = new Map(records.receipts.map((node) => [node.receiptFingerprint, node]));

  const candidatePlans = selectPlans(records, query, plansByFingerprint, receiptsByFingerprint);
  const chains: AiProvenanceActionChain[] = [];
  for (const plan of candidatePlans) {
    const executions = (executionsByPlan.get(plan.planFingerprint) ?? []).slice().sort((left, right) => left.executedAt.localeCompare(right.executedAt));
    const receipts = (receiptsByPlan.get(plan.planFingerprint) ?? []).slice().sort((left, right) => left.receiptedAt.localeCompare(right.receiptedAt));
    const edges: AiProvenanceActionEdge[] = [];
    const breaks: AiProvenanceActionChain["breaks"] = [];
    for (const execution of executions) {
      edges.push({ from: plan.nodeId, to: execution.nodeId, relation: "executed" });
    }
    for (const receipt of receipts) {
      const execution = executionsByInput.get(`action-exec:${receipt.inputFingerprint}`);
      if (!execution) {
        breaks.push({ nodeId: receipt.nodeId, code: "receipt-missing-execution", detail: "回执缺少对应执行节点" });
        continue;
      }
      edges.push({ from: execution.nodeId, to: receipt.nodeId, relation: "receipted" });
      if (brokenNodes.includes(receipt.nodeId)) {
        breaks.push({ nodeId: receipt.nodeId, code: "receipt-integrity-mismatch", detail: "回执完整性指纹与读回重算不一致：回执在落账后被改动，链路如实断开" });
      }
    }
    for (const execution of executions) {
      if (!plansByFingerprint.has(execution.planFingerprint)) {
        breaks.push({ nodeId: execution.nodeId, code: "execution-missing-plan", detail: "执行缺少对应计划节点" });
      }
    }
    chains.push({ plan, executions, receipts, edges, integrity: breaks.length ? "broken" : "intact", breaks });
  }

  // 孤儿回执（计划被逐出但回执还在）：独立暴露，不让断链静默消失。
  for (const receipt of records.receipts) {
    if (!plansByFingerprint.has(receipt.planFingerprint) && !brokenNodes.includes(receipt.nodeId)) {
      brokenNodes.push(receipt.nodeId);
    }
  }

  const inWindow = chains.filter((chain) => chainInWindow(chain, query)).sort(byLastActivity);
  const limit = Math.min(query.limit ?? 20, 100);
  return {
    query,
    matched: inWindow.length > 0,
    chains: inWindow.slice(0, limit),
    integrity: { intact: brokenNodes.length === 0, brokenNodes },
  };
}

function selectPlans(
  records: OntologyActionRecords,
  query: AiProvenanceActionQuery,
  plansByFingerprint: Map<string, AiProvenanceActionPlanNode>,
  receiptsByFingerprint: Map<string, AiProvenanceActionReceiptNode>,
): AiProvenanceActionPlanNode[] {
  if (query.planFingerprint) {
    const plan = plansByFingerprint.get(query.planFingerprint);
    return plan ? [plan] : [];
  }
  if (query.receiptFingerprint) {
    const receipt = receiptsByFingerprint.get(query.receiptFingerprint);
    const plan = receipt ? plansByFingerprint.get(receipt.planFingerprint) : undefined;
    return plan ? [plan] : [];
  }
  if (query.idempotencyKey) {
    const plans = records.plans.filter((plan) => plan.idempotencyKey === query.idempotencyKey);
    return plans;
  }
  return records.plans;
}

function chainInWindow(chain: AiProvenanceActionChain, query: AiProvenanceActionQuery): boolean {
  if (!query.since && !query.until) return true;
  const stamps = [
    chain.plan.plannedAt,
    ...chain.executions.map((node) => node.executedAt),
    ...chain.receipts.map((node) => node.receiptedAt),
  ];
  return stamps.some((stamp) => (!query.since || stamp >= query.since) && (!query.until || stamp <= query.until));
}

function byLastActivity(left: AiProvenanceActionChain, right: AiProvenanceActionChain): number {
  return lastActivityOf(right).localeCompare(lastActivityOf(left));
}

function lastActivityOf(chain: AiProvenanceActionChain): string {
  return [
    chain.plan.plannedAt,
    ...chain.executions.map((node) => node.executedAt),
    ...chain.receipts.map((node) => node.receiptedAt),
  ].sort().at(-1) ?? chain.plan.plannedAt;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function requireIso(value: string, field: string): string {
  if (typeof value !== "string" || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments, `${field} 必须是 UTC ISO 8601 时间字符串`);
  }
  return value;
}

function optionalFingerprint(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments, `${field} 必须是 16 位小写十六进制指纹`);
  }
  return value;
}

function optionalIso(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireIso(value as string, field);
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments, `${field} 必须是字符串`);
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments, `${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}
