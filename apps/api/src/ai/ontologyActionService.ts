import type {
  OntologyActionType,
  OntologyObjectType,
  OntologyPackage,
} from "@bim-studio/contracts";
import type {
  AgentApproval,
  AgentCheckpoint,
  AgentToolCall,
  AgentToolGateway,
  AgentToolOutcome,
} from "@bim-studio/industrial-agent-orchestrator";
import type { ProvenanceLedgerStore } from "./provenanceLedger.js";
import {
  ONTOLOGY_ACTION_REJECTION_CODES,
  OntologyActionRejectionError,
  OntologyActionRuntimeError,
  actionDigest,
  actionInputFingerprint,
  buildOntologyActionExecutionNode,
  buildOntologyActionPlanNode,
  buildOntologyActionReceiptNode,
  deriveActionIdempotencyKey,
  planActionFingerprint,
  receiptFingerprintOf,
  type OntologyActionImpactRef,
  type OntologyActionPathStep,
  type OntologyActionPlanInput,
  type OntologyActionPreview,
  type OntologyActionPreconditionResult,
  type OntologyActionReceipt,
  type OntologyExecuteOutcome,
  type OntologyPreconditionEvaluator,
  type OntologyActionRejectionCode,
} from "@bim-studio/contracts";
import {
  validateOntologyObjectValues,
  type OntologyConstraintCode,
  type OntologyConstraintRule,
  type OntologyConstraintViolation,
} from "./ontologyConstraintValidation.js";

/**
 * Semantica 刀3「本体约束校验」策略：行动执行写入账本前，对目标对象实例值
 * （行动参数中与对象属性同名的键）做轻量 SHACL 式校验。
 * - mode "report"（缺省）：只报告——violation 清单随 preview/execute 结果返回，不阻断；
 * - mode "strict"：阻断——存在违规即 rejected（invalidArguments），不落任何账本节点。
 * 规则表是数据（可裁剪传入），不是代码硬编码；判定确定性（类型/枚举/单位格式），
 * 不做语义推断。
 */
export interface OntologyConstraintPolicy {
  rules?: readonly OntologyConstraintRule[];
  mode?: "report" | "strict";
}

/** preview 出参扩展（contracts 类型零改动，apps/api 结构化超集）：约束校验违规清单。 */
export interface OntologyActionPreviewWithConstraints extends OntologyActionPreview {
  /** partial 口径校验结果；空数组 = 通过。默认 report-only，不参与 executable 判定。 */
  constraintViolations: OntologyConstraintViolation[];
  /** 本次实际执行的规则 id（审计「查了什么」与「为什么没查」）。 */
  constraintCheckedRules: OntologyConstraintCode[];
}

export type OntologyExecuteOutcomeWithConstraints = OntologyExecuteOutcome & {
  constraintViolations?: OntologyConstraintViolation[];
};

/**
 * H-C4-P3「Harness 行动路径」服务：把已发布本体行动接入既有 Harness 执行链。
 *
 * 分工（ai-ontology-integration-plan-2026-09-29 §5.3）：
 * - 本体只提供业务语义、对象绑定与风险契约；本服务不做第二套执行引擎。
 * - 执行只走既有 AgentToolGateway（生产注入 IndustrialAgentToolGateway：白名单 +
 *   计划档守卫 + executeReliableAiTool 审批/幂等/审计内核）；本服务绝不直接触达业务能力。
 * - 回执写入 ProvenanceLedgerStore，形成 计划(假设跳)→执行→回执 可查三跳链。
 *
 * 拒绝矩阵（fail-closed，不得放行猜测）：
 * 1. 无本体绑定（行动不存在/绑定对象缺失/包未发布）→ ontology-action-unbound /
 *    ontology-package-not-published；
 * 2. 前置条件未知（无评估器或评估不出结论）→ ontology-precondition-unknown，不猜不放行；
 * 3. 权限超范围（角色低于行动效果下限 / 请求 scope 不在 authorizedScopes）→
 *    ontology-scope-exceeded。
 */

export interface OntologyActionPackageReader {
  listPackages(projectId: string): Promise<OntologyPackage[]>;
}

export interface OntologyActionActor {
  principal: string;
  role?: string;
}

export interface OntologyActionExecuteContext extends OntologyActionActor {
  approval?: AgentApproval;
  signal?: AbortSignal;
}

