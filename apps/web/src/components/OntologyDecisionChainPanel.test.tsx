import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OntologyPackage } from "@bim-studio/contracts";
import { planActionFingerprint } from "@bim-studio/contracts";
import type { DecisionChainTrace, SimilarDecisionsResult } from "../apiClients/provenanceApi";
import OntologyDecisionChainPanel, {
  computeDecisionChainProbes,
  DecisionChainGaps,
  DecisionChainTimeline,
  SimilarDecisionsView,
} from "./OntologyDecisionChainPanel";

function fixturePackage(): OntologyPackage {
  return {
    schemaVersion: 1,
    id: "pkg-1",
    name: "产线设备本体",
    domain: "manufacturing",
    version: 2,
    revision: 1,
    objects: [{ id: "o1", key: "Device", label: "设备", domain: "manufacturing", primaryKeys: ["device_id"], properties: [], sourceBindings: [], aliases: [], identityMappings: [], status: "published", version: 2, owner: "alice" }],
    relations: [],
    actions: [
      {
        id: "a1", key: "diagnose_device", label: "设备诊断", boundObject: "Device",
        inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: {} },
        toolBinding: { kind: "api", id: "data.query.read", version: "1.0.0" },
        preconditions: [], effect: "read", riskLevel: "low",
        approvalRequired: false, idempotencyRequired: false,
        impactScope: ["Device"], authorizedScopes: ["project:read"],
        evidenceRequired: true, status: "published", version: 2,
      },
      {
        id: "a2", key: "other_object_action", label: "别的对象行动", boundObject: "Sensor",
        inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: {} },
        toolBinding: { kind: "api", id: "x", version: "1.0.0" },
        preconditions: [], effect: "read", riskLevel: "low",
        approvalRequired: false, idempotencyRequired: false,
        impactScope: ["Sensor"], authorizedScopes: ["project:read"],
        evidenceRequired: true, status: "published", version: 1,
      },
    ],
    events: [], metrics: [], identityMappings: [], goldenQuestions: [], policies: [], evidence: [],
    impactReviewed: true, status: "published", owner: "alice",
    createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z",
  };
}

describe("computeDecisionChainProbes(指纹口径与执行侧一致)", () => {
  it("按包版本+行动版本+canonicalId+空参数重算计划指纹;只取绑定对象的行动", () => {
    const pkg = fixturePackage();
    const probes = computeDecisionChainProbes(pkg, "Device");
    expect(probes).toHaveLength(1);
    expect(probes[0]!.actionKey).toBe("diagnose_device");
    expect(probes[0]!.nodeId).toBe(planActionFingerprint({
      packageId: "pkg-1",
      packageVersion: 2,
      actionKey: "diagnose_device",
      actionVersion: 2,
      boundObject: "Device",
      canonicalId: "ontology:pkg-1:Device",
      arguments: {},
    }));
    // 指定 actionKey 时只探测该行动(行动卡自查)
    expect(computeDecisionChainProbes(pkg, "Device", "diagnose_device")).toHaveLength(1);
    expect(computeDecisionChainProbes(pkg, "Device", "nope")).toHaveLength(0);
    expect(computeDecisionChainProbes(pkg, "Sensor")).toHaveLength(1);
  });
});

function hitTrace(): DecisionChainTrace {
  return {
    anchor: { nodeId: "fp01", found: true, kind: "action-plan" },
    chainType: "action",
    nodes: [
      { kind: "action-plan", node: { kind: "action-plan", nodeId: "fp01", planFingerprint: "fp01", packageId: "pkg-1", packageVersion: 2, actionKey: "diagnose_device", actionVersion: 2, boundObject: "Device", canonicalId: "ontology:pkg-1:Device", riskLevel: "low", effect: "read", approvalRequired: false, idempotencyKey: "idem01", digest: "对 Device 执行 diagnose_device(read/low)", plannedAt: "2026-10-05T01:00:00.000Z" } },
      { kind: "action-execution", node: { kind: "action-execution", nodeId: "action-exec:fp02", planFingerprint: "fp01", inputFingerprint: "fp02", toolId: "data.query.read", executedAt: "2026-10-05T01:01:00.000Z" } },
      { kind: "action-receipt", node: { kind: "action-receipt", nodeId: "action-receipt:fp03", planFingerprint: "fp01", inputFingerprint: "fp02", receiptFingerprint: "fp03", idempotencyKey: "idem01", status: "blocked", reasonCode: "ontology-scope-exceeded", digest: "工具网关阻断", evidenceFingerprints: [], receiptedAt: "2026-10-05T01:02:00.000Z", integrityFingerprint: "x" } },
    ],
    edges: [
      { from: "fp01", to: "action-exec:fp02", relation: "plan-executed" },
      { from: "fp01", to: "action-receipt:fp03", relation: "plan-receipted" },
    ],
    gaps: [{ afterNodeId: "action-exec:fp02", code: "execution-receipt-missing", detail: "执行 尚无对应回执(如中断)" }],
  };
}

describe("决策链面板(SSR 静态渲染)", () => {
  it("折叠态:入口可见、默认收起,不发起渲染期请求痕迹", () => {
    const html = renderToStaticMarkup(<OntologyDecisionChainPanel projectId="p1" pkg={fixturePackage()} objectKey="Device" locale="zh-CN" />);
    expect(html).toContain("AI 决策链");
    expect(html).toContain("账本回放 · 先例 · 影响面");
    expect(html).not.toContain("odc-probe");
  });

  it("链回放时间线:节点种类/回执语义色/golden 漂移提示/时间齐备;断链 gaps 逐条警示", () => {
    const html = renderToStaticMarkup(<DecisionChainTimeline trace={hitTrace()} locale="zh-CN" />);
    expect(html).toContain("行动计划");
    expect(html).toContain("工具执行");
    expect(html).toContain("行动回执");
    expect(html).toContain("data.query.read");
    expect(html).toContain("ontology-scope-exceeded");
    expect(html).toContain("is-warn"); // blocked 回执走警示色
    expect(html).not.toMatch(/T01:0/); // 拒绝 ISO 原文,必须是本地化时间
    expect(html).not.toContain("…");
    const gaps = renderToStaticMarkup(<DecisionChainGaps trace={hitTrace()} locale="zh-CN" />);
    expect(gaps).toContain("execution-receipt-missing");
    expect(gaps).toContain("如中断");
  });

  it("先例检索:空命中如实呈现,不伪造先例", () => {
    const empty: SimilarDecisionsResult = { query: { reasonCode: "prediction-outside-tolerance", limit: 10 }, matched: false, hits: [] };
    const html = renderToStaticMarkup(<SimilarDecisionsView result={empty} locale="zh-CN" />);
    expect(html).toContain("如实为空");
  });
});
