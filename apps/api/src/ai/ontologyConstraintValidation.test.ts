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
  createOntologyActionService,
  unbindOntologyActionLedgerForTest,
  type OntologyActionService,
} from "./ontologyActionService.js";
import {
  ONTOLOGY_CONSTRAINT_RULE_TABLE,
  validateOntologyObjectValues,
  type OntologyObjectType,
} from "./ontologyConstraintValidation.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  unbindOntologyActionLedgerForTest();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

// ---------------------------------------------------------------------------
// 纯校验器：正负例 + 规则表裁剪
// ---------------------------------------------------------------------------

const DEVICE: OntologyObjectType = {
  id: "obj-device",
  key: "Device",
  label: "设备",
  domain: "industrial",
  primaryKeys: ["code"],
  properties: [
    { key: "code", label: "编码", type: "string", confirmed: true, required: true },
    { key: "ratedPower", label: "额定功率", type: "number", confirmed: true, unit: "kW" },
    { key: "status", label: "状态", type: "enum", confirmed: true, enumValues: ["running", "idle", "faulted"] },
    { key: "lastServiceAt", label: "末次维护", type: "datetime", confirmed: true },
    { key: "offline", label: "是否离线", type: "boolean", confirmed: true },
    { key: "payload", label: "透传载荷", type: "json", confirmed: true },
  ],
  sourceBindings: [],
  aliases: [],
  identityMappings: [],
  status: "published",
  version: 1,
  owner: "tester",
};

describe("Semantica 刀3：本体约束校验器（validateOntologyObjectValues）", () => {
  it("full 口径正例：合法实例零违规", () => {
    const report = validateOntologyObjectValues(DEVICE, {
      code: "press-07",
      ratedPower: 42,
      status: "running",
      lastServiceAt: "2026-10-05T08:00:00.000Z",
      offline: false,
      payload: { nested: [1, 2] },
    }, { mode: "full" });
    expect(report.valid).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.mode).toBe("full");
  });

  it("full 口径负例：必填缺失/类型不符/枚举越界/单位格式/合同外属性逐条命中", () => {
    const report = validateOntologyObjectValues(DEVICE, {
      ratedPower: true,
      status: "exploded",
      lastServiceAt: "2026/10/05 08:00",
      offline: "yes",
      ghost: 1,
    }, { mode: "full" });
    expect(report.valid).toBe(false);
    const codes = report.violations.map((item) => item.code).sort();
    expect(codes).toEqual(["required-missing", "type-mismatch", "type-mismatch", "type-mismatch", "unknown-property", "enum-invalid"].sort());
    expect(report.violations.find((item) => item.code === "required-missing")?.path).toBe("code");
    expect(report.violations.find((item) => item.code === "enum-invalid")?.message).toContain("exploded");
    expect(report.violations.find((item) => item.code === "unknown-property")?.path).toBe("ghost");
  });

  it("单位格式细则：数值通过（单位由 schema 承载），字符串缺单位/单位不符判违规", () => {
    const pass = validateOntologyObjectValues(DEVICE, { code: "x", ratedPower: 42 }, { mode: "full" });
    expect(pass.violations.filter((item) => item.code === "unit-format-invalid")).toEqual([]);
    const missingUnit = validateOntologyObjectValues(DEVICE, { code: "x", ratedPower: "42" }, { mode: "full" });
    expect(missingUnit.violations.map((item) => item.code)).toContain("unit-format-invalid");
    const wrongUnit = validateOntologyObjectValues(DEVICE, { code: "x", ratedPower: "42 kPa" }, { mode: "full" });
    expect(wrongUnit.violations.filter((item) => item.code === "unit-format-invalid")).toHaveLength(1);
    const withUnit = validateOntologyObjectValues(DEVICE, { code: "x", ratedPower: "42 kW" }, { mode: "full" });
    expect(withUnit.violations).toEqual([]);
  });

  it("partial 口径（行动参数）：不查必填、不报合同外键，只校验同名属性键", () => {
    const report = validateOntologyObjectValues(DEVICE, {
      ratedPower: "42 kW",
      window: "24h",
    }, { mode: "partial" });
    expect(report.valid).toBe(true);
    expect(report.violations).toEqual([]);
    const bad = validateOntologyObjectValues(DEVICE, { status: "exploded" }, { mode: "partial" });
    expect(bad.violations.map((item) => item.code)).toEqual(["enum-invalid"]);
  });

  it("规则表是数据：裁剪后的表禁用对应检查并如实披露 disabledRules", () => {
    const trimmed = ONTOLOGY_CONSTRAINT_RULE_TABLE.map((rule) =>
      rule.id === "enum-invalid" || rule.id === "unknown-property" ? { ...rule, enabled: false } : rule);
    const report = validateOntologyObjectValues(DEVICE, { status: "exploded", ghost: 1 }, { mode: "full", rules: trimmed });
    expect(report.violations.map((item) => item.code)).toEqual(["required-missing"]);
    expect(report.disabledRules.sort()).toEqual(["enum-invalid", "unknown-property"]);
    expect(report.checkedRules).not.toContain("enum-invalid");
  });
});