export interface OntologyActionServiceInput {
  /** 每次调用取新读取器（生产传 () => new OntologyPackageStore(dataDir)，避免长缓存漂移）。 */
  ontologyReader: () => OntologyActionPackageReader;
  /** 账本端口：生产绑定共享 ProvenanceLedgerStore 实例；未绑定 = 执行/回执 fail-closed。 */
  ledger?: () => ProvenanceLedgerStore | undefined;
  /** 既有工具网关：白名单、指纹与执行全部复用（生产注入 IndustrialAgentToolGateway）。 */
  tools: Pick<AgentToolGateway, "list" | "fingerprint" | "execute">;
  /** 前置条件评估器；缺省恒 unknown（fail-closed）。 */
  preconditionEvaluator?: OntologyPreconditionEvaluator;
  /** Semantica 刀3：本体约束校验策略；缺省 report（只报告不阻断）、缺省规则表全开。 */
  constraints?: OntologyConstraintPolicy;
  now?: () => Date;
}

export interface OntologyActionSummary {
  packageId: string;
  packageVersion: number;
  actionKey: string;
  label: string;
  boundObject: string;
  riskLevel: OntologyActionType["riskLevel"];
  effect: OntologyActionType["effect"];
  approvalRequired: boolean;
  idempotencyRequired: boolean;
  rollback?: string;
  toolBinding: OntologyActionType["toolBinding"];
}

/** 邻域容量上限：影响范围是预览信息不是全图导出。 */
const IMPACT_CAP = 12;

