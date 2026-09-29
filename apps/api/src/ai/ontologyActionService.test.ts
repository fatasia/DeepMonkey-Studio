import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OntologyPackage } from "@bim-studio/contracts";
import type { AgentToolCall, AgentToolGateway, AgentToolOutcome } from "@bim-studio/industrial-agent-orchestrator";
import { OntologyPackageStore } from "../ontology/ontologyStore.js";
import { ProvenanceLedgerStore } from "./provenanceLedger.js";
import { aiToolScopeFingerprint } from "./aiToolReliability.js";
import {
  ONTOLOGY_ACTION_REJECTION_CODES,
} from "./ontologyActionContracts.js";
import {
  createOntologyActionService,
  unbindOntologyActionLedgerForTest,
  type OntologyActionService,
} from "./ontologyActionService.js";

/**
 * H-C4-P3「Harness 行动路径」服务闭环测试：
 * 计划→预览→执行→回执全链（真实 OntologyPackageStore + 真实 ProvenanceLedgerStore +
 * 既有工具网关端口），拒绝矩阵三例逐条断言，三跳链按指纹可查。
 */

const PROJECT = "project-hc4p3";
const NOW = () => new Date("2026-09-29T08:00:00.000Z");

const closeTasks: Array<() => Promise<void>> = [];
afterEach(async () => {
  unbindOntologyActionLedgerForTest();
  await Promise.all(closeTasks.splice(0).map((task) => task()));
});

async function createStore(): Promise<{ dataDir: string }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ontology-action-"));
  closeTasks.push(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir };
}

function stringProperty(key: string, label: string) {
  return { key, label, type: "string" as const, confirmed: true };
}

function relation(key: string, sourceObject: string, targetObject: string, sourceField: string, targetField: string) {
  return {
    id: `rel-${key}`,
    key,
    label: key,
    sourceObject,
    targetObject,
    cardinality: "one-to-many" as const,
    direction: "directed" as const,
    properties: [],
    keyMapping: { sourceField, targetField },
    source: { kind: "manual" as const, note: `种子数据：${key}` },
    evidence: [{ source: "seed", sampleCount: 3, recordedAt: "2026-09-29T07:00:00.000Z" }],
    status: "draft" as const,
    version: 0,
  };
}

function object(key: string, label: string, canonicalIds: string[] = []) {
  return {
    id: `obj-${key}`,
    key,
    label,
    domain: "industrial",
    primaryKeys: ["code"],
    properties: [stringProperty("code", "编码")],
    sourceBindings: [{ kind: "manual" as const, sourceId: "manual", fieldMappings: [], note: "人工登记对象" }],
    aliases: [],
    identityMappings: canonicalIds.map((canonicalId) => ({
      objectKey: key,
      canonicalId,
      sources: [{ sourceKind: "manual" as const, sourceId: "seed", externalId: canonicalId }],
    })),
    status: "draft" as const,
    version: 0,
    owner: "tester",
  };
}

const READ_ACTION = {
  id: "act-read",
  key: "device.diagnose",
  label: "只读诊断",
  boundObject: "Device",
  inputSchema: { type: "object", properties: { window: { type: "string" } }, required: [] },
  outputSchema: { type: "object", properties: {} },
  toolBinding: { kind: "capability" as const, id: "data.query.read", version: "1.0.0" },
  preconditions: [],
  effect: "read" as const,
  riskLevel: "low" as const,
  approvalRequired: false,
  idempotencyRequired: false,
  impactScope: ["Device"],
  authorizedScopes: ["project"],
  evidenceRequired: true,
  status: "draft" as const,
  version: 0,
};

const CONTROL_ACTION = {
  id: "act-control",
  key: "device.control.apply",
  label: "控制下发",
  boundObject: "Device",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  outputSchema: { type: "object", properties: {} },
  toolBinding: { kind: "capability" as const, id: "operations.control.apply", version: "1.2.0" },
  preconditions: [{ label: "设备在线", expression: "device.online == true" }],
  effect: "external-write" as const,
  riskLevel: "high" as const,
  approvalRequired: true,
  idempotencyRequired: true,
  impactScope: ["Device"],
  authorizedScopes: ["project"],
  rollback: "撤销最后一条控制指令并回读状态",
  evidenceRequired: true,
  status: "draft" as const,
  version: 0,
};

