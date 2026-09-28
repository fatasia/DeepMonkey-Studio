import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationsService } from "../operations.js";
import { createIndustrialCapabilityHost, registerIndustrialCapabilityRoutes } from "../industrialCapabilities.js";
import { registerMcpCapabilityRoute } from "../mcpCapabilityAdapter.js";
import { createApiServer } from "../serverOptions.js";
import { ProvenanceLedgerStore } from "./provenanceLedger.js";
import { registerProvenanceRoutes } from "./provenanceRoutes.js";
import { IndustrialAgentToolGateway } from "./industrialAgentToolGateway.js";
import { createGoldenVerifyProvider } from "./simulationHypothesisPlugin.js";
import { SimulationStudyTaskStore } from "./simulationStudyTasks.js";
import type { PluginRegistry } from "@bim-studio/plugin-runtime";
import type { FastifyInstance } from "fastify";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

const POSITIVE_HYPOTHESIS = {
  hypothesisVersion: "1",
  id: "hyp-study-mcp",
  statement: "校准场景中传感器单元利用率低于 0.3",
  targetModel: "t23-conveyor-sensor-agv",
  prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "less-than", expected: 0.3 },
  tolerance: { absolute: 0.05 },
};

interface HostBundle {
  app: FastifyInstance;
  ledger: ProvenanceLedgerStore;
  tasks: SimulationStudyTaskStore;
  registry: PluginRegistry;
}

async function buildHost(stepDelayMs: number): Promise<HostBundle> {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-study-mcp-"));
  const operations = new OperationsService(directory);
  await operations.init();
  const ledger = new ProvenanceLedgerStore(directory);
  await ledger.init();
  const tasks = new SimulationStudyTaskStore(directory, {
    ledger,
    // 任务内部 provider 不带账本：完成收口由 recordStudySettled 一次性幂等落账（与生产装配同口径）。
    goldenProvider: createGoldenVerifyProvider(),
    stepDelayMs,
  });
  await tasks.init();
  const host = await createIndustrialCapabilityHost(operations, { provenanceLedger: ledger, studyTasks: tasks });
  const app = createApiServer();
  cleanups.push(async () => {
    tasks.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = { getProject: (projectId: string) => projectId === "project-1" ? ({ id: "project-1" } as never) : undefined };
  await registerIndustrialCapabilityRoutes(app, { store: store as never, host });
  await registerMcpCapabilityRoute(app, { host, store: store as never });
  await registerProvenanceRoutes(app, { store: store as never, ledger });
  return { app, ledger, tasks, registry: host.registry };
}

interface McpToolResult {
  isError?: boolean;
  structuredContent?: {
    status: string;
    warnings?: string[];
    output?: Record<string, unknown> & {
      taskId?: string;
      status?: string;
      resultFingerprint?: string;
      proposalFingerprint?: string;
      envelope?: { verdict: string; resultFingerprint: string; proposalFingerprint: string };
      progress?: { completedRepeats: number; totalRepeats: number };
      partial?: boolean;
      settleReason?: string;
    };
  };
}

async function callTool(app: FastifyInstance, id: number, name: string, input: unknown): Promise<McpToolResult> {
  const response = await app.inject({
    method: "POST",
    url: "/api/mcp",
    payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { projectId: "project-1", input } } },
  });
  expect(response.statusCode).toBe(200);
  return response.json().result as McpToolResult;
}