export function createOntologyActionService(input: OntologyActionServiceInput) {
  const now = () => (input.now ?? (() => new Date()))().toISOString();

  /** 已发布包中的行动清单（数据中心/AI 助手"可预览行动"入口）。 */
  async function listPublishedActions(projectId: string): Promise<OntologyActionSummary[]> {
    const packages = await input.ontologyReader().listPackages(projectId);
    return packages
      .filter((pkg) => pkg.status === "published")
      .flatMap((pkg) => pkg.actions.map((action) => toSummary(pkg, action)))
      .sort((left, right) => left.packageId.localeCompare(right.packageId) || left.actionKey.localeCompare(right.actionKey));
  }

  /**
   * 行动预览：目标对象、对象路径、影响范围（1–2 跳关系邻域）、前置条件评估、
   * 风险等级、是否需审批、幂等键、回滚说明、计划与审批指纹。
   * 无法解析的行动直接抛显式理由码；可解析但被阻断的返回 blockingReasons。
   */
  async function preview(projectId: string, planInput: OntologyActionPlanInput, actor: OntologyActionActor): Promise<OntologyActionPreviewWithConstraints> {
    const { pkg, action, boundObject } = await resolvePublishedAction(projectId, planInput, input.ontologyReader());
    const canonicalId = requireCanonicalId(planInput.target?.canonicalId);
    if (planInput.target?.objectKey !== action.boundObject) {
      throw new OntologyActionRejectionError(
        ONTOLOGY_ACTION_REJECTION_CODES.unbound,
        `行动 ${action.key} 绑定对象是 ${action.boundObject}，计划目标 ${planInput.target?.objectKey ?? "(空)"} 与之不符；不得替换行动的对象绑定`,
      );
    }
    assertTargetIdentity(pkg, boundObject, canonicalId);

    const blockingReasons: OntologyActionPreview["blockingReasons"] = [];
    const pushBlocking = (code: OntologyActionRejectionCode, message: string) => blockingReasons.push({ code, message });

    // 工具绑定必须在既有网关白名单内：不在白名单的能力不得因本体声明而获得执行面。
    const definition = input.tools.list().find((tool) => tool.id === action.toolBinding.id);
    if (!action.toolBinding.version.trim()) pushBlocking(ONTOLOGY_ACTION_REJECTION_CODES.toolNotAllowed, `行动 ${action.key} 的工具绑定缺少版本声明`);
    if (!definition) {
      pushBlocking(ONTOLOGY_ACTION_REJECTION_CODES.toolNotAllowed, `行动 ${action.key} 绑定的工具 ${action.toolBinding.id || "(空)"} 不在工业 Agent 工具白名单，本体声明不扩大工具面`);
    } else {
      const roleFloor = roleFloorFor(action);
      if (roleFloor && actor.role === "viewer") {
        pushBlocking(ONTOLOGY_ACTION_REJECTION_CODES.scopeExceeded, `行动 ${action.key} 效果为 ${action.effect}（${definition.effect}），浏览者角色低于执行下限（${roleFloor}）`);
      }
    }
    if (planInput.scope !== undefined && !action.authorizedScopes.includes(planInput.scope)) {
      pushBlocking(ONTOLOGY_ACTION_REJECTION_CODES.scopeExceeded, `请求范围 ${planInput.scope} 不在行动 ${action.key} 的授权范围 [${action.authorizedScopes.join(", ")}] 内`);
    }

    const preconditions = action.preconditions.map((condition): OntologyActionPreconditionResult => ({
      label: condition.label,
      ...(condition.expression ? { expression: condition.expression } : {}),
      status: input.preconditionEvaluator?.(condition, { projectId, actionKey: action.key, canonicalId }) ?? "unknown",
    }));
    for (const precondition of preconditions) {
      if (precondition.status === "unknown") {
        pushBlocking(ONTOLOGY_ACTION_REJECTION_CODES.preconditionUnknown, `前置条件「${precondition.label}」无法评估（未知即拒绝，不得猜测放行）`);
      } else if (precondition.status === "failed") {
        pushBlocking(ONTOLOGY_ACTION_REJECTION_CODES.preconditionFailed, `前置条件「${precondition.label}」评估未通过`);
      }
    }

    const argumentErrors = validateArguments(action, planInput.arguments);
    for (const message of argumentErrors) pushBlocking(ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments, message);

    const arguments_ = planInput.arguments ?? {};
    // Semantica 刀3：本体约束校验（partial 口径——参数不是完整实例，只查同名属性键的
    // 类型/枚举/单位格式）。preview 恒 report-only（违规清单随预览返回供 UI 呈现），
    // 是否阻断由 execute 按策略决定。
    const constraintReport = validateOntologyObjectValues(boundObject, arguments_, {
      ...(input.constraints?.rules ? { rules: input.constraints.rules } : {}),
      mode: "partial",
    });

    const call = buildToolCall(projectId, action.toolBinding.id, arguments_, canonicalId);
    const planFingerprint = planActionFingerprint({
      packageId: pkg.id,
      packageVersion: pkg.version,
      actionKey: action.key,
      actionVersion: action.version,
      boundObject: action.boundObject,
      canonicalId,
      arguments: arguments_,
    });
    const approvalScopeFingerprint = input.tools.fingerprint(call);
    const idempotencyKey = planInput.idempotencyKey?.trim() || deriveActionIdempotencyKey({
      packageId: pkg.id,
      actionKey: action.key,
      canonicalId,
      arguments: arguments_,
    });

    return {
      packageId: pkg.id,
      packageVersion: pkg.version,
      ontologyStatus: "published",
      actionKey: action.key,
      actionLabel: action.label,
      actionVersion: action.version,
      boundObject: action.boundObject,
      target: { objectKey: action.boundObject, canonicalId },
      objectPath: buildObjectPath(pkg, action.boundObject, canonicalId),
      impact: buildImpact(pkg, action.boundObject),
      preconditions,
      risk: action.riskLevel,
      effect: action.effect,
      approvalRequired: action.approvalRequired,
      idempotencyKey,
      ...(action.rollback?.trim() ? { rollback: action.rollback } : {}),
      toolBinding: { kind: action.toolBinding.kind, id: action.toolBinding.id, version: action.toolBinding.version },
      planFingerprint,
      approvalScopeFingerprint,
      executable: blockingReasons.length === 0,
      blockingReasons,
      constraintViolations: constraintReport.violations,
      constraintCheckedRules: constraintReport.checkedRules,
    };
  }

  /**
   * 行动执行：预览复核（同一 fail-closed 门）→ 幂等重放 → 计划落账 → 审批闸 →
   * 网关执行 → 回执落账（成功/失败/阻断都如实成链，不伪造执行结果）。
   */
  async function execute(projectId: string, planInput: OntologyActionPlanInput, context: OntologyActionExecuteContext): Promise<OntologyExecuteOutcomeWithConstraints> {
    const actor: OntologyActionActor = { principal: context.principal, ...(context.role ? { role: context.role } : {}) };
    const planPreview = await preview(projectId, planInput, actor);
    if (!planPreview.executable) {
      const first = planPreview.blockingReasons[0];
      if (!first) return { status: "rejected", code: ONTOLOGY_ACTION_REJECTION_CODES.unbound, message: "行动计划被阻断且无理由码（不应发生）" };
      return { status: "rejected", code: first.code, message: first.message };
    }
    // Semantica 刀3（写入前闸门）：strict 模式下本体约束违规即拒绝——不落计划/执行/回执
    // 任何账本节点；report 模式（缺省）只随结果返回违规清单，不阻断执行链。
    if (planPreview.constraintViolations.length && input.constraints?.mode === "strict") {
      const digest = planPreview.constraintViolations.slice(0, 3).map((item) => `${item.path}: ${item.message}`).join("；");
      return {
        status: "rejected",
        code: ONTOLOGY_ACTION_REJECTION_CODES.invalidArguments,
        message: `本体约束校验未通过（strict 模式阻断，${planPreview.constraintViolations.length} 条违规）：${digest}${planPreview.constraintViolations.length > 3 ? "…" : ""}`,
        constraintViolations: planPreview.constraintViolations,
      };
    }
    const ledger = input.ledger?.();
    if (!ledger) throw new OntologyActionRuntimeError("ontology-runtime-unavailable", "行动回执账本未绑定，拒绝执行（fail-closed）");

    const replayed = await ledger.findActionReceiptByIdempotencyKey(projectId, planPreview.idempotencyKey);
    if (replayed) return { status: "executed", receipt: toReceipt(replayed, true) };

    await ledger.recordActionPlan(projectId, buildOntologyActionPlanNode({
      planFingerprint: planPreview.planFingerprint,
      packageId: planPreview.packageId,
      packageVersion: planPreview.packageVersion,
      actionKey: planPreview.actionKey,
      actionVersion: planPreview.actionVersion,
      boundObject: planPreview.boundObject,
      canonicalId: planPreview.target.canonicalId,
      riskLevel: planPreview.risk,
      effect: planPreview.effect,
      approvalRequired: planPreview.approvalRequired,
      idempotencyKey: planPreview.idempotencyKey,
      digest: `对 ${planPreview.boundObject}:${planPreview.target.canonicalId} 执行 ${planPreview.actionKey}（${planPreview.effect}/${planPreview.risk}），工具 ${planPreview.toolBinding.id}`,
      plannedAt: now(),
    }));

    if (planPreview.approvalRequired && !context.approval) {
      return { status: "awaiting-approval", preview: planPreview };
    }

    const executedAt = now();
    const call = buildToolCall(projectId, planPreview.toolBinding.id, planInput.arguments ?? {}, planPreview.target.canonicalId);
    let outcome: AgentToolOutcome;
    try {
      outcome = await input.tools.execute(call, {
        checkpoint: actionCheckpoint(projectId, context, planPreview, now()),
        ...(context.approval ? { approval: context.approval } : {}),
        signal: context.signal ?? new AbortController().signal,
      });
    } catch (error) {
      outcome = {
        status: "failed",
        evidence: [],
        verificationEvidence: [],
        error: { code: "tool-failed", message: error instanceof Error ? error.message : String(error), retryable: false },
      };
    }

    await ledger.recordActionExecution(projectId, buildOntologyActionExecutionNode({
      planFingerprint: planPreview.planFingerprint,
      inputFingerprint: actionInputFingerprint(planPreview.approvalScopeFingerprint),
      toolScopeFingerprint: planPreview.approvalScopeFingerprint,
      toolId: planPreview.toolBinding.id,
      executedAt,
    }));

    const status: OntologyActionReceipt["status"] = outcome.status === "completed" ? "executed" : outcome.status === "blocked" ? "blocked" : "failed";
    const evidenceFingerprints = [...outcome.evidence, ...outcome.verificationEvidence]
      .map((item) => item.fingerprint)
      .filter((item): item is string => Boolean(item));
    const receipt = buildOntologyActionReceiptNode({
      planFingerprint: planPreview.planFingerprint,
      inputFingerprint: actionInputFingerprint(planPreview.approvalScopeFingerprint),
      toolScopeFingerprint: planPreview.approvalScopeFingerprint,
      receiptFingerprint: receiptFingerprintOf({
        planFingerprint: planPreview.planFingerprint,
        inputFingerprint: actionInputFingerprint(planPreview.approvalScopeFingerprint),
        status,
        outputDigest: safeDigest(outcome.output),
      }),
      idempotencyKey: planPreview.idempotencyKey,
      status,
      ...(outcome.error ? { reasonCode: outcome.error.code } : {}),
      digest: receiptDigest(planPreview, outcome),
      evidenceFingerprints,
      receiptedAt: now(),
    });
    await ledger.recordActionReceipt(projectId, receipt);
    return { status, receipt: toReceipt(receipt, false), constraintViolations: planPreview.constraintViolations };
  }

  return { listPublishedActions, preview, execute };
}