function buildPackage(id: string): OntologyPackage {
  const stamp = "2026-09-29T07:00:00.000Z";
  return {
    schemaVersion: 1,
    id,
    name: `产线本体 ${id}`,
    domain: "industrial",
    version: 0,
    revision: 0,
    objects: [
      object("Device", "设备", ["press-07"]),
      object("TelemetryPoint", "测点", ["point-temperature"]),
      object("MaintenanceEvent", "维护事件"),
      object("Space", "空间"),
    ],
    relations: [
      relation("device-has-point", "Device", "TelemetryPoint", "code", "code"),
      relation("point-triggers-event", "TelemetryPoint", "MaintenanceEvent", "code", "code"),
      relation("device-located-space", "Device", "Space", "code", "code"),
    ],
    actions: [structuredClone(READ_ACTION), structuredClone(CONTROL_ACTION)],
    events: [],
    metrics: [],
    identityMappings: [],
    goldenQuestions: [{ id: "gq-1", question: "只读诊断行动可预览且幂等键稳定", passed: true, passedAt: stamp }],
    policies: [{ id: "pol-control", scope: ["device.control.apply"] }],
    evidence: [],
    impactReviewed: true,
    impactReviewedBy: "tester",
    status: "draft",
    owner: "tester",
    createdAt: stamp,
    updatedAt: stamp,
  };
}

const PUBLISH_CTX = {
  capabilities: [
    { id: "data.query.read", version: "1.0.0", kind: "query" },
    { id: "operations.control.apply", version: "1.2.0", kind: "action" },
  ],
  datasetSchemas: {},
};

async function publishFixturePackage(store: OntologyPackageStore, packageId: string): Promise<void> {
  await store.createPackage(PROJECT, buildPackage(packageId), "tester");
  await store.transitionStatus(PROJECT, packageId, "review", "tester");
  await store.publishPackage(PROJECT, packageId, "tester", PUBLISH_CTX);
}

const DIAGNOSE_PLAN = {
  actionKey: "device.diagnose",
  target: { objectKey: "Device", canonicalId: "press-07" },
  arguments: { window: "24h" },
};
const CONTROL_PLAN = {
  actionKey: "device.control.apply",
  target: { objectKey: "Device", canonicalId: "press-07" },
  arguments: { command: "pause" },
};

function fakeTools() {
  const execute = vi.fn(async (): Promise<AgentToolOutcome> => ({
    status: "completed",
    output: { verificationStatus: "passed", window: "24h" },
    evidence: [{ id: "e1", kind: "trace", label: "诊断证据", source: "capability", fingerprint: "aaaaaaaaaaaaaaaa" }],
    verificationEvidence: [],
  }));
  const tools: AgentToolGateway & { execute: typeof execute } = {
    list: () => [
      { id: "data.query.read", label: "数据读取", description: "只读查询", effect: "read", risk: "low", requiresApproval: false },
      { id: "operations.control.apply", label: "控制下发", description: "受控写入", effect: "control", risk: "high", requiresApproval: true },
    ],
    fingerprint: (call: AgentToolCall) => aiToolScopeFingerprint({
      toolId: call.toolId,
      projectId: call.resources.find((item) => item.kind === "project")?.id ?? "",
      arguments: call.arguments,
      resources: call.resources,
    }),
    execute,
  };
  return { tools, execute };
}

interface Harness {
  service: OntologyActionService;
  ledger: ProvenanceLedgerStore;
  execute: ReturnType<typeof fakeTools>["execute"];
}

