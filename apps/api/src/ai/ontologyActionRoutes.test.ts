import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentToolCall, AgentToolGateway, AgentToolOutcome } from "@bim-studio/industrial-agent-orchestrator";
import { createApiServer } from "../serverOptions.js";
import { OntologyPackageStore } from "../ontology/ontologyStore.js";
import { registerProvenanceRoutes } from "./provenanceRoutes.js";
import { registerIndustrialAgentRoutes } from "./industrialAgentRoutes.js";
import { ProvenanceLedgerStore } from "./provenanceLedger.js";
import { aiToolScopeFingerprint } from "./aiToolReliability.js";
import { createOntologyActionService, unbindOntologyActionLedgerForTest } from "./ontologyActionService.js";
import type { IndustrialAgentRuntime } from "./industrialAgentRuntime.js";
import type { OntologyPackage } from "@bim-studio/contracts";

/**
 * H-C4-P3 行动路径 HTTP 面：端点挂在既有 Harness 路由模块上；
 * 拒绝理由码必须显式出现在响应体；生产懒装配（dataDir + 共享账本绑定）可用。
 */

const PROJECT = "project-hc4p3-http";
const NOW = () => new Date("2026-09-29T09:00:00.000Z");

const closeTasks: Array<() => Promise<void>> = [];
afterEach(async () => {
  unbindOntologyActionLedgerForTest();
  await Promise.all(closeTasks.splice(0).map((task) => task()));
});