export type OntologyActionService = ReturnType<typeof createOntologyActionService>;

// ---------------------------------------------------------------------------
// 生产装配：账本共享实例经既有 provenanceRoutes 注册绑入（不新增 index.ts 装配点）
// ---------------------------------------------------------------------------

let boundLedger: ProvenanceLedgerStore | undefined;

/** 幂等绑定共享账本实例（index.ts 既有 registerProvenanceRoutes 调用触发；测试可直接调用）。 */
export function bindOntologyActionLedger(ledger: ProvenanceLedgerStore): void {
  boundLedger = ledger;
}

/** 测试隔离：解绑共享账本（生产路径不调用）。 */
export function unbindOntologyActionLedgerForTest(): void {
  boundLedger = undefined;
}

export function resolveOntologyActionLedger(): ProvenanceLedgerStore | undefined {
  return boundLedger;
}

// ---------------------------------------------------------------------------
// 内部：解析、校验、投影
// ---------------------------------------------------------------------------

function toSummary(pkg: OntologyPackage, action: OntologyActionType): OntologyActionSummary {
  return {
    packageId: pkg.id,
    packageVersion: pkg.version,
    actionKey: action.key,
    label: action.label,
    boundObject: action.boundObject,
    riskLevel: action.riskLevel,
    effect: action.effect,
    approvalRequired: action.approvalRequired,
    idempotencyRequired: action.idempotencyRequired,
    ...(action.rollback?.trim() ? { rollback: action.rollback } : {}),
    toolBinding: structuredClone(action.toolBinding),
  };
}

