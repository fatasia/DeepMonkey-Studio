import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aiHypothesisProposalFingerprint,
  buildOntologyActionExecutionNode,
  buildOntologyActionPlanNode,
  buildOntologyActionReceiptNode,
  type AiHypothesisContract,
  type AiVerificationEnvelope,
} from "@bim-studio/contracts";
import { createApiServer } from "../serverOptions.js";
import { ProvenanceLedgerStore } from "./provenanceLedger.js";
import { registerProvenanceRoutes } from "./provenanceRoutes.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function createStore(): Promise<ProvenanceLedgerStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-decision-chain-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new ProvenanceLedgerStore(directory);
  await store.init();
  return store;
}

const HYPOTHESIS_A: AiHypothesisContract = {
  hypothesisVersion: "1",
  id: "hyp-chain-a",
  statement: "传感器单元利用率低于 0.3",
  targetModel: "t23-conveyor-sensor-agv",
  prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "less-than", expected: 0.3 },
  tolerance: { absolute: 0.05 },
};
const HYPOTHESIS_B: AiHypothesisContract = {
  ...HYPOTHESIS_A,
  id: "hyp-chain-b",
  statement: "同一理由码的另一提案（先例检索对照组）",
};

function proposalOf(contract: AiHypothesisContract): string {
  return aiHypothesisProposalFingerprint(contract);
}

function envelopeOf(contract: AiHypothesisContract, overrides: Partial<AiVerificationEnvelope> = {}): AiVerificationEnvelope {
  return {
    proposalFingerprint: proposalOf(contract),
    inputFingerprint: "123456789abcdef0",
    resultFingerprint: "23456789abcdef01",
    verdict: "confirmed",
    tolerance: { absolute: 0.05 },
    reasonCode: "prediction-within-tolerance",
    rationale: "实测越过容差带，golden 基准对照一致。",
    engineId: "plant-lite-des",
    goldenMatch: true,
    generatedAt: "2026-10-05T08:00:00.000Z",
    evidence: [],
    ...overrides,
  };
}

const ACTION_BASE = {
  packageId: "pkg-line",
  packageVersion: 0,
  actionKey: "device.control.apply",
  actionVersion: 0,
  boundObject: "Device",
  canonicalId: "press-07",
  riskLevel: "high" as const,
  effect: "external-write" as const,
  approvalRequired: true,
  idempotencyKey: "aaaaaaaaaaaaaaaa",
};

