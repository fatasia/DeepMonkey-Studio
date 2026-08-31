import { describe, expect, it } from "vitest";
import type { AiDataBinding, DataDatasetRecord } from "@bim-studio/contracts";
import { createApiServer } from "./serverOptions.js";
import { registerAiDataBindingRoutes } from "./aiDataBindingRoutes.js";

const dataset: DataDatasetRecord = {
  id: "telemetry", projectId: "project-1", connectionId: "connection-1", name: "设备遥测",
  refreshSeconds: 1, fields: [{ key: "deviceId", label: "设备", type: "string" }, { key: "vibration", label: "振动", type: "number" }],
  createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
};

describe("AI data binding routes", () => {
  it("creates, normalizes, updates and deletes an interval binding", async () => {
    const bindings: AiDataBinding[] = [];
    const store = {
      getProject: (id: string) => id === "project-1" ? { id } : undefined,
      listDatasets: () => [dataset],
      listAiDataBindings: () => structuredClone(bindings),
      getAiDataBinding: (_projectId: string, id: string) => bindings.find((item) => item.id === id),
      saveAiDataBinding: async (_projectId: string, binding: AiDataBinding) => {
        const index = bindings.findIndex((item) => item.id === binding.id);
        if (index >= 0) bindings[index] = structuredClone(binding); else bindings.push(structuredClone(binding));
        return structuredClone(binding);
      },
      removeAiDataBinding: async (_projectId: string, id: string) => {
        const index = bindings.findIndex((item) => item.id === id);
        if (index < 0) return false;
        bindings.splice(index, 1);
        return true;
      },
      listAiDataBindingRuns: () => [],
    };
    const app = createApiServer();
    await registerAiDataBindingRoutes(app, store as never);

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/ai-data-bindings",
      payload: {
        name: "电机预测维护", datasetId: dataset.id, capabilityId: "operations.maintenance.assess", status: "active",
        entity: { keyField: "deviceId" },
        features: [{ modelField: "vibration", sourceField: "vibration", required: true }],
        window: { rows: 120 }, trigger: { type: "interval", seconds: 60 },
        quality: { minimumSamples: 30, maxAgeSeconds: 120, maximumMissingRate: 0.1 },
        retry: { maxAttempts: 3, backoffSeconds: 5 }, output: { type: "case", caseType: "maintenance" },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ revision: 1, trigger: { type: "interval", seconds: 60 }, window: { rows: 120 } });
    const id = created.json<{ id: string }>().id;

    const updated = await app.inject({ method: "PATCH", url: `/api/projects/project-1/ai-data-bindings/${id}`, payload: { trigger: { type: "manual" } } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id, revision: 2, trigger: { type: "manual" } });
    expect((await app.inject({ method: "GET", url: "/api/projects/project-1/ai-data-bindings" })).json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/projects/project-1/ai-data-binding-runs?bindingId=${id}&limit=5` })).json()).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/project-1/ai-data-bindings/${id}` })).statusCode).toBe(204);
    await app.close();
  });

  it("rejects unknown datasets and malformed duplicate feature mappings", async () => {
    const app = createApiServer();
    await registerAiDataBindingRoutes(app, {
      getProject: () => ({ id: "project-1" }), listDatasets: () => [dataset], getAiDataBinding: () => undefined,
      listAiDataBindingRuns: () => [],
    } as never);
    const missing = await app.inject({ method: "POST", url: "/api/projects/project-1/ai-data-bindings", payload: { name: "x", datasetId: "missing", capabilityId: "x" } });
    expect(missing.statusCode).toBe(400);
    const duplicate = await app.inject({
      method: "POST", url: "/api/projects/project-1/ai-data-bindings",
      payload: { name: "x", datasetId: dataset.id, capabilityId: "x", features: [{ modelField: "v", sourceField: "a" }, { modelField: "v", sourceField: "b" }] },
    });
    expect(duplicate.statusCode).toBe(400);
    await app.close();
  });
});