/** 解析已发布包与行动：任何解析失败都携带显式理由码，不做就近猜测。 */
async function resolvePublishedAction(
  projectId: string,
  planInput: OntologyActionPlanInput,
  reader: OntologyActionPackageReader,
): Promise<{ pkg: OntologyPackage; action: OntologyActionType; boundObject: OntologyObjectType }> {
  if (!planInput.actionKey?.trim()) throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.unbound, "行动计划缺少 actionKey，无本体绑定的行动不得执行");
  const packages = await reader.listPackages(projectId);
  if (planInput.packageId !== undefined) {
    const pkg = packages.find((item) => item.id === planInput.packageId);
    if (!pkg) throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.unbound, `本体包 ${planInput.packageId} 不存在，行动计划无本体绑定`);
    if (pkg.status !== "published") {
      throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.packageNotPublished, `本体包 ${pkg.name} 处于「${pkg.status}」状态，未发布的行动不得进入执行链`);
    }
    return requireAction(pkg, planInput.actionKey);
  }
  const published = packages.filter((pkg) => pkg.status === "published" && pkg.actions.some((action) => action.key === planInput.actionKey));
  if (published.length === 0) {
    const drafts = packages.filter((pkg) => pkg.status !== "published" && pkg.actions.some((action) => action.key === planInput.actionKey));
    if (drafts.length) {
      throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.packageNotPublished, `行动 ${planInput.actionKey} 只存在于未发布本体包中（${drafts.map((pkg) => `${pkg.name}:${pkg.status}`).join("、")}），不得进入执行链`);
    }
    throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.unbound, `行动 ${planInput.actionKey} 未绑定任何已发布本体包中的行动，拒绝猜测放行`);
  }
  if (published.length > 1) {
    throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.unbound, `行动 ${planInput.actionKey} 命中多个已发布包（${published.map((pkg) => pkg.id).join("、")}），必须显式指定 packageId`);
  }
  const target = published[0];
  if (!target) throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.unbound, `行动 ${planInput.actionKey} 未命中已发布本体包`);
  return requireAction(target, planInput.actionKey);
}