async function buildHarness(options: { preconditionEvaluator?: "passed" | "failed"; omitLedger?: boolean; toolIds?: string[] } = {}): Promise<Harness> {
  const { dataDir } = await createStore();
  const store = new OntologyPackageStore(dataDir);
  await store.init();
  await publishFixturePackage(store, "pkg-line");
  const ledger = new ProvenanceLedgerStore(dataDir, { now: NOW });
  await ledger.init();
  const { tools, execute } = fakeTools();
  const toolList = tools.list.bind(tools);
  if (options.toolIds) tools.list = () => toolList().filter((tool) => options.toolIds.includes(tool.id));
  const service = createOntologyActionService({
    ontologyReader: () => new OntologyPackageStore(dataDir),
    ...(options.omitLedger ? {} : { ledger: () => ledger }),
    tools,
    ...(options.preconditionEvaluator
      ? { preconditionEvaluator: () => options.preconditionEvaluator as "passed" | "failed" }
      : {}),
    now: NOW,
  });
  return { service, ledger, execute };
}

describe("H-C4-P3 本体行动路径：计划→预览→执行→回执", () => {
  it("已发布行动清单只暴露已发布包的行动，未发布包的行动不可见", async () => {
    const { dataDir } = await createStore();
    const store = new OntologyPackageStore(dataDir);
    await store.init();
    await publishFixturePackage(store, "pkg-line");
    await store.createPackage(PROJECT, { ...buildPackage("pkg-draft"), name: "产线本体草稿" }, "tester");
    const service = createOntologyActionService({ ontologyReader: () => store, tools: fakeTools().tools, now: NOW });
    const actions = await service.listPublishedActions(PROJECT);
    expect(actions.map((action) => action.actionKey).sort()).toEqual(["device.control.apply", "device.diagnose"]);
    expect(actions.every((action) => action.packageId === "pkg-line")).toBe(true);
  });

  it("预览携带对象路径 canonicalObjectId 链与本体行动契约字段（效果/风险/审批/幂等/回滚）", async () => {
    const { service } = await buildHarness({ preconditionEvaluator: "passed" });
    const preview = await service.preview(PROJECT, CONTROL_PLAN, { principal: "editor-1", role: "editor" });
    expect(preview.objectPath[0]).toEqual({ objectKey: "Device", canonicalId: "press-07", hops: 0 });
    expect(preview.effect).toBe("external-write");
    expect(preview.risk).toBe("high");
    expect(preview.approvalRequired).toBe(true);
    expect(preview.rollback).toBe("撤销最后一条控制指令并回读状态");
    expect(preview.toolBinding).toEqual({ kind: "capability", id: "operations.control.apply", version: "1.2.0" });
    expect(preview.planFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(preview.approvalScopeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.idempotencyKey).toMatch(/^[0-9a-f]{16}$/);
    expect(preview.preconditions).toEqual([{ label: "设备在线", expression: "device.online == true", status: "passed" }]);
  });

  it("影响范围为 1–2 跳关系邻域（测点/事件为 2 跳，空间为 1 跳）并进入对象路径", async () => {
    const { service } = await buildHarness({ preconditionEvaluator: "passed" });
    const preview = await service.preview(PROJECT, DIAGNOSE_PLAN, { principal: "editor-1" });
    expect(preview.impact).toEqual([
      { objectKey: "TelemetryPoint", relationKey: "device-has-point", hops: 1 },
      { objectKey: "Space", relationKey: "device-located-space", hops: 1 },
      { objectKey: "MaintenanceEvent", relationKey: "point-triggers-event", hops: 2 },
    ]);
    expect(preview.objectPath.map((step) => step.objectKey)).toEqual(["Device", "TelemetryPoint", "Space", "MaintenanceEvent"]);
    expect(preview.objectPath.every((step) => step.hops === 0 ? step.canonicalId === "press-07" : step.relationKey !== undefined)).toBe(true);
  });

  it("拒绝矩阵①：无本体绑定的行动被拒（ontology-action-unbound），不落账不执行", async () => {
    const { service, ledger, execute } = await buildHarness({ preconditionEvaluator: "passed" });
    await expect(service.preview(PROJECT, { ...DIAGNOSE_PLAN, actionKey: "device.unknown" }, { principal: "editor-1" }))
      .rejects.toMatchObject({ code: ONTOLOGY_ACTION_REJECTION_CODES.unbound });
    await expect(service.execute(PROJECT, { ...DIAGNOSE_PLAN, actionKey: "device.unknown" }, { principal: "editor-1" }))
      .rejects.toMatchObject({ code: "ontology-action-unbound" });
    expect(execute).not.toHaveBeenCalled();
    await expect(ledger.traceActionChains(PROJECT, { planFingerprint: "0".repeat(16) })).resolves.toMatchObject({ matched: false, chains: [] });
  });

  it("拒绝矩阵①b：行动只存在于未发布包被拒（ontology-package-not-published）", async () => {
    const { dataDir } = await createStore();
    const store = new OntologyPackageStore(dataDir);
    await store.init();
    await store.createPackage(PROJECT, { ...buildPackage("pkg-draft"), name: "未发布产线本体", actions: [structuredClone(READ_ACTION)] }, "tester");
    const service = createOntologyActionService({ ontologyReader: () => store, tools: fakeTools().tools, now: NOW });
    await expect(service.execute(PROJECT, DIAGNOSE_PLAN, { principal: "editor-1" }))
      .rejects.toMatchObject({ code: "ontology-package-not-published" });
  });

  it("拒绝矩阵②：前置条件未知 fail-closed 被拒（ontology-precondition-unknown），不得猜测放行", async () => {
    const { service, execute } = await buildHarness();
    const outcome = await service.execute(PROJECT, CONTROL_PLAN, { principal: "editor-1", role: "editor" });
    expect(outcome).toMatchObject({ status: "rejected", code: "ontology-precondition-unknown" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("拒绝矩阵②b：前置条件评估失败被拒（ontology-precondition-failed）", async () => {
    const { service, execute } = await buildHarness({ preconditionEvaluator: "failed" });
    const outcome = await service.execute(PROJECT, CONTROL_PLAN, { principal: "editor-1", role: "editor" });
    expect(outcome).toMatchObject({ status: "rejected", code: "ontology-precondition-failed" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("拒绝矩阵③：权限超范围被拒（ontology-scope-exceeded）——越权 scope 与浏览者角色两个方向", async () => {
    const { service, execute } = await buildHarness({ preconditionEvaluator: "passed" });
    const outOfScope = await service.execute(
      PROJECT,
      { ...DIAGNOSE_PLAN, scope: "tenant-b" },
      { principal: "editor-1" },
    );
    expect(outOfScope).toMatchObject({ status: "rejected", code: "ontology-scope-exceeded" });
    const viewer = await service.execute(PROJECT, CONTROL_PLAN, { principal: "viewer-1", role: "viewer" });
    expect(viewer).toMatchObject({ status: "rejected", code: "ontology-scope-exceeded" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("拒绝矩阵④：绑定工具不在网关白名单被拒（ontology-tool-not-allowed），本体声明不扩大工具面", async () => {
    const { service } = await buildHarness({ preconditionEvaluator: "passed", toolIds: ["data.query.read"] });
    const outcome = await service.execute(PROJECT, CONTROL_PLAN, { principal: "editor-1", role: "editor" });
    expect(outcome).toMatchObject({ status: "rejected", code: "ontology-tool-not-allowed" });
  });

  it("只读行动自动执行：走工具网关返回证据回执，能力调用带目标对象资源", async () => {
    const { service, execute } = await buildHarness({ preconditionEvaluator: "passed" });
    const outcome = await service.execute(PROJECT, DIAGNOSE_PLAN, { principal: "editor-1" });
    expect(outcome.status).toBe("executed");
    if (outcome.status !== "executed") return;
    expect(outcome.receipt.status).toBe("executed");
    expect(outcome.receipt.evidenceFingerprints).toContain("aaaaaaaaaaaaaaaa");
    expect(outcome.receipt.replayed).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0]?.[0] as AgentToolCall;
    expect(call.toolId).toBe("data.query.read");
    expect(call.arguments).toEqual({ window: "24h" });
    expect(call.resources).toContainEqual({ kind: "object", id: "press-07", projectId: PROJECT });
  });

  it("三跳链可查：执行回执落账后按计划指纹查出 计划→执行→回执 链且完整性完好", async () => {
    const { service, ledger } = await buildHarness({ preconditionEvaluator: "passed" });
    const outcome = await service.execute(PROJECT, DIAGNOSE_PLAN, { principal: "editor-1" });
    if (outcome.status !== "executed") throw new Error("执行应成功");
    const trace = await ledger.traceActionChains(PROJECT, { planFingerprint: outcome.receipt.planFingerprint });
    expect(trace.matched).toBe(true);
    const chain = trace.chains[0];
    expect(chain).toBeDefined();
    if (!chain) return;
    expect(chain.plan.actionKey).toBe("device.diagnose");
    expect(chain.plan.canonicalId).toBe("press-07");
    expect(chain.executions).toHaveLength(1);
    expect(chain.executions[0]?.toolId).toBe("data.query.read");
    expect(chain.receipts).toHaveLength(1);
    expect(chain.receipts[0]?.status).toBe("executed");
    expect(chain.receipts[0]?.evidenceFingerprints).toContain("aaaaaaaaaaaaaaaa");
    expect(chain.edges.map((edge) => edge.relation)).toEqual(["executed", "receipted"]);
    expect(chain.integrity).toBe("intact");
    expect(trace.integrity.intact).toBe(true);
    // 回执指纹反查同链（证据指纹三跳可回溯）。
    const byReceipt = await ledger.traceActionChains(PROJECT, { receiptFingerprint: outcome.receipt.receiptFingerprint });
    expect(byReceipt.chains[0]?.plan.planFingerprint).toBe(outcome.receipt.planFingerprint);
  });

  it("幂等重放：同幂等键重复提交返回既有回执，不重复执行工具", async () => {
    const { service, execute } = await buildHarness({ preconditionEvaluator: "passed" });
    const first = await service.execute(PROJECT, DIAGNOSE_PLAN, { principal: "editor-1" });
    const second = await service.execute(PROJECT, DIAGNOSE_PLAN, { principal: "editor-1" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(second.status).toBe("executed");
    if (first.status !== "executed" || second.status !== "executed") return;
    expect(second.receipt.replayed).toBe(true);
    expect(second.receipt.receiptFingerprint).toBe(first.receipt.receiptFingerprint);
  });

  it("失败执行如实成链：回执记录 failed 与理由码，不伪造成功，链完整性完好", async () => {
    const failing = await buildHarnessWithExecute({ preconditionEvaluator: "passed" }, async () => ({
      status: "failed" as const,
      evidence: [],
      verificationEvidence: [],
      error: { code: "provider-failed", message: "能力执行失败", retryable: true },
    }));
    const outcome = await failing.service.execute(PROJECT, DIAGNOSE_PLAN, { principal: "editor-1" });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.receipt.status).toBe("failed");
    expect(outcome.receipt.reasonCode).toBe("provider-failed");
    const trace = await failing.ledger.traceActionChains(PROJECT, { planFingerprint: outcome.receipt.planFingerprint });
    expect(trace.chains[0]?.receipts[0]?.status).toBe("failed");
    expect(trace.chains[0]?.integrity).toBe("intact");
    expect(trace.integrity.intact).toBe(true);
  });

  it("写入行动逐次审批：无审批返回 awaiting-approval，只计划未执行（链如实呈现空执行段）", async () => {
    const { service, ledger, execute } = await buildHarness({ preconditionEvaluator: "passed" });
    const outcome = await service.execute(PROJECT, CONTROL_PLAN, { principal: "editor-1", role: "editor" });
    expect(outcome.status).toBe("awaiting-approval");
    if (outcome.status !== "awaiting-approval") return;
    expect(outcome.preview.approvalScopeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(execute).not.toHaveBeenCalled();
    const trace = await ledger.traceActionChains(PROJECT, { planFingerprint: outcome.preview.planFingerprint });
    expect(trace.matched).toBe(true);
    expect(trace.chains[0]?.executions).toHaveLength(0);
    expect(trace.chains[0]?.receipts).toHaveLength(0);
    expect(trace.chains[0]?.integrity).toBe("intact");
  });

  it("审批通过后执行：审批范围指纹与工具调用 scope 指纹一致（对接既有审批机制）", async () => {
    const { service, execute } = await buildHarness({ preconditionEvaluator: "passed" });
    const pending = await service.execute(PROJECT, CONTROL_PLAN, { principal: "editor-1", role: "editor" });
    if (pending.status !== "awaiting-approval") throw new Error("应等待审批");
    const approvalScope = pending.preview.approvalScopeFingerprint;
    // 审批范围指纹必须逐字等于既有机制（executeReliableAiTool）校验的工具调用指纹。
    expect(approvalScope).toBe(aiToolScopeFingerprint({
      toolId: "operations.control.apply",
      projectId: PROJECT,
      arguments: { command: "pause" },
      resources: [
        { kind: "project", id: PROJECT, projectId: PROJECT },
        { kind: "object", id: "press-07", projectId: PROJECT },
      ],
    }));
    const outcome = await service.execute(PROJECT, CONTROL_PLAN, {
      principal: "editor-1",
      role: "editor",
      approval: { approvedBy: "editor-1", approvedAt: NOW().toISOString(), scopeFingerprint: approvalScope },
    });
    expect(outcome.status).toBe("executed");
    expect(execute).toHaveBeenCalledTimes(1);
    const context = execute.mock.calls[0]?.[1] as { approval?: { scopeFingerprint: string } };
    expect(context.approval?.scopeFingerprint).toBe(approvalScope);
  });

  it("账本重开可读行动链：持久化与 fail-closed 形状过滤后三跳链仍在", async () => {
    const { dataDir } = await createStore();
    const store = new OntologyPackageStore(dataDir);
    await store.init();
    await publishFixturePackage(store, "pkg-line");
    const ledger = new ProvenanceLedgerStore(dataDir, { now: NOW });
    await ledger.init();
    const { tools } = fakeTools();
    const service = createOntologyActionService({
      ontologyReader: () => new OntologyPackageStore(dataDir),
      ledger: () => ledger,
      tools,
      preconditionEvaluator: () => "passed",
      now: NOW,
    });
    const outcome = await service.execute(PROJECT, DIAGNOSE_PLAN, { principal: "editor-1" });
    if (outcome.status !== "executed") throw new Error("执行应成功");
    const reopened = new ProvenanceLedgerStore(dataDir, { now: NOW });
    await reopened.init();
    const trace = await reopened.traceActionChains(PROJECT, { planFingerprint: outcome.receipt.planFingerprint });
    expect(trace.matched).toBe(true);
    expect(trace.chains[0]?.receipts).toHaveLength(1);
    expect(trace.integrity.intact).toBe(true);
  });
});

/** 独立 harness：注入自定义工具执行结果（失败路径测试用）。 */
async function buildHarnessWithExecute(
  options: { preconditionEvaluator?: "passed" | "failed" },
  executeImpl: () => Promise<AgentToolOutcome>,
): Promise<{ service: OntologyActionService; ledger: ProvenanceLedgerStore }> {
  const { dataDir } = await createStore();
  const store = new OntologyPackageStore(dataDir);
  await store.init();
  await publishFixturePackage(store, "pkg-line");
  const ledger = new ProvenanceLedgerStore(dataDir, { now: NOW });
  await ledger.init();
  const { tools } = fakeTools();
  tools.execute = vi.fn(executeImpl);
  const service = createOntologyActionService({
    ontologyReader: () => new OntologyPackageStore(dataDir),
    ledger: () => ledger,
    tools,
    ...(options.preconditionEvaluator ? { preconditionEvaluator: () => options.preconditionEvaluator as "passed" | "failed" } : {}),
    now: NOW,
  });
  return { service, ledger };
}