// ---------------------------------------------------------------------------
// 服务接线：preview 随行违规清单；strict 写入前阻断；report 不阻断
// ---------------------------------------------------------------------------

const PROJECT = "project-semantica";
const NOW = () => new Date("2026-10-05T08:00:00.000Z");

function stringProperty(key: string, label: string, extra: Record<string, unknown> = {}) {
  return { key, label, type: "string" as const, confirmed: true, ...extra };
}

function relation(key: string, sourceObject: string, targetObject: string) {
  return {
    id: `rel-${key}`,
    key,
    label: key,
    sourceObject,
    targetObject,
    cardinality: "one-to-many" as const,
    direction: "directed" as const,
    properties: [],
    keyMapping: { sourceField: "code", targetField: "code" },
    source: { kind: "manual" as const, note: key },
    evidence: [{ source: "seed", sampleCount: 1, recordedAt: "2026-10-05T07:00:00.000Z" }],
    status: "draft" as const,
    version: 0,
  };
}

function buildPackage(id: string): OntologyPackage {
  const stamp = "2026-10-05T07:00:00.000Z";
  const device: OntologyObjectType = {
    id: "obj-device",
    key: "Device",
    label: "设备",
    domain: "industrial",
    primaryKeys: ["code"],
    properties: [
      stringProperty("code", "编码"),
      { key: "targetMode", label: "目标模式", type: "enum", confirmed: true, enumValues: ["run", "pause", "stop"] },
      { key: "duration", label: "持续时长", type: "number", confirmed: true, unit: "s" },
    ],
    sourceBindings: [{ kind: "manual" as const, sourceId: "manual", fieldMappings: [], note: "人工登记" }],
    aliases: [],
    identityMappings: [{ objectKey: "Device", canonicalId: "press-07", sources: [{ sourceKind: "manual" as const, sourceId: "seed", externalId: "press-07" }] }],
    status: "draft" as const,
    version: 0,
    owner: "tester",
  };
  return {
    schemaVersion: 1,
    id,
    name: `产线本体 ${id}`,
    domain: "industrial",
    version: 0,
    revision: 0,
    objects: [device],
    relations: [relation("device-link", "Device", "Device")],
    actions: [{
      id: "act-apply",
      key: "device.control.apply",
      label: "控制下发",
      boundObject: "Device",
      inputSchema: { type: "object", properties: { targetMode: { type: "string" }, duration: { type: "number" }, note: { type: "string" } }, required: [] },
      outputSchema: { type: "object", properties: {} },
      toolBinding: { kind: "capability" as const, id: "operations.control.apply", version: "1.2.0" },
      preconditions: [],
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
    }],
    events: [],
    metrics: [],
    identityMappings: [],
    goldenQuestions: [{ id: "gq-1", question: "约束校验可用", passed: true, passedAt: stamp }],
    policies: [{ id: "pol-apply", scope: ["device.control.apply"] }],
    evidence: [],
    impactReviewed: true,
    impactReviewedBy: "tester",
    status: "draft",
    owner: "tester",
    createdAt: stamp,
    updatedAt: stamp,
  };
}

const PUBLISH_CTX = { capabilities: [{ id: "operations.control.apply", version: "1.2.0", kind: "action" }], datasetSchemas: {} };