async function newDataDir(): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ontology-action-routes-"));
  closeTasks.push(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function stringProperty(key: string, label: string) {
  return { key, label, type: "string" as const, confirmed: true };
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
    objects: [{
      id: "obj-device",
      key: "Device",
      label: "设备",
      domain: "industrial",
      primaryKeys: ["code"],
      properties: [stringProperty("code", "编码")],
      sourceBindings: [{ kind: "manual" as const, sourceId: "manual", fieldMappings: [], note: "人工登记" }],
      aliases: [],
      identityMappings: [{ objectKey: "Device", canonicalId: "press-07", sources: [{ sourceKind: "manual" as const, sourceId: "seed", externalId: "press-07" }] }],
      status: "draft" as const,
      version: 0,
      owner: "tester",
    }],
    relations: [],
    actions: [structuredClone(READ_ACTION), structuredClone(CONTROL_ACTION)],
    events: [],
    metrics: [],
    identityMappings: [],
    goldenQuestions: [{ id: "gq-1", question: "只读诊断可预览", passed: true, passedAt: stamp }],
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

async function publishPackage(dataDir: string): Promise<void> {
  const store = new OntologyPackageStore(dataDir);
  await store.init();
  await store.createPackage(PROJECT, buildPackage("pkg-line"), "tester");
  await store.transitionStatus(PROJECT, "pkg-line", "review", "tester");
  await store.publishPackage(PROJECT, "pkg-line", "tester", {
    capabilities: [
      { id: "data.query.read", version: "1.0.0", kind: "query" },
      { id: "operations.control.apply", version: "1.2.0", kind: "action" },
    ],
    datasetSchemas: {},
  });
}

function fakeTools() {
  const execute = vi.fn(async (): Promise<AgentToolOutcome> => ({
    status: "completed",
    output: { verificationStatus: "passed" },
    evidence: [{ id: "e1", kind: "trace", label: "诊断", source: "capability", fingerprint: "bbbbbbbbbbbbbbbb" }],
    verificationEvidence: [],
  }));
  const tools: AgentToolGateway = {
    list: () => [
      { id: "data.query.read", label: "数据读取", description: "", effect: "read", risk: "low", requiresApproval: false },
      { id: "operations.control.apply", label: "控制下发", description: "", effect: "control", risk: "high", requiresApproval: true },
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

function mockRuntime(dataDir: string, tools: AgentToolGateway): IndustrialAgentRuntime {
  return {
    checkpoints: { get: async () => undefined, save: async () => undefined } as never,
    tools,
    orchestrator: {} as never,
    memory: {} as never,
    dataDir,
  };
}

const DIAGNOSE_BODY = {
  actionKey: "device.diagnose",
  target: { objectKey: "Device", canonicalId: "press-07" },
  arguments: { window: "24h" },
};

async function buildApp(options: { role?: string; injectService?: boolean; ledgerBound?: boolean } = {}) {
  const dataDir = await newDataDir();
  await publishPackage(dataDir);
  const ledger = new ProvenanceLedgerStore(dataDir, { now: NOW });
  await ledger.init();
  const { tools } = fakeTools();
  const runtime = mockRuntime(dataDir, tools);
  const app = createApiServer();
  closeTasks.push(() => app.close());
  app.addHook("preHandler", async (request) => {
    request.systemUser = { id: "actor-1", role: options.role ?? "editor", projectIds: [PROJECT] } as never;
  });
  const projectExists = (id: string) => id === PROJECT;
  // 生产装配路径：账本经既有 provenanceRoutes 注册绑入。
  await registerProvenanceRoutes(app, { store: { getProject: async (id: string) => (id === PROJECT ? { id } : undefined) as never }, ledger });
  const injected = options.injectService
    ? createOntologyActionService({
      ontologyReader: () => new OntologyPackageStore(dataDir),
      ...(options.ledgerBound === false ? {} : { ledger: () => ledger }),
      tools,
      now: NOW,
    })
    : undefined;
  await registerIndustrialAgentRoutes(app, { store: { getProject: async (id: string) => (id === PROJECT ? { id } : undefined) as never }, runtime, ...(injected ? { ontologyActionService: injected } : {}) });
  return { app, ledger, dataDir };
}

describe("H-C4-P3 本体行动路径 HTTP 面", () => {
  it("行动清单只含已发布本体行动；未知项目 404", async () => {
    const { app } = await buildApp();
    const ok = await app.inject({ method: "GET", url: `/api/projects/${PROJECT}/ai/ontology-actions` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().actions.map((item: { actionKey: string }) => item.actionKey).sort())
      .toEqual(["device.control.apply", "device.diagnose"]);
    const missing = await app.inject({ method: "GET", url: "/api/projects/project-other/ai/ontology-actions" });
    expect(missing.statusCode).toBe(404);
  });

  it("预览返回目标对象、影响范围与幂等键，executable=true", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "POST", url: `/api/projects/${PROJECT}/ai/ontology-actions/preview`, payload: DIAGNOSE_BODY });
    expect(response.statusCode).toBe(200);
    const preview = response.json();
    expect(preview).toMatchObject({
      actionKey: "device.diagnose",
      boundObject: "Device",
      target: { objectKey: "Device", canonicalId: "press-07" },
      executable: true,
      approvalRequired: false,
    });
    expect(preview.objectPath[0]).toEqual({ objectKey: "Device", canonicalId: "press-07", hops: 0 });
    expect(preview.idempotencyKey).toMatch(/^[0-9a-f]{16}$/);
  });

  it("预览无本体绑定的行动返回 422 与显式理由码", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT}/ai/ontology-actions/preview`,
      payload: { ...DIAGNOSE_BODY, actionKey: "device.unknown" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "ontology-action-unbound" });
  });

  it("执行前置条件未知被拒：409 携带 ontology-precondition-unknown（默认无评估器 fail-closed）", async () => {
    const { app } = await buildApp({ injectService: true });
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT}/ai/ontology-actions/execute`,
      payload: { actionKey: "device.control.apply", target: { objectKey: "Device", canonicalId: "press-07" }, arguments: { command: "pause" } },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: "rejected", code: "ontology-precondition-unknown" });
  });

  it("浏览者执行本体行动 403", async () => {
    const { app } = await buildApp({ role: "viewer", injectService: true });
    const response = await app.inject({ method: "POST", url: `/api/projects/${PROJECT}/ai/ontology-actions/execute`, payload: DIAGNOSE_BODY });
    expect(response.statusCode).toBe(403);
  });

  it("账本未绑定时执行 fail-closed 503（ontology-runtime-unavailable），不静默放行", async () => {
    const { app } = await buildApp({ injectService: true, ledgerBound: false });
    const response = await app.inject({ method: "POST", url: `/api/projects/${PROJECT}/ai/ontology-actions/execute`, payload: DIAGNOSE_BODY });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "ontology-runtime-unavailable" });
  });

  it("生产懒装配可用：注册 provenanceRoutes 绑定账本后，执行走 dataDir 读取器与运行时网关并返回回执", async () => {
    const { app } = await buildApp();
    // 默认（未注入 service）：测试环境 runtime 带 dataDir + 工具网关，账本已经 registerProvenanceRoutes 绑定。
    // 行动有前置条件时默认评估器恒 unknown —— 本包的只读行动无前置条件，可直接执行。
    const response = await app.inject({ method: "POST", url: `/api/projects/${PROJECT}/ai/ontology-actions/execute`, payload: DIAGNOSE_BODY });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("executed");
    expect(body.receipt.status).toBe("executed");
    expect(body.receipt.evidenceFingerprints).toContain("bbbbbbbbbbbbbbbb");
  });

  it("三跳链经 HTTP 可查：trace 按计划指纹返回 计划→执行→回执 且完整性完好", async () => {
    const { app } = await buildApp();
    const executed = await app.inject({ method: "POST", url: `/api/projects/${PROJECT}/ai/ontology-actions/execute`, payload: DIAGNOSE_BODY });
    const receipt = executed.json().receipt;
    const trace = await app.inject({ method: "GET", url: `/api/projects/${PROJECT}/ai/ontology-actions/trace?planFingerprint=${receipt.planFingerprint}` });
    expect(trace.statusCode).toBe(200);
    const body = trace.json();
    expect(body.matched).toBe(true);
    const chain = body.chains[0];
    expect(chain.plan.actionKey).toBe("device.diagnose");
    expect(chain.executions).toHaveLength(1);
    expect(chain.receipts).toHaveLength(1);
    expect(chain.edges.map((edge: { relation: string }) => edge.relation)).toEqual(["executed", "receipted"]);
    expect(chain.integrity).toBe("intact");
    expect(body.integrity.intact).toBe(true);
  });

  it("trace 非法指纹查询 422（fail-closed 查询校验），不返回伪造链", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "GET", url: `/api/projects/${PROJECT}/ai/ontology-actions/trace?planFingerprint=zzzz` });
    expect(response.statusCode).toBe(422);
  });
});
