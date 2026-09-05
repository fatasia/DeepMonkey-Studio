import { describe, expect, it, vi } from "vitest";
import type { DataDatasetRecord } from "@bim-studio/contracts";
import type { DataQuerySource } from "@bim-studio/data-query-plugin";
import { PluginRegistry } from "@bim-studio/plugin-runtime";
import { IndustrialAgentOrchestrator, MemoryAgentCheckpointStore } from "@bim-studio/industrial-agent-orchestrator";
import { registerDataQueryPlugin } from "../registerDataQueryPlugin.js";
import { createIndustrialAgentDecisionProvider } from "./industrialAgentDecisionProvider.js";
import { IndustrialAgentToolGateway } from "./industrialAgentToolGateway.js";
import { AiProviderHttpError } from "./openAiCompatibleProvider.js";

const dataset: DataDatasetRecord = {
  id: "telemetry", projectId: "project-1", connectionId: "fixture", name: "设备趋势", refreshSeconds: 10,
  fields: [{ key: "temperature", label: "温度", type: "number" }], createdAt: "2026-09-05", updatedAt: "2026-09-05",
};

describe("Agent project discovery → controlled query → evidence", () => {
  it("clarifies candidates, persists a selection, then recovers a real provider failure without repeating the plan", async () => {
    const { orchestrator, source } = await runtime("recover-choice");
    const waiting = await orchestrator.start({ projectId: "project-1", principal: "operator", role: "editor", objective: "读取设备温度", allowedToolIds: ["data.query.plan", "data.query.read"] });
    expect(waiting).toMatchObject({ status: "awaiting-input", pendingSelection: { options: [{ id: "telemetry", label: "设备趋势" }, { id: "telemetry-b", label: "第二产线设备趋势" }] } });
    const failed = await orchestrator.resume(waiting.id, { expectedRevision: waiting.revision, selectionId: "telemetry-b", selectedBy: "operator" });
    expect(failed).toMatchObject({ status: "failed", failure: { code: "decision-provider-unavailable", retryable: true, phase: "decision" }, usage: { steps: 2, toolCalls: 1 } });
    const completed = await orchestrator.resume(failed.id, { expectedRevision: failed.revision });
    expect(completed.status).toBe("completed");
    expect(completed.id).toBe(waiting.id);
    expect(completed.toolRecords.map(record => record.call.toolId)).toEqual(["data.query.plan", "data.query.read"]);
    expect(completed.toolRecords[1]?.outcome.output).toMatchObject({ datasetId: "telemetry-b", rows: [{ temperature: 25 }] });
    expect(source.readDataset).toHaveBeenCalledExactlyOnceWith("project-1", "telemetry-b", expect.any(AbortSignal));
  });

  it("blocks a planner that ignores the explicit data source selection", async () => {
    const { orchestrator, source } = await runtime("ignore-choice");
    const waiting = await orchestrator.start({ projectId: "project-1", principal: "operator", objective: "读取温度", allowedToolIds: ["data.query.plan", "data.query.read"] });
    const blocked = await orchestrator.resume(waiting.id, { expectedRevision: waiting.revision, selectionId: "telemetry-b", selectedBy: "operator" });
    expect(blocked).toMatchObject({ status: "blocked", failure: { code: "selection-mismatch" } });
    expect(source.readDataset).not.toHaveBeenCalled();
  });
  it("uses the server catalog to plan and read through the real plugins without a client datasetId", async () => {
    const { orchestrator, source } = await runtime();
    const result = await orchestrator.start({ projectId: "project-1", principal: "operator", role: "editor", objective: "读取设备温度", context: {}, allowedToolIds: ["data.query.plan", "data.query.read"] });
    expect(result.status).toBe("completed");
    expect(result.usage.toolCalls).toBe(2);
    expect(result.toolRecords.map(record => record.call.toolId)).toEqual(["data.query.plan", "data.query.read"]);
    expect(result.toolRecords[1]?.outcome.output).toMatchObject({ datasetId: "telemetry", rows: [{ temperature: 25 }], returnedRows: 1 });
    expect(result.completion?.evidenceIds).toEqual([expect.stringContaining("telemetry")]);
    expect(source.readDataset).toHaveBeenCalledExactlyOnceWith("project-1", "telemetry", expect.any(AbortSignal));
  });

  it.each(["foreign-dataset", "unknown-field"])("rejects a %s chosen by the model without a data read", async invalid => {
    const { orchestrator, source } = await runtime(invalid);
    const result = await orchestrator.start({ projectId: "project-1", principal: "operator", role: "editor", objective: "读取设备温度", context: {}, allowedToolIds: ["data.query.plan", "data.query.read"] });
    expect(result.status).toBe("blocked");
    expect(source.readDataset).not.toHaveBeenCalled();
    expect(result.toolRecords[0]?.outcome.status).toBe("blocked");
  });
});