describe("Semantica 刀1：决策链查询面（traceDecisionChain）", () => {
  it("从判定节点回放完整仿真链：假设→运行→判定→报告全部聚合，边齐全", async () => {
    const store = await createStore();
    const fp = proposalOf(HYPOTHESIS_A);
    await store.recordVerification("project-1", { envelope: envelopeOf(HYPOTHESIS_A), contract: HYPOTHESIS_A, seed: "seed-a" });
    await store.recordReport("project-1", {
      evidenceFingerprint: "cccccccccccccccc",
      label: "Study 证据报告",
      proposalFingerprint: fp,
      resultFingerprint: "23456789abcdef01",
    });

    const trace = await store.traceDecisionChain("project-1", `verdict:23456789abcdef01`);
    expect(trace.anchor).toEqual({ nodeId: "verdict:23456789abcdef01", found: true, kind: "verdict" });
    expect(trace.chainType).toBe("verification");
    expect(trace.nodes.map((node) => node.kind)).toEqual(["hypothesis", "kernel-run", "verdict", "report"]);
    expect(trace.edges.map((edge) => edge.relation)).toEqual(["executed", "judged", "reported"]);
    expect(trace.gaps).toEqual([]);
  });

  it("从运行/报告/假设节点回放同样成链（任一节点皆可作为入口）", async () => {
    const store = await createStore();
    const fp = proposalOf(HYPOTHESIS_A);
    await store.recordVerification("project-1", { envelope: envelopeOf(HYPOTHESIS_A), contract: HYPOTHESIS_A });
    await store.recordReport("project-1", { evidenceFingerprint: "dddddddddddddddd", label: "报告B", proposalFingerprint: fp, resultFingerprint: "23456789abcdef01" });

    for (const entryNodeId of [fp, "23456789abcdef01", "report:dddddddddddddddd"]) {
      const trace = await store.traceDecisionChain("project-1", entryNodeId);
      expect(trace.anchor.found).toBe(true);
      expect(trace.nodes.map((node) => node.kind)).toEqual(["hypothesis", "kernel-run", "verdict", "report"]);
      expect(trace.gaps).toEqual([]);
    }
  });

  it("断链容错：运行无判定如实标注 verdict-missing，判定无运行标注 run-missing，不伪造连续链", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-decision-gap-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const fp = proposalOf(HYPOTHESIS_A);
    // 手写账本构造断链形态：运行 3456… 无判定、判定 verdict:4567… 无运行（fail-closed 加载器照常收档）。
    const ledgerPath = path.join(directory, "provenance-ledger", "project-1", "ledger.json");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, JSON.stringify({
      schemaVersion: 1,
      hypotheses: [{ kind: "hypothesis", nodeId: fp, proposalFingerprint: fp, hypothesisId: "hyp-chain-a", targetModel: "t23", metricLocator: "m", statementDigest: "s", registeredAt: "2026-10-05T07:00:00.000Z" }],
      runs: [{ kind: "kernel-run", nodeId: "3456789abcdef012", proposalFingerprint: fp, inputFingerprint: "123456789abcdef0", resultFingerprint: "3456789abcdef012", executedAt: "2026-10-05T08:00:00.000Z" }],
      verdicts: [{ kind: "verdict", nodeId: "verdict:456789abcdef0123", proposalFingerprint: fp, resultFingerprint: "456789abcdef0123", verdict: "refuted", reasonCode: "prediction-outside-tolerance", tolerance: { absolute: 0.05 }, rationaleDigest: "r", integrityFingerprint: "x", judgedAt: "2026-10-05T08:30:00.000Z" }],
      reports: [], studyRuns: [], actions: [],
    }), "utf8");
    const store = new ProvenanceLedgerStore(directory);
    await store.init();

    const trace = await store.traceDecisionChain("project-1", fp);
    expect(trace.anchor).toEqual({ nodeId: fp, found: true, kind: "hypothesis" });
    expect(trace.gaps.map((gap) => gap.code).sort()).toEqual(["run-missing", "verdict-missing"]);
    expect(trace.gaps.find((gap) => gap.code === "verdict-missing")?.afterNodeId).toBe("3456789abcdef012");
    expect(trace.gaps.find((gap) => gap.code === "run-missing")?.afterNodeId).toBe("verdict:456789abcdef0123");
  });

  it("长跑进行中记录如实附尾并标注 run-pending（未收口不是已完成链）", async () => {
    const store = await createStore();
    await store.recordStudyLaunched("project-1", {
      contract: HYPOTHESIS_A,
      proposalFingerprint: proposalOf(HYPOTHESIS_A),
      inputFingerprint: "123456789abcdef0",
      taskId: "study-123456789abcdef0",
      totalRepeats: 8,
      startedAt: "2026-10-05T08:00:00.000Z",
    });
    const trace = await store.traceDecisionChain("project-1", "study-123456789abcdef0");
    expect(trace.anchor).toEqual({ nodeId: "study-123456789abcdef0", found: true, kind: "study-run" });
    expect(trace.nodes.map((node) => node.kind)).toEqual(["hypothesis", "study-run"]);
    expect(trace.gaps.map((gap) => gap.code)).toEqual(["run-pending"]);
  });

  it("行动链回放：计划→执行→回执成链；执行后无回执如实标注 execution-receipt-missing", async () => {
    const store = await createStore();
    const stamp = "2026-10-05T09:00:00.000Z";
    const plan = buildOntologyActionPlanNode({ ...ACTION_BASE, planFingerprint: "aabbccdd00112233", digest: "下发控制指令", plannedAt: stamp });
    await store.recordActionPlan("project-1", plan);
    const executed = buildOntologyActionExecutionNode({
      planFingerprint: plan.planFingerprint,
      inputFingerprint: "1111111111111111",
      toolId: "operations.control.apply",
      executedAt: stamp,
    });
    await store.recordActionExecution("project-1", executed);

    const pending = await store.traceDecisionChain("project-1", plan.nodeId);
    expect(pending.chainType).toBe("action");
    expect(pending.nodes.map((node) => node.kind)).toEqual(["action-plan", "action-execution"]);
    expect(pending.gaps.map((gap) => gap.code)).toEqual(["execution-receipt-missing"]);

    const receipt = buildOntologyActionReceiptNode({
      planFingerprint: plan.planFingerprint,
      inputFingerprint: "1111111111111111",
      receiptFingerprint: "2222222222222222",
      idempotencyKey: ACTION_BASE.idempotencyKey,
      status: "executed",
      digest: "回执摘要",
      evidenceFingerprints: [],
      receiptedAt: stamp,
    });
    await store.recordActionReceipt("project-1", receipt);
    const complete = await store.traceDecisionChain("project-1", `action-receipt:2222222222222222`);
    expect(complete.nodes.map((node) => node.kind)).toEqual(["action-plan", "action-execution", "action-receipt"]);
    expect(complete.gaps).toEqual([]);
  });

  it("未命中如实 found=false；非法 nodeId 显式报错", async () => {
    const store = await createStore();
    const trace = await store.traceDecisionChain("project-1", "ffffffffffffffff");
    expect(trace.anchor).toEqual({ nodeId: "ffffffffffffffff", found: false });
    expect(trace.chainType).toBe("none");
    expect(trace.nodes).toEqual([]);
    await expect(store.traceDecisionChain("project-1", "  ")).rejects.toThrow(/nodeId/);
  });
});