function fakeTools() {
  const execute = vi.fn(async (): Promise<AgentToolOutcome> => ({
    status: "completed",
    output: { applied: true },
    evidence: [],
    verificationEvidence: [],
  }));
  const tools: AgentToolGateway = {
    list: () => [{ id: "operations.control.apply", label: "控制下发", description: "受控写入", effect: "control", risk: "high", requiresApproval: false }],
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

interface Harness { service: OntologyActionService; ledger: ProvenanceLedgerStore; execute: ReturnType<typeof fakeTools>["execute"] }

async function buildHarness(options: { mode?: "report" | "strict" } = {}): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ontology-constraint-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const store = new OntologyPackageStore(dataDir);
  await store.init();
  await store.createPackage(PROJECT, buildPackage("pkg-line"), "tester");
  await store.transitionStatus(PROJECT, "pkg-line", "review", "tester");
  await store.publishPackage(PROJECT, "pkg-line", "tester", PUBLISH_CTX);
  const ledger = new ProvenanceLedgerStore(dataDir, { now: NOW });
  await ledger.init();
  const { tools, execute } = fakeTools();
  const service = createOntologyActionService({
    ontologyReader: () => new OntologyPackageStore(dataDir),
    ledger: () => ledger,
    tools,
    ...(options.mode ? { constraints: { mode: options.mode } } : {}),
    now: NOW,
  });
  return { service, ledger, execute };
}

const PLAN = (arguments_: Record<string, unknown>) => ({
  actionKey: "device.control.apply",
  target: { objectKey: "Device", canonicalId: "press-07" },
  arguments: arguments_,
});

type Approval = { approvedBy: string; approvedAt: string; scopeFingerprint: string };

/** 高风险行动走既有两段式审批：首调拿 awaiting-approval 的范围指纹，复审后执行。 */
async function executeApproved(service: OntologyActionService, args: Record<string, unknown>): Promise<Awaited<ReturnType<OntologyActionService["execute"]>>> {
  const pending = await service.execute(PROJECT, PLAN(args), { principal: "editor-1", role: "editor" });
  if (pending.status !== "awaiting-approval") return pending;
  return service.execute(PROJECT, PLAN(args), {
    principal: "editor-1",
    role: "editor",
    approval: { approvedBy: "chief", approvedAt: NOW().toISOString(), scopeFingerprint: pending.preview.approvalScopeFingerprint } satisfies Approval,
  });
}

describe("Semantica 刀3：本体行动路径接线", () => {
  it("违规参数：preview 随行违规清单且 executable 不受影响（report-only），execute 缺省照常执行并随行违规", async () => {
    const { service, ledger, execute } = await buildHarness();
    const preview = await service.preview(PROJECT, PLAN({ targetMode: "warp", duration: "30 min" }), { principal: "editor-1", role: "editor" });
    expect(preview.executable).toBe(true);
    expect(preview.constraintViolations.map((item) => item.code).sort()).toEqual(["enum-invalid", "unit-format-invalid"]);
    expect(preview.constraintViolations.find((item) => item.code === "enum-invalid")?.path).toBe("targetMode");

    const outcome = await executeApproved(service, { targetMode: "warp" });
    expect(outcome.status).toBe("executed");
    expect(outcome.constraintViolations?.map((item) => item.code)).toEqual(["enum-invalid"]);
    expect(execute).toHaveBeenCalledTimes(1);
    // report 模式：行动链照常成链（计划+执行+回执各一）。
    const trace = await ledger.traceActionChains(PROJECT, {});
    expect(trace.chains).toHaveLength(1);
    expect(trace.chains[0]?.receipts[0]?.status).toBe("executed");
  });

  it("strict 模式：违规参数写入前阻断（rejected + invalidArguments），零账本节点；合法参数照常执行", async () => {
    const { service, ledger, execute } = await buildHarness({ mode: "strict" });
    const rejected = await service.execute(PROJECT, PLAN({ targetMode: "warp" }), { principal: "editor-1", role: "editor" });
    expect(rejected.status).toBe("rejected");
    expect(rejected).toMatchObject({ code: "ontology-invalid-arguments" });
    expect(rejected.message).toContain("strict 模式阻断");
    expect(rejected.constraintViolations?.map((item) => item.code)).toEqual(["enum-invalid"]);
    expect(execute).not.toHaveBeenCalled();
    const trace = await ledger.traceActionChains(PROJECT, {});
    expect(trace.matched).toBe(false);
    expect(trace.chains).toEqual([]);

    const ok = await executeApproved(service, { targetMode: "pause", duration: 30 });
    expect(ok.status).toBe("executed");
    expect(ok.constraintViolations).toEqual([]);
  });

  it("preview 的约束报告恒 report-only：strict 策略下 preview 不改 executable（阻断语义只在 execute 写入前）", async () => {
    const { service } = await buildHarness({ mode: "strict" });
    const preview = await service.preview(PROJECT, PLAN({ targetMode: "warp" }), { principal: "editor-1", role: "editor" });
    expect(preview.executable).toBe(true);
    expect(preview.constraintViolations).toHaveLength(1);
  });
});
