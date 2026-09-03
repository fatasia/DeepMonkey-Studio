import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationsService } from "./operations.js";
import { createIndustrialCapabilityHost, registerIndustrialCapabilityRoutes } from "./industrialCapabilities.js";
import { registerMcpCapabilityRoute } from "./mcpCapabilityAdapter.js";
import { createApiServer } from "./serverOptions.js";
import { PARAMETRIC_CAD_TEMPLATES } from "@bim-studio/parametric-modeling-plugin";
import type { DataQuerySource } from "@bim-studio/data-query-plugin";
import { ConversionTaskService } from "./conversionTasks.js";
import type { AiDataBinding, DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import type { BatteryModelGateway, BatteryPredictionInput } from "./batteryModelGateway.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe("industrial capability host", () => {
  it("exposes existing OperationsService through the shared capability contract", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-capabilities-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const operations = new OperationsService(directory);
    await operations.init();
    const host = await createIndustrialCapabilityHost(operations);
    expect(host.registry.listAiProviders()).toEqual([
      expect.objectContaining({ id: "ai.openai-compatible", streaming: true })
    ]);
    expect(host.registry.listCapabilities().map((item) => item.id)).toEqual(expect.arrayContaining([
      "battery.model.predict",
      "battery.release.status",
      "battery.twin.simulate",
      "battery.twin.status",
      "operations.energy.analyze",
      "operations.maintenance.assess",
      "operations.maintenance.shadow-evaluate",
      "modeling.parametric.validate",
      "modeling.parametric.draft",
      "manufacturing.workcell.audit",
      "simulation.virtual-debug.run",
      "simulation.virtual-debug.run-suite"
    ]));

    const result = await host.invoke("operations.energy.analyze", {
      requestId: "energy-1",
      projectId: "project-1",
      principal: "operator",
      input: { observations: [
        { timestamp: "1", output: 10, energyKwh: 5 },
        { timestamp: "2", output: 10, energyKwh: 5 },
        { timestamp: "3", output: 10, energyKwh: 5 },
        { timestamp: "4", output: 10, energyKwh: 8 }
      ] }
    });
    expect(result).toMatchObject({ status: "completed", capabilityId: "operations.energy.analyze", decisionStatus: "production", output: { samples: 4 } });

    const modeling = await host.invoke("modeling.parametric.validate", {
      requestId: "parametric-1",
      projectId: "project-1",
      principal: "engineer",
      input: { definition: PARAMETRIC_CAD_TEMPLATES[0]!.definition }
    });
    expect(modeling).toMatchObject({ status: "completed", decisionStatus: "production", output: { valid: true, parameterCount: 6, featureCount: 5 } });

    const workcell = await host.invoke("manufacturing.workcell.audit", {
      requestId: "workcell-1",
      projectId: "project-1",
      principal: "engineer",
      input: {
        sceneId: "scene-1",
        objects: [{ id: "robot-1", name: "机器人 1", role: "robot", position: { x: 0, y: 0, z: 0 } }],
      },
    });
    expect(workcell).toMatchObject({ status: "completed", decisionStatus: "insufficient-data", output: { generatedBy: "workcell-validation-plugin", status: "needs-data" } });
  });

  it("exposes governed conversion catalog and tasks to Capability/MCP clients", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-conversion-capability-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const operations = new OperationsService(directory);
    await operations.init();
    const conversionTasks = new ConversionTaskService([{
      manifest: {
        contractVersion: 1,
        id: "industrial.jt-exchange",
        name: "JT industrial converter",
        version: "1.0.0",
        execution: "server-worker",
        inputFormats: ["jt"],
        outputs: [{ kind: "geometry", format: "glb", required: true }],
        configurationSchema: {},
        capabilities: ["filesystem.read-input", "filesystem.write-output"],
        limits: { timeoutMs: 30_000, maxInputBytes: 10_000, maxOutputBytes: 20_000, maxMemoryMb: 512, maxCpuPercent: 100 },
      },
      unavailableReason: "等待商业 SDK 许可证",
    }], undefined, () => "task-conversion-1");
    const host = await createIndustrialCapabilityHost(operations, { conversionTasks });

    const catalog = await host.invoke("model.conversion.catalog", {
      requestId: "catalog-1", projectId: "project-1", principal: "developer", input: {},
    });
    expect(catalog).toMatchObject({
      status: "completed",
      output: { converters: [expect.objectContaining({ available: false, unavailableReason: "等待商业 SDK 许可证" })] },
    });

    const submitted = await host.invoke("model.conversion.submit", {
      requestId: "submit-1",
      projectId: "project-1",
      principal: "developer",
      input: {
        pluginId: "industrial.jt-exchange",
        input: { objectKey: "projects/project-1/imports/line.jt", fileName: "line.jt", format: "jt", size: 128 },
      },
    });
    expect(submitted).toMatchObject({
      status: "completed",
      output: { id: "task-conversion-1", status: "waiting_converter", message: "等待商业 SDK 许可证" },
    });
  });

  it("provides a thin HTTP/MCP-compatible invoke endpoint with project scoping", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-capability-routes-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const operations = new OperationsService(directory);
    await operations.init();
    const host = await createIndustrialCapabilityHost(operations);
    const app = createApiServer();
    cleanups.push(() => app.close());
    await registerIndustrialCapabilityRoutes(app, { host, store: { getProject: (id: string) => id === "project-1" ? { id } : undefined } as never });
    const plugins = (await app.inject({ method: "GET", url: "/api/plugins" })).json().plugins;
    expect(plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "bim.ai.parametric-draft", status: "enabled", configurable: true, capabilityIds: ["modeling.parametric.draft"] }),
      expect.objectContaining({ id: "bim.industrial-core", configurable: false }),
    ]));
    expect((await app.inject({ method: "PATCH", url: "/api/admin/plugins/bim.industrial-core/status", payload: { enabled: false } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: "/api/admin/plugins/bim.ai.parametric-draft/status", payload: { enabled: false } })).json()).toMatchObject({ plugin: { status: "registered" } });
    expect(host.registry.getCapability("modeling.parametric.draft")).toBeUndefined();
    expect((await app.inject({ method: "PATCH", url: "/api/admin/plugins/bim.ai.parametric-draft/status", payload: { enabled: true } })).json()).toMatchObject({ plugin: { status: "enabled" } });
    expect((await app.inject({ method: "GET", url: "/api/capabilities" })).json()).toMatchObject({ capabilities: expect.arrayContaining([expect.objectContaining({ id: "operations.energy.analyze", inputSchema: expect.objectContaining({ type: "object" }) })]) });
    expect((await app.inject({ method: "GET", url: "/api/capabilities/operations.energy.analyze" })).json()).toMatchObject({
      id: "operations.energy.analyze",
      inputSchema: { required: ["observations"] }
    });
    expect((await app.inject({ method: "GET", url: "/api/capabilities/missing.capability" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/ai/providers" })).json()).toMatchObject({ providers: [expect.objectContaining({ id: "ai.openai-compatible" })] });
    const batteryModels = (await app.inject({ method: "GET", url: "/api/battery/models/catalog" })).json().models;
    expect(batteryModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "battery.bmsformer", outputAuthority: "primary" }),
      expect.objectContaining({ id: "battery.batterymformer-pinn", status: "production", role: "routed-expert", runtimeEnabled: true }),
      expect.objectContaining({ id: "battery.spm-pino", status: "production", role: "routed-expert", runtimeEnabled: true }),
      expect.objectContaining({ id: "battery.twin-moe", status: "production", role: "production-router", runtimeEnabled: true })
    ]));
    expect((await app.inject({ method: "GET", url: "/api/battery/models/release-gate" })).json()).toMatchObject({
      ready: true,
      onnxPrimaryModels: [],
      onnxMigration: { ready: false, eligibleModelIds: [] },
      warnings: expect.arrayContaining([expect.stringContaining("ONNX")])
    });
    expect((await app.inject({ method: "POST", url: "/api/projects/missing/capabilities/invoke", payload: { capabilityId: "operations.energy.analyze" } })).statusCode).toBe(404);
  });

  it("registers controlled Ask Data and ignores a client-spoofed privileged role", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-data-query-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const operations = new OperationsService(directory);
    await operations.init();
    const host = await createIndustrialCapabilityHost(operations, {
      dataQuerySource: dataQuerySource(),
      aiSettings: () => ({ providerId: "ai.openai-compatible", baseUrl: "https://example.test/v1", model: "test", protocol: "auto", apiKey: "", temperature: 0 }),
    });
    expect(host.registry.listCapabilities().map((item) => item.id)).toEqual(expect.arrayContaining(["data.query.draft", "data.query.plan", "data.query.read"]));

    const draftWithoutProviderKey = await host.invoke("data.query.draft", {
      requestId: "ask-data-draft", projectId: "project-1", principal: "viewer-1", input: { prompt: "各设备平均温度" },
    });
    expect(draftWithoutProviderKey).toMatchObject({ status: "needs-input", warnings: [expect.stringContaining("零 SQL")] });

    const app = createApiServer();
    cleanups.push(() => app.close());
    app.addHook("preHandler", async (request) => {
      request.systemUser = { id: "viewer-1", username: "viewer", displayName: "只读用户", role: "viewer", projectIds: ["project-1"], enabled: true, createdAt: "now", updatedAt: "now" };
    });
    await registerIndustrialCapabilityRoutes(app, { host, store: { getProject: () => ({ id: "project-1" }) } as never });
    const planned = await app.inject({
      method: "POST", url: "/api/projects/project-1/capabilities/invoke",
      payload: { capabilityId: "data.query.plan", role: "admin", principal: "spoofed", input: { datasetId: "telemetry", fields: ["temperature"] } },
    });
    expect(planned.statusCode).toBe(200);
    expect(planned.json()).toMatchObject({ status: "completed", capabilityId: "data.query.plan", output: { status: "ready" } });
    const forbidden = await app.inject({
      method: "POST", url: "/api/projects/project-1/capabilities/invoke",
      payload: { capabilityId: "operations.energy.analyze", role: "admin", input: { observations: [] } },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("exposes the same capabilities through MCP discovery and tool calls", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-mcp-capabilities-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const operations = new OperationsService(directory);
    await operations.init();
    const host = await createIndustrialCapabilityHost(operations);
    const app = createApiServer();
    cleanups.push(() => app.close());
    const store = { getProject: (id: string) => id === "project-1" ? { id } : undefined } as never;
    await registerMcpCapabilityRoute(app, { host, store });
    const listed = await app.inject({ method: "POST", url: "/api/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().result.tools).toEqual(expect.arrayContaining([expect.objectContaining({
      name: "industrial.operations.energy.analyze",
      inputSchema: expect.objectContaining({ properties: expect.objectContaining({ input: expect.objectContaining({ required: ["observations"] }) }) })
    })]));
    const called = await app.inject({ method: "POST", url: "/api/mcp", payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "industrial.operations.energy.analyze", arguments: { projectId: "project-1", input: { observations: [] } } } } });
    expect(called.statusCode).toBe(200);
    expect(called.json().result.isError).toBe(true);
  });

  it("supports stateless MCP 2026 discovery and filters tools by authenticated role", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-mcp-modern-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const operations = new OperationsService(directory);
    await operations.init();
    const host = await createIndustrialCapabilityHost(operations);
    const app = createApiServer();
    cleanups.push(() => app.close());
    app.addHook("preHandler", async (request) => {
      request.systemUser = { id: "viewer-1", username: "viewer", displayName: "只读用户", role: "viewer", projectIds: ["project-1"], enabled: true, createdAt: "now", updatedAt: "now" };
    });
    await registerMcpCapabilityRoute(app, { host, store: { getProject: (id: string) => ["project-1", "project-2"].includes(id) ? { id } : undefined } as never });
    const modernHeaders = { "mcp-protocol-version": "2026-07-28" };
    const discovered = await app.inject({ method: "POST", url: "/api/mcp", headers: { ...modernHeaders, "mcp-method": "server/discover" }, payload: { jsonrpc: "2.0", id: 1, method: "server/discover" } });
    expect(discovered.json().result).toMatchObject({ supportedVersions: expect.arrayContaining(["2026-07-28"]), resultType: "complete", cacheScope: "private" });
    const listed = await app.inject({ method: "POST", url: "/api/mcp", headers: { ...modernHeaders, "mcp-method": "tools/list" }, payload: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    const names = listed.json().result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("industrial.battery.release.status");
    expect(names).not.toContain("industrial.operations.energy.analyze");
    expect(listed.json().result).toMatchObject({ ttlMs: 0, cacheScope: "private" });
    const forbidden = await app.inject({
      method: "POST", url: "/api/mcp",
      headers: { ...modernHeaders, "mcp-method": "tools/call", "mcp-name": "industrial.operations.energy.analyze" },
      payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "industrial.operations.energy.analyze", arguments: { projectId: "project-1", input: { observations: [] } } } }
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("runs battery inference from an HTTP dataset and returns auditable source evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-battery-dataset-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const operations = new OperationsService(directory);
    await operations.init();
    let predictionInput: BatteryPredictionInput | undefined;
    const gateway: BatteryModelGateway = {
      predict: async (input) => {
        predictionInput = input;
        return { summary: "电池状态正常", sohPct: 96.2 };
      },
      health: async () => ({}),
      digitalTwinStatus: async () => ({}),
      releaseStatus: async () => ({}),
      initializeTwin: async () => ({}),
      simulateTwin: async () => ({}),
      assimilateTwin: async () => ({}),
      twinEvidence: async () => ({}),
    };
    const host = await createIndustrialCapabilityHost(operations, { batteryGateway: gateway });
    const dataset: DataDatasetRecord = {
      id: "battery-http",
      projectId: "project-1",
      connectionId: "battery-api",
      name: "BMS 历史窗口",
      refreshSeconds: 5,
      fields: [
        { key: "cycle", label: "循环", type: "number" },
        { key: "time", label: "时间", type: "number" },
        { key: "voltage", label: "电压", type: "number" },
        { key: "current", label: "电流", type: "number" },
        { key: "temperature", label: "温度", type: "number" },
        { key: "capacityAh", label: "放电容量", type: "number" },
      ],
      createdAt: "now",
      updatedAt: "now",
    };
    const dataQuerySource: DataQuerySource = {
      listDatasets: () => [dataset],
      getDataset: (_projectId, datasetId) => datasetId === dataset.id ? dataset : undefined,
      readDataset: async () => ({
        dataset,
        fields: dataset.fields,
        rows: [
          { cycle: 1, time: 1, voltage: 3.42, current: -1.2, temperature: 27, capacityAh: 119, phase: "discharge" },
          { cycle: 2, time: 2, voltage: 3.39, current: -1.3, temperature: 27.2, capacityAh: 118.8, phase: "discharge" },
        ],
        durationMs: 8.8,
      }),
    };
    const connection: DataConnectionRecord = {
      id: dataset.connectionId,
      projectId: "project-1",
      name: "BMS HTTP API",
      type: "http",
      enabled: true,
      config: {},
      createdAt: "now",
      updatedAt: "now",
    };
    const binding: AiDataBinding = {
      id: "battery-binding", projectId: "project-1", name: "SOC 生产绑定", datasetId: dataset.id,
      capabilityId: "battery.model.predict", status: "active", parameters: { model: "socformer", chemistry: "ncm", nominalCapacityAh: 120 },
      features: [
        { modelField: "time", sourceField: "time", required: true },
        { modelField: "voltage", sourceField: "voltage", required: true },
        { modelField: "current", sourceField: "current", required: true },
      ], window: { rows: 1 },
      trigger: { type: "manual" }, quality: { minimumSamples: 1, maxAgeSeconds: 60, maximumMissingRate: 0 },
      retry: { maxAttempts: 3, backoffSeconds: 5 }, output: { type: "record" }, revision: 1, createdAt: "now", updatedAt: "now",
    };
    const app = createApiServer();
    cleanups.push(() => app.close());
    await registerIndustrialCapabilityRoutes(app, {
      host,
      dataQuerySource,
      store: {
        getProject: (id: string) => id === "project-1" ? { id } : undefined,
        listDataConnections: () => [connection],
        getAiDataBinding: (_projectId: string, bindingId: string) => bindingId === binding.id ? binding : undefined,
        saveAiDataBindingRun: async (_projectId: string, run: unknown) => run,
      } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/battery/predictions/from-dataset",
      payload: {
        datasetId: dataset.id,
        model: "bmsformer",
        chemistry: "lfp",
        nominalCapacityAh: 120,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(predictionInput).toMatchObject({
      model: "bmsformer",
      fileName: `dataset:${dataset.id}`,
      chemistry: "lfp",
      nominalCapacityAh: 120,
      records: [
        { cycle: 1, time: 1, voltage: 3.42, current: -1.2, temperature: 27, capacityAh: 119, phase: "discharge" },
        { cycle: 2, time: 2, voltage: 3.39, current: -1.3, temperature: 27.2, capacityAh: 118.8, phase: "discharge" },
      ],
    });
    expect(response.json()).toMatchObject({
      status: "completed",
      output: {
        summary: "电池状态正常",
        sourceEvidence: {
          datasetId: dataset.id,
          datasetName: dataset.name,
          connectionId: connection.id,
          connectionType: "http",
          rowCount: 2,
          fieldKeys: ["cycle", "time", "voltage", "current", "temperature", "capacityAh"],
          durationMs: 9,
        },
      },
    });

    const boundResponse = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/battery/predictions/from-dataset",
      payload: { bindingId: binding.id, datasetId: "ignored-by-binding", model: "bmsformer", chemistry: "lfp" },
    });
    expect(boundResponse.statusCode).toBe(200);
    expect(predictionInput).toMatchObject({
      model: "socformer",
      chemistry: "ncm",
      nominalCapacityAh: 120,
      records: [{ time: 2, voltage: 3.39, current: -1.3 }],
    });
  });
});

function dataQuerySource(): DataQuerySource {
  const dataset = {
    id: "telemetry", projectId: "project-1", connectionId: "sim", name: "设备遥测", refreshSeconds: 10,
    fields: [{ key: "temperature", label: "温度", type: "number" as const, unit: "°C" }],
    createdAt: "now", updatedAt: "now",
  };
  return {
    listDatasets: () => [dataset],
    getDataset: (_projectId, datasetId) => datasetId === dataset.id ? dataset : undefined,
    readDataset: async () => ({ dataset, fields: dataset.fields, rows: [{ temperature: 36 }], durationMs: 1 }),
  };
}