describe("Semantica 刀1：先例检索（findSimilarDecisions）", () => {
  it("同 proposalFingerprint 与同理由码都能召回先例，时间倒序，limit 生效", async () => {
    const store = await createStore();
    const fpA = proposalOf(HYPOTHESIS_A);
    const fpB = proposalOf(HYPOTHESIS_B);
    // 先旧后新落两条同理由码判定（不同提案）。
    await store.recordVerification("project-1", {
      envelope: envelopeOf(HYPOTHESIS_A, { generatedAt: "2026-10-05T08:00:00.000Z", resultFingerprint: "23456789abcdef01" }),
      contract: HYPOTHESIS_A,
    });
    await store.recordVerification("project-1", {
      envelope: envelopeOf(HYPOTHESIS_B, { generatedAt: "2026-10-05T09:00:00.000Z", resultFingerprint: "3456789abcdef012" }),
      contract: HYPOTHESIS_B,
    });

    const byFingerprint = await store.findSimilarDecisions("project-1", { fingerprint: fpA });
    expect(byFingerprint.matched).toBe(true);
    expect(byFingerprint.hits).toHaveLength(1);
    expect(byFingerprint.hits[0]).toMatchObject({ matchedBy: "proposal-fingerprint", proposalFingerprint: fpA, verdict: "confirmed" });

    const byReasonCode = await store.findSimilarDecisions("project-1", { reasonCode: "prediction-within-tolerance" });
    expect(byReasonCode.hits.map((hit) => hit.verdictNodeId)).toEqual(["verdict:3456789abcdef012", "verdict:23456789abcdef01"]);
    expect(byReasonCode.hits[0]).toMatchObject({ matchedBy: "reason-code", proposalFingerprint: fpB });

    const limited = await store.findSimilarDecisions("project-1", { reasonCode: "prediction-within-tolerance" }, 1);
    expect(limited.query.limit).toBe(1);
    expect(limited.hits).toHaveLength(1);
  });

  it("零命中如实 matched=false；缺参显式报错；非法指纹显式报错", async () => {
    const store = await createStore();
    const empty = await store.findSimilarDecisions("project-1", { reasonCode: "no-such-reason" });
    expect(empty.matched).toBe(false);
    expect(empty.hits).toEqual([]);
    await expect(store.findSimilarDecisions("project-1", {})).rejects.toThrow(/fingerprint 或 reasonCode/);
    await expect(store.findSimilarDecisions("project-1", { fingerprint: "NOT-A-FP" })).rejects.toThrow(/16 位/);
  });
});

