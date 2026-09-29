import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aiHypothesisProposalFingerprint, validateAiHypothesisContract } from "@bim-studio/contracts";
import { OperationsService } from "../operations.js";
import { createIndustrialCapabilityHost, registerIndustrialCapabilityRoutes } from "../industrialCapabilities.js";
import { registerMcpCapabilityRoute } from "../mcpCapabilityAdapter.js";
import { createApiServer } from "../serverOptions.js";
import { ProvenanceLedgerStore } from "./provenanceLedger.js";
import { registerProvenanceRoutes } from "./provenanceRoutes.js";
import { IndustrialAgentToolGateway } from "./industrialAgentToolGateway.js";
import type { PluginRegistry } from "@bim-studio/plugin-runtime";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

const POSITIVE_HYPOTHESIS = {
  hypothesisVersion: "1",
  id: "hyp-archive-mcp",
  statement: "校准场景中传感器单元利用率低于 0.3",
  targetModel: "t23-conveyor-sensor-agv",
  prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "less-than", expected: 0.3 },
  tolerance: { absolute: 0.05 },
};

async function buildHost() {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-provenance-mcp-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const operations = new OperationsService(directory);
  await operations.init();
  const ledger = new ProvenanceLedgerStore(directory);
  await ledger.init();
  const host = await createIndustrialCapabilityHost(operations, { provenanceLedger: ledger });
  const app = createApiServer();
  cleanups.push(() => app.close());
  const store = { getProject: (projectId: string) => projectId === "project-1" ? ({ id: "project-1" } as never) : undefined };
  await registerIndustrialCapabilityRoutes(app, { store: store as never, host });
  await registerMcpCapabilityRoute(app, { host, store: store as never });
  await registerProvenanceRoutes(app, { store: store as never, ledger });
  return { app, host, ledger, registry: host.registry };
}

async function verifyOverMcp(app: ReturnType<typeof createApiServer>, id: number) {
  const response = await app.inject({
    method: "POST",
    url: "/api/mcp",
    payload: {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "industrial.simulation.golden.verify", arguments: { projectId: "project-1", input: { hypothesis: POSITIVE_HYPOTHESIS } } },
    },
  });
  expect(response.statusCode).toBe(200);
  return (response.json().result.structuredContent as { output: { resultFingerprint: string; proposalFingerprint: string; verdict: string } }).output;
}

/** H-C3 验收：MCP 面上 落账→三跳查询 闭环 + 未命中如实 + 路由权限。 */
describe("provenance.trace（实验档案室）", () => {
  it("tools/list 暴露 provenance.trace；golden.verify 落账后按 resultFingerprint 三跳成链", async () => {
    const { app } = await buildHost();
    const listed = await app.inject({ method: "POST", url: "/api/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const toolNames = (listed.json().result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(toolNames).toContain("industrial.provenance.trace");
    const traceTool = (listed.json().result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>)
      .find((tool) => tool.name === "industrial.provenance.trace");
    expect(traceTool?.annotations?.readOnlyHint).toBe(true);

    const envelope = await verifyOverMcp(app, 2);
    expect(envelope.verdict).toBe("confirmed");
    const traced = await app.inject({
      method: "POST",
      url: "/api/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "industrial.provenance.trace",
          arguments: { projectId: "project-1", input: { query: { resultFingerprint: envelope.resultFingerprint } } },
        },
      },
    });
    expect(traced.statusCode).toBe(200);
    const trace = (traced.json().result.structuredContent as { output?: { matched: boolean; chains: Array<{ runs: unknown[]; verdicts: Array<{ verdict: string }>; integrity: string }> } }).output;
    expect(trace?.matched).toBe(true);
    expect(trace?.chains).toHaveLength(1);
    expect(trace?.chains[0].runs).toHaveLength(1);
    expect(trace?.chains[0].verdicts.map((node) => node.verdict)).toEqual(["confirmed"]);
    expect(trace?.chains[0].integrity).toBe("intact");
  });

  it("MCP 直调 golden.verify（未经 agent 网关）同样落账：登记→验证→提案指纹查链", async () => {
    const { app, ledger } = await buildHost();
    const envelope = await verifyOverMcp(app, 10);
    const direct = await ledger.trace("project-1", { proposalFingerprint: envelope.proposalFingerprint });
    expect(direct.matched).toBe(true);
    expect(direct.chains[0].hypothesis.hypothesisId).toBe("hyp-archive-mcp");
  });

  it("无记录如实未命中：未知指纹 matched=false 且零链（不伪造）", async () => {
    const { app } = await buildHost();
    const traced = await app.inject({
      method: "POST",
      url: "/api/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "industrial.provenance.trace", arguments: { projectId: "project-1", input: { query: { resultFingerprint: "deadbeefdeadbeef" } } } },
      },
    });
    expect(traced.statusCode).toBe(200);
    const output = (traced.json().result.structuredContent as { output?: { matched: boolean; chains: unknown[] } }).output;
    expect(output?.matched).toBe(false);
    expect(output?.chains).toEqual([]);
  });

  it("HTTP 路由：列表 + trace 可查；浏览者可读；项目不存在 404；非法 limit 400", async () => {
    const { app, ledger } = await buildHost();
    // 路由权限测试只关心读面：直接落账造链，避免 MCP 写路径受 viewer 角色影响。
    const validated = validateAiHypothesisContract(POSITIVE_HYPOTHESIS);
    await ledger.recordVerification("project-1", {
      envelope: {
        proposalFingerprint: aiHypothesisProposalFingerprint(validated),
        inputFingerprint: "123456789abcdef0",
        resultFingerprint: "23456789abcdef01",
        verdict: "confirmed",
        tolerance: { absolute: 0.05 },
        reasonCode: "prediction-within-tolerance",
        rationale: "实测低于阈值且越过容差带。",
        engineId: "plant-lite-des",
        generatedAt: "2026-09-28T10:00:00.000Z",
        evidence: [],
      },
      contract: validated,
    });
    app.addHook("preHandler", async (request) => { request.systemUser = { id: "viewer-1", role: "viewer" } as never; });

    const list = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/provenance" });
    expect(list.statusCode).toBe(200);
    const listed = list.json() as { chains: Array<{ runCount: number; latest?: { verdict: string } }>; integrity: { intact: boolean } };
    expect(listed.chains).toHaveLength(1);
    expect(listed.chains[0].runCount).toBe(1);
    expect(listed.chains[0].latest?.verdict).toBe("confirmed");
    expect(listed.integrity.intact).toBe(true);

    const trace = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/provenance/trace?resultFingerprint=23456789abcdef01" });
    expect(trace.statusCode).toBe(200);
    expect((trace.json() as { matched: boolean }).matched).toBe(true);

    const badLimit = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/provenance?limit=0" });
    expect(badLimit.statusCode).toBe(400);
    const missing = await app.inject({ method: "GET", url: "/api/projects/project-2/ai/provenance" });
    expect(missing.statusCode).toBe(404);
  });

  it("工业网关路由权限：provenance.trace 为 read/low/免审批，计划模式放行", async () => {
    const { registry } = await buildHost();
    const gateway = new IndustrialAgentToolGateway(registry as PluginRegistry);
    const definition = gateway.list().find((tool) => tool.id === "provenance.trace");
    expect(definition).toBeDefined();
    expect(definition?.effect).toBe("read");
    expect(definition?.risk).toBe("low");
    expect(definition?.requiresApproval).toBe(false);
  });
});