async function requireAction(pkg: OntologyPackage, actionKey: string): Promise<{ pkg: OntologyPackage; action: OntologyActionType; boundObject: OntologyObjectType }> {
  const action = pkg.actions.find((item) => item.key === actionKey);
  if (!action) throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.unbound, `本体包 ${pkg.name} 中不存在行动 ${actionKey}，无本体绑定的行动不得执行`);
  const boundObject = pkg.objects.find((item) => item.key === action.boundObject);
  if (!boundObject) throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.unbound, `行动 ${actionKey} 绑定的对象 ${action.boundObject} 不在包中，行动无有效本体绑定`);
  return { pkg, action, boundObject };
}

function requireCanonicalId(value: unknown): string {
  const canonicalId = typeof value === "string" ? value.trim() : "";
  if (!canonicalId || canonicalId.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(canonicalId)) {
    throw new OntologyActionRejectionError(ONTOLOGY_ACTION_REJECTION_CODES.targetInvalid, "行动计划目标缺少合法的 canonicalObjectId；不得用自由文本指代对象");
  }
  return canonicalId;
}

/** 对象身份核验：包登记了身份映射时，目标必须在映射内；未登记的目标不放行猜测。 */
function assertTargetIdentity(pkg: OntologyPackage, boundObject: OntologyObjectType, canonicalId: string): void {
  const mappings = [...pkg.identityMappings, ...boundObject.identityMappings].filter((item) => item.objectKey === boundObject.key);
  if (mappings.length && !mappings.some((item) => item.canonicalId === canonicalId)) {
    throw new OntologyActionRejectionError(
      ONTOLOGY_ACTION_REJECTION_CODES.targetInvalid,
      `对象 ${boundObject.key} 的身份映射中不存在 ${canonicalId}；已登记身份：${mappings.map((item) => item.canonicalId).slice(0, 8).join("、")}`,
    );
  }
}

/** 写入/控制（或高风险）行动的角色下限：浏览者不可执行，编辑者不可执行 critical。 */
function roleFloorFor(action: OntologyActionType): "editor" | "admin" | undefined {
  const writeLike = action.effect === "internal-write" || action.effect === "external-write" || action.effect === "control";
  if (action.riskLevel === "critical") return "admin";
  if (writeLike || action.riskLevel === "high") return "editor";
  return undefined;
}

/** 业务契约层参数校验（网关层还有技术 Schema 校验，双层防线）。 */
function validateArguments(action: OntologyActionType, args: unknown): string[] {
  const errors: string[] = [];
  const properties = (action.inputSchema?.properties ?? {}) as Record<string, unknown>;
  const propertyKeys = new Set(Object.keys(properties));
  const required = Array.isArray(action.inputSchema?.required) ? (action.inputSchema.required as unknown[]).filter((item): item is string => typeof item === "string") : [];
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    errors.push(`行动 ${action.key} 的参数必须是对象`);
    return errors;
  }
  const keys = Object.keys(args as Record<string, unknown>);
  for (const key of keys) {
    if (!propertyKeys.has(key)) errors.push(`行动 ${action.key} 的输入 Schema 未声明参数 ${key}，合同外参数会被网关拒绝`);
  }
  for (const key of required) {
    if (!keys.includes(key)) errors.push(`行动 ${action.key} 的输入 Schema 必填参数 ${key} 缺失`);
  }
  return errors;
}

function buildToolCall(projectId: string, toolId: string, args: Record<string, unknown>, canonicalId: string): AgentToolCall {
  return {
    toolId,
    arguments: structuredClone(args),
    resources: [
      { kind: "project", id: projectId, projectId },
      { kind: "object", id: canonicalId, projectId },
    ],
  };
}

/** 对象路径：根步（canonicalObjectId）+ 1–2 跳关系邻域（类型级步不伪造实例身份）。 */
function buildObjectPath(pkg: OntologyPackage, boundObject: string, canonicalId: string): OntologyActionPathStep[] {
  const steps: OntologyActionPathStep[] = [{ objectKey: boundObject, canonicalId, hops: 0 }];
  for (const impact of buildImpact(pkg, boundObject)) {
    steps.push({ objectKey: impact.objectKey, relationKey: impact.relationKey, hops: impact.hops });
  }
  return steps;
}