describe("Semantica 刀1：影响面反查（analyzeDecisionImpact）", () => {
  it("运行节点的指纹反查到下游判定与报告，同假设重跑也计入影响面", async () => {
    const store = await createStore();
    const fp = proposalOf(HYPOTHESIS_A);
    await store.recordVerification("project-1", { envelope: envelopeOf(HYPOTHESIS_A, { resultFingerprint: "23456789abcdef01" }), contract: HYPOTHESIS_A });
    await store.recordVerification("project-1", { envelope: envelopeOf(HYPOTHESIS_A, { resultFingerprint: "3456789abcdef012" }), contract: HYPOTHESIS_A });
    await store.recordReport("project-1", { evidenceFingerprint: "eeeeeeeeeeeeeeee", label: "证据报告", proposalFingerprint: fp, resultFingerprint: "23456789abcdef01" });

    const impact = await store.analyzeDecisionImpact("project-1", "23456789abcdef01");
    expect(impact.anchor).toEqual({ nodeId: "23456789abcdef01", found: true, kind: "kernel-run" });
    expect(impact.fingerprints).toContain(fp);
    expect(impact.downstream.verdicts.map((verdict) => verdict.nodeId).sort()).toEqual([
      "verdict:23456789abcdef01", "verdict:3456789abcdef012",
    ]);
    expect(impact.downstream.reports.map((report) => report.nodeId)).toEqual(["report:eeeeeeeeeeeeeeee"]);
  });

  it("判定节点作锚不把自身计入下游；未命中如实 found=false", async () => {
    const store = await createStore();
    await store.recordVerification("project-1", { envelope: envelopeOf(HYPOTHESIS_A), contract: HYPOTHESIS_A });
    const impact = await store.analyzeDecisionImpact("project-1", "verdict:23456789abcdef01");
    expect(impact.anchor.found).toBe(true);
    expect(impact.downstream.verdicts).toEqual([]);

    const missing = await store.analyzeDecisionImpact("project-1", "ffffffffffffffff");
    expect(missing).toEqual({ anchor: { nodeId: "ffffffffffffffff", found: false }, fingerprints: [], downstream: { verdicts: [], reports: [] } });
  });
});

describe("Semantica 刀1：只读查询端点（provenanceRoutes）", () => {
  async function routesApp() {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-decision-routes-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const ledger = new ProvenanceLedgerStore(directory);
    await ledger.init();
    const app = createApiServer();
    cleanups.push(() => app.close());
    app.addHook("preHandler", async (request) => { request.systemUser = { id: "viewer-1", role: "viewer" } as never; });
    await registerProvenanceRoutes(app, {
      store: { getProject: (projectId: string) => projectId === "project-1" ? ({ id: "project-1" } as never) : undefined },
      ledger,
    });
    await ledger.recordVerification("project-1", { envelope: envelopeOf(HYPOTHESIS_A), contract: HYPOTHESIS_A });
    return { ledger, app };
  }

  it("decision-chain / similar-decisions / decision-impact 三端点只读可用，信封一致", async () => {
    const { app } = await routesApp();
    const chain = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/provenance/decision-chain/verdict:23456789abcdef01" });
    expect(chain.statusCode).toBe(200);
    expect(chain.json()).toMatchObject({ anchor: { nodeId: "verdict:23456789abcdef01", found: true, kind: "verdict" }, chainType: "verification" });

    const similar = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/provenance/similar-decisions?reasonCode=prediction-within-tolerance" });
    expect(similar.statusCode).toBe(200);
    expect(similar.json()).toMatchObject({ matched: true });

    const impact = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/provenance/decision-impact/23456789abcdef01" });
    expect(impact.statusCode).toBe(200);
    expect(impact.json()).toMatchObject({ anchor: { found: true, kind: "kernel-run" } });
  });

  it("缺参与项目不存在按既有信封回 400/404", async () => {
    const { app } = await routesApp();
    const missingQuery = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/provenance/similar-decisions" });
    expect(missingQuery.statusCode).toBe(400);
    const missingProject = await app.inject({ method: "GET", url: "/api/projects/project-2/ai/provenance/decision-chain/ffffffffffffffff" });
    expect(missingProject.statusCode).toBe(404);
    const notFound = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/provenance/decision-chain/ffffffffffffffff" });
    expect(notFound.statusCode).toBe(200);
    expect(notFound.json()).toMatchObject({ anchor: { found: false } });
  });
});