async function waitForStatus(
  app: FastifyInstance,
  taskId: string,
  predicate: (output: NonNullable<NonNullable<McpToolResult["structuredContent"]>["output"]>) => boolean,
  timeoutMs = 15_000,
): Promise<NonNullable<NonNullable<McpToolResult["structuredContent"]>["output"]>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await callTool(app, taskId.length, "industrial.simulation.study.status", { taskId });
    const output = result.structuredContent?.output;
    if (output && predicate(output)) return output;
    if (Date.now() > deadline) throw new Error(`轮询超时：${JSON.stringify(output)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** H-C3 后续切片 MCP 验收：任务面暴露、发起→轮询→收口、mid-flight 取消、恢复不变量跨路径同指纹。 */
describe("simulation.study 异步长跑任务面（MCP）", () => {
  it("tools/list 暴露三工具：status 只读提示（read/low），run-async/cancel 非只读（simulate/medium）", async () => {
    const { app, registry } = await buildHost(0);
    const listed = await app.inject({ method: "POST", url: "/api/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const tools = (listed.json().result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("industrial.simulation.study.run-async")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("industrial.simulation.study.status")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("industrial.simulation.study.cancel")?.annotations?.readOnlyHint).toBe(false);

    const gateway = new IndustrialAgentToolGateway(registry as PluginRegistry);
    const runAsync = gateway.list().find((tool) => tool.id === "simulation.study.run-async");
    const status = gateway.list().find((tool) => tool.id === "simulation.study.status");
    const cancel = gateway.list().find((tool) => tool.id === "simulation.study.cancel");
    expect(runAsync).toMatchObject({ effect: "simulate", risk: "medium", requiresApproval: false });
    expect(status).toMatchObject({ effect: "read", risk: "low", requiresApproval: false });
    expect(cancel).toMatchObject({ effect: "simulate", risk: "medium", requiresApproval: false });
  }, 20_000);

  it("同步 golden.verify 与异步 run-async 同指纹：幂等续写，三跳链仍恰一次运行一个判定", async () => {
    const { app, ledger } = await buildHost(0);
    const syncResult = await callTool(app, 1, "industrial.simulation.golden.verify", { hypothesis: POSITIVE_HYPOTHESIS });
    const syncEnvelope = syncResult.structuredContent?.output as { resultFingerprint: string; verdict: string } | undefined;
    expect(syncEnvelope?.verdict).toBe("confirmed");

    const launched = await callTool(app, 2, "industrial.simulation.study.run-async", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 1 } });
    const handle = launched.structuredContent?.output;
    expect(handle?.status).toBe("running");
    expect(handle?.taskId).toMatch(/^study-[0-9a-f]{16}$/);
    expect(handle?.inputFingerprint).toMatch(/^[0-9a-f]{16}$/);

    const completed = await waitForStatus(app, handle!.taskId!, (output) => output.status === "completed");
    expect(completed.envelope?.verdict).toBe("confirmed");
    expect(completed.resultFingerprint).toBe(syncEnvelope?.resultFingerprint);
    expect(completed.envelope?.resultFingerprint).toBe(syncEnvelope?.resultFingerprint);

    const traced = await callTool(app, 3, "industrial.provenance.trace", { query: { resultFingerprint: completed.resultFingerprint } });
    const trace = traced.structuredContent?.output as { matched: boolean; chains: Array<{ runs: unknown[]; verdicts: unknown[]; integrity: string }> } | undefined;
    expect(trace?.matched).toBe(true);
    expect(trace?.chains).toHaveLength(1);
    expect(trace?.chains[0].runs).toHaveLength(1);
    expect(trace?.chains[0].verdicts).toHaveLength(1);
    expect(trace?.chains[0].integrity).toBe("intact");
    expect(await ledger.listStudyRuns("project-1")).toEqual([]);
  }, 30_000);

  it("mid-flight 取消：状态机 running→cancelled，partial 如实标注，账本保留取消态且不伪造判定", async () => {
    const { app, ledger } = await buildHost(12);
    const launched = await callTool(app, 1, "industrial.simulation.study.run-async", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 500 } });
    const taskId = launched.structuredContent?.output?.taskId!;
    await waitForStatus(app, taskId, (output) => (output.progress?.completedRepeats ?? 0) >= 1);

    const cancelReceipt = await callTool(app, 2, "industrial.simulation.study.cancel", { taskId });
    expect(cancelReceipt.structuredContent?.status).toBe("completed");
    const view = cancelReceipt.structuredContent?.output!;
    expect(view.status).toBe("cancelled");
    expect(view.partial).toBe(true);
    expect(view.settleReason).toBe("user");

    const settled = await waitForStatus(app, taskId, (output) => output.status === "cancelled");
    expect(settled.envelope).toBeUndefined();
    expect(settled.progress?.completedRepeats).toBeGreaterThanOrEqual(1);

    const halted = await ledger.listStudyRuns("project-1");
    expect(halted).toHaveLength(1);
    expect(halted[0]).toMatchObject({ status: "cancelled", settleReason: "user" });
    const trace = await callTool(app, 3, "industrial.provenance.trace", { query: { proposalFingerprint: view.proposalFingerprint } });
    const traceOutput = trace.structuredContent?.output as { chains: Array<{ runs: unknown[]; verdicts: unknown[] }> } | undefined;
    expect(traceOutput?.chains[0].runs).toHaveLength(0);
    expect(traceOutput?.chains[0].verdicts).toHaveLength(0);
  }, 30_000);

  it("未知句柄轮询如实 blocked（task-not-found），完成态取消不生效（如实 blocked）", async () => {
    const { app } = await buildHost(0);
    const missing = await callTool(app, 1, "industrial.simulation.study.status", { taskId: "study-0000000000000000" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent?.warnings?.join("\n")).toContain("task-not-found");

    const launched = await callTool(app, 2, "industrial.simulation.study.run-async", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 1 } });
    const taskId = launched.structuredContent?.output?.taskId!;
    await waitForStatus(app, taskId, (output) => output.status === "completed");
    const lateCancel = await callTool(app, 3, "industrial.simulation.study.cancel", { taskId });
    expect(lateCancel.isError).toBe(true);
    expect(lateCancel.structuredContent?.warnings?.join("\n")).toContain("task-already-completed");
  }, 30_000);

  it("计划模式 fail-closed：run-async（simulate）被拒并落拒绝审计语义，status（read）放行", async () => {
    const { registry } = await buildHost(0);
    const gateway = new IndustrialAgentToolGateway(registry as PluginRegistry);
    const planContext = {
      checkpoint: {
        id: "cp-plan",
        planMode: true,
        principal: "tester:1",
        projectId: "project-1",
        usage: { steps: 0, toolCalls: 0 },
      },
      signal: new AbortController().signal,
    };
    const outcome = await gateway.execute(
      { toolId: "simulation.study.run-async", arguments: { hypothesis: POSITIVE_HYPOTHESIS }, resources: [{ kind: "project", id: "project-1" }] } as never,
      planContext as never,
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.error?.code).toBe("plan-mode-tool-not-allowed");
  }, 20_000);
});