async function runtime(invalid?: string) {
  const clarify = ["recover-choice", "ignore-choice"].includes(invalid ?? "");
  let failedOnce = false;
  const datasets = clarify ? [dataset, { ...dataset, id: "telemetry-b", name: "第二产线设备趋势" }] : [dataset];
  const source: DataQuerySource = {
    listDatasets: projectId => projectId === dataset.projectId ? datasets : [],
    getDataset: (projectId, id) => projectId === dataset.projectId ? datasets.find(item => item.id === id) : undefined,
    readDataset: vi.fn(async (_projectId, id) => ({ dataset: datasets.find(item => item.id === id)!, fields: dataset.fields, rows: [{ temperature: 25 }], durationMs: 1 })),
  };
  const registry = new PluginRegistry({
    apiVersion: "1.0", sceneApiVersion: "1.0", host: "cloud", renderer: "webgl2",
    capabilities: ["ai.provider", "data.query"], permissions: ["ai.invoke", "data.read"],
    extensionPoints: ["ai.provider", "capability.provider"], allowTrustedSceneExtensions: false,
  });
  await registerDataQueryPlugin(registry, source);
  const registered = registry.register({
    schemaVersion: 1, id: "test.ai", name: "Deterministic QA planner", version: "1.0.0", apiVersion: "1.0", hosts: ["cloud"],
    capabilities: ["ai.provider"], permissions: ["ai.invoke"],
    extensionPoints: [{ kind: "ai.provider", id: "test.runtime", providerIds: ["ai.test"], execution: "in-process", limits: { timeoutMs: 1_000, maxInputBytes: 100_000, memoryMb: 32 } }],
  }, ({ registerAiProvider }) => registerAiProvider({
    descriptor: { id: "ai.test", version: "1.0.0", label: "Test planner", execution: "in-process", permissions: ["ai.invoke"], streaming: false, timeoutMs: 1_000 },
    async complete(request) {
      const context = JSON.parse(request.input).context;
      const catalog = JSON.parse(context.serverDatasetCatalog);
      const selected = context.selectedDatasets?.[0]?.id;
      const entry = catalog.datasets.find((item: { id: string }) => item.id === (selected && invalid !== "ignore-choice" ? selected : "telemetry"));
      const last = context.toolResults.at(-1);
      if (clarify && !selected) return { text: JSON.stringify({ kind: "request-input", rationale: "两条产线字段相同", question: "请选择产线", options: catalog.datasets.map((item: { id: string }) => ({ id: item.id, label: "模型的错误名称" })) }), model: "qa" };
      if (invalid === "recover-choice" && last?.toolId === "data.query.plan" && !failedOnce) { failedOnce = true; throw new AiProviderHttpError(504, "Gateway timeout"); }
      const decision = !last
        ? { kind: "call-tool", rationale: "从服务端目录定位温度", call: { toolId: "data.query.plan", arguments: { datasetId: invalid === "foreign-dataset" ? "foreign" : entry.id, fields: [invalid === "unknown-field" ? "missing" : entry.fields[0].key] }, resources: [{ kind: "project", id: "project-1" }] } }
        : last.toolId === "data.query.plan"
          ? { kind: "call-tool", rationale: "读取已校验计划", call: { toolId: "data.query.read", arguments: { plan: last.output.plan }, resources: [{ kind: "project", id: "project-1" }] } }
          : { kind: "finish", rationale: "只报告真实读取值", summary: "温度 25", decisionStatus: "production", evidenceIds: last.evidence.map((e: { id: string }) => e.id) };
      return { text: JSON.stringify(decision), model: "qa" };
    },
  }));
  expect(registered.ok).toBe(true);
  expect((await registry.enable("test.ai")).ok).toBe(true);
  const decisions = createIndustrialAgentDecisionProvider({ registry, dataSource: source, settings: () => ({ providerId: "ai.test", model: "qa", protocol: "responses", baseUrl: "https://example.test", apiKey: "qa", temperature: 0 }) });
  return { source, orchestrator: new IndustrialAgentOrchestrator({ decisions, tools: new IndustrialAgentToolGateway(registry), checkpoints: new MemoryAgentCheckpointStore() }) };
}
