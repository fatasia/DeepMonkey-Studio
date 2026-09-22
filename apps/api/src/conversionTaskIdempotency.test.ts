import { describe, expect, it, vi } from "vitest";
import type { ConversionTaskRecord, ConverterPluginManifest, SubmitConversionTaskRequest } from "@bim-studio/contracts";
import { ConversionTaskService } from "./conversionTasks.js";

const manifest: ConverterPluginManifest = { contractVersion: 1, id: "test.idempotent", name: "Idempotency", version: "1",
  execution: "server-worker", inputFormats: ["jt"], outputs: [{ kind: "log", format: "json", required: false }],
  capabilities: [], configurationSchema: {}, limits: { timeoutMs: 1000, maxInputBytes: 100, maxOutputBytes: 100, maxCpuPercent: 100, maxMemoryMb: 100 } };
const request: SubmitConversionTaskRequest = { projectId: "project-1", idempotencyKey: "upload-1", pluginId: manifest.id,
  input: { fileName: "a.jt", format: "jt", objectKey: "projects/project-1/a.jt", size: 10 }, configuration: { b: 2, a: 1 } };

describe("durable conversion idempotency", () => {
  it("waits for the first durable reservation and executes concurrent identical submissions once", async () => {
    const records = new Map<string, ConversionTaskRecord>();
    let release!: () => void; let nextId = 0;
    const execute = vi.fn(async () => {});
    const storage = {
      listConversionTasks: () => [...records.values()],
      saveConversionTask: vi.fn(async (task: ConversionTaskRecord) => {
        if (!records.has(task.id)) await new Promise<void>(resolve => { release = resolve; });
        records.set(task.id, structuredClone(task));
      }),
    };
    const service = new ConversionTaskService([{ manifest, execute }], undefined, () => `task-${++nextId}`, storage);
    const first = service.submitDurable(request);
    const second = service.submitDurable({ ...request, configuration: { a: 1, b: 2 }, input: { ...request.input, format: ".JT" } });
    expect(service.list(request.projectId)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(storage.saveConversionTask).toHaveBeenCalledTimes(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe(b.id);
    await vi.waitFor(() => expect(service.get(request.projectId, a.id)?.status).toBe("succeeded"));
    expect(execute).toHaveBeenCalledOnce();
    expect(records.size).toBe(1);
    const restored = new ConversionTaskService([{ manifest, execute }], undefined, undefined, storage);
    await restored.initialize();
    expect((await restored.submitDurable(request)).id).toBe(a.id);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects reuse for different bytes, model, provider or configuration", async () => {
    const service = new ConversionTaskService([{ manifest }]);
    service.submit(request);
    for (const changed of [
      { ...request, input: { ...request.input, size: 11 } },
      { ...request, modelId: "model-2" },
      { ...request, pluginId: "test.other" },
      { ...request, configuration: { a: 9, b: 2 } },
    ]) await expect(service.submitDurable(changed)).rejects.toMatchObject({ code: "conflict" });
  });

  it("removes a failed reservation and allows an explicit retry after database recovery", async () => {
    const storage = { listConversionTasks: () => [], saveConversionTask: vi.fn(async () => { throw new Error("database unavailable"); }) };
    const service = new ConversionTaskService([{ manifest }], undefined, undefined, storage);
    await expect(service.submitDurable(request)).rejects.toThrow("database unavailable");
    expect(service.list(request.projectId)).toEqual([]);
    storage.saveConversionTask.mockResolvedValue(undefined);
    expect((await service.submitDurable(request)).status).toBe("waiting_converter");
  });
});