/** 1–2 跳关系邻域：类型级 BFS，双向遍历关系端点，去重并截断。 */
function buildImpact(pkg: OntologyPackage, boundObject: string): OntologyActionImpactRef[] {
  const impact: OntologyActionImpactRef[] = [];
  const seen = new Set<string>([boundObject]);
  const frontier = new Map<string, string>([[boundObject, ""]]);
  for (let hop = 1; hop <= 2 && frontier.size; hop += 1) {
    const next = new Map<string, string>();
    for (const [node, _relation] of frontier) {
      for (const relation of pkg.relations) {
        const neighbor = relation.sourceObject === node
          ? relation.targetObject
          : relation.targetObject === node
            ? relation.sourceObject
            : undefined;
        if (!neighbor || seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.set(neighbor, relation.key);
        if (impact.length < IMPACT_CAP) impact.push({ objectKey: neighbor, relationKey: relation.key, hops: hop as 1 | 2 });
      }
    }
    frontier.clear();
    for (const [key, value] of next) frontier.set(key, value);
  }
  return impact;
}

/** 独立行动执行的网关上下文：checkpoint 只作执行上下文，不落 Agent 运行存档。 */
function actionCheckpoint(projectId: string, context: OntologyActionExecuteContext, preview: OntologyActionPreview, stamp: string): AgentCheckpoint {
  return {
    schemaVersion: 1,
    id: `ontology-action:${preview.planFingerprint}`,
    projectId,
    principal: context.principal,
    ...(context.role ? { role: context.role } : {}),
    objective: `本体行动 ${preview.actionKey} → ${preview.boundObject}:${preview.target.canonicalId}`,
    context: { kind: "ontology-action", planFingerprint: preview.planFingerprint, packageId: preview.packageId },
    status: "running",
    budget: { maxSteps: 1, maxDurationMs: 120_000, maxToolCalls: 1 },
    usage: { steps: 1, toolCalls: 0, activeDurationMs: 0 },
    allowedToolIds: [preview.toolBinding.id],
    decisions: [],
    toolRecords: [],
    seenToolFingerprints: [],
    createdAt: stamp,
    updatedAt: stamp,
    revision: 1,
  };
}

function toReceipt(node: {
  planFingerprint: string;
  inputFingerprint: string;
  toolScopeFingerprint?: string;
  receiptFingerprint: string;
  idempotencyKey: string;
  status: OntologyActionReceipt["status"];
  reasonCode?: string;
  digest: string;
  evidenceFingerprints: string[];
  receiptedAt: string;
}, replayed: boolean): OntologyActionReceipt {
  return {
    planFingerprint: node.planFingerprint,
    inputFingerprint: node.inputFingerprint,
    ...(node.toolScopeFingerprint ? { toolScopeFingerprint: node.toolScopeFingerprint } : {}),
    receiptFingerprint: node.receiptFingerprint,
    idempotencyKey: node.idempotencyKey,
    status: node.status,
    ...(node.reasonCode ? { reasonCode: node.reasonCode } : {}),
    digest: node.digest,
    evidenceFingerprints: [...node.evidenceFingerprints],
    receiptedAt: node.receiptedAt,
    ...(replayed ? { replayed: true } : {}),
  };
}

function receiptDigest(preview: OntologyActionPreview, outcome: AgentToolOutcome): string {
  const parts = [
    `${preview.actionKey} @ ${preview.boundObject}:${preview.target.canonicalId}`,
    `工具 ${preview.toolBinding.id} 结果 ${outcome.status}`,
  ];
  if (outcome.error) parts.push(`失败 ${outcome.error.code}: ${outcome.error.message}`);
  if (outcome.warnings?.length) parts.push(`警告 ${outcome.warnings.join("；")}`);
  return actionDigest(parts.join("；"));
}

function safeDigest(output: unknown): string {
  try {
    return actionDigest(JSON.stringify(output) ?? "");
  } catch {
    return actionDigest("(输出不可序列化)");
  }
}

/** 供路由把拒绝错误映射为结构化响应的辅助判定。 */
export function isOntologyActionRejection(error: unknown): error is OntologyActionRejectionError {
  return error instanceof OntologyActionRejectionError;
}
