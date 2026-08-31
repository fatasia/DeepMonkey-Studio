import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AiDataBinding, DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./jsonStore.js";

const PROJECT_ID = "default";
const DATASET_ID = "dataset-telemetry";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JsonStore AI data bindings", () => {
  it("persists a binding and returns isolated copies after restart", async () => {
    const directory = await temporaryDirectory();
    const store = await preparedStore(directory);
    const binding = aiDataBinding();

    await store.saveAiDataBinding(PROJECT_ID, binding);
    const listed = store.listAiDataBindings(PROJECT_ID);
    listed[0]!.features[0]!.sourceField = "mutated-outside-store";

    expect(store.getAiDataBinding(PROJECT_ID, binding.id)).toEqual(binding);

    const restarted = new JsonStore(directory);
    await restarted.init();
    expect(restarted.listAiDataBindings(PROJECT_ID)).toEqual([binding]);
  });

  it("upserts revisions and supports all lightweight trigger and output shapes", async () => {
    const store = await preparedStore(await temporaryDirectory());
    const original = aiDataBinding();
    await store.saveAiDataBinding(PROJECT_ID, original);

    const updated: AiDataBinding = {
      ...original,
      revision: 2,
      status: "active",
      trigger: { type: "event", eventName: "device.alarm", debounceSeconds: 30 },
      output: { type: "case", caseType: "predictive-maintenance" },
      updatedAt: "2026-08-31T02:00:00.000Z",
    };
    await store.saveAiDataBinding(PROJECT_ID, updated);
    await store.saveAiDataBinding(PROJECT_ID, {
      ...updated,
      id: "scene-binding",
      trigger: { type: "manual" },
      output: { type: "scene-link", sceneId: "scene-1", entityField: "deviceId" },
    });

    expect(store.listAiDataBindings(PROJECT_ID)).toEqual([
      updated,
      expect.objectContaining({ id: "scene-binding", trigger: { type: "manual" }, output: { type: "scene-link", sceneId: "scene-1", entityField: "deviceId" } }),
    ]);
  });

  it("rejects cross-project or missing-dataset bindings and cascades dataset removal", async () => {
    const store = await preparedStore(await temporaryDirectory());
    await expect(store.saveAiDataBinding(PROJECT_ID, { ...aiDataBinding(), projectId: "another-project" }))
      .rejects.toThrow("project mismatch");
    await expect(store.saveAiDataBinding(PROJECT_ID, { ...aiDataBinding(), datasetId: "missing" }))
      .rejects.toThrow("Data dataset not found");

    await store.saveAiDataBinding(PROJECT_ID, aiDataBinding());
    expect(await store.removeDataset(PROJECT_ID, DATASET_ID)).toBe(true);
    expect(store.listAiDataBindings(PROJECT_ID)).toEqual([]);
  });

  it("normalizes legacy project documents that predate AI bindings", async () => {
    const directory = await temporaryDirectory();
    const databasePath = path.join(directory, "database.json");
    await writeFile(databasePath, JSON.stringify({
      projects: [{
        id: PROJECT_ID,
        name: "旧项目",
        description: "",
        models: [],
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
      }],
      scenes: [],
    }), "utf8");

    const store = new JsonStore(directory);
    await store.init();

    expect(store.listAiDataBindings(PROJECT_ID)).toEqual([]);
    const persisted = JSON.parse(await readFile(databasePath, "utf8")) as {
      projects: Array<{ aiDataBindings?: unknown[] }>;
    };
    expect(persisted.projects[0]?.aiDataBindings).toEqual([]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-studio-ai-binding-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function preparedStore(directory: string): Promise<JsonStore> {
  const store = new JsonStore(directory);
  await store.init();
  await store.saveDataConnection(PROJECT_ID, dataConnection());
  await store.saveDataset(PROJECT_ID, dataset());
  return store;
}

function dataConnection(): DataConnectionRecord {
  return {
    id: "connection-kafka",
    projectId: PROJECT_ID,
    name: "Kafka 设备遥测",
    type: "kafka",
    enabled: true,
    config: { brokers: "kafka:9092", topic: "device.telemetry" },
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function dataset(): DataDatasetRecord {
  return {
    id: DATASET_ID,
    projectId: PROJECT_ID,
    connectionId: "connection-kafka",
    name: "设备遥测",
    sourceKey: "messages",
    refreshSeconds: 10,
    fields: [
      { key: "deviceId", label: "设备", type: "string" },
      { key: "capturedAt", label: "采集时间", type: "datetime" },
      { key: "temperature", label: "温度", type: "number", unit: "℃" },
    ],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function aiDataBinding(): AiDataBinding {
  return {
    id: "binding-maintenance",
    projectId: PROJECT_ID,
    name: "设备温度预测维护",
    datasetId: DATASET_ID,
    capabilityId: "operations.maintenance.evaluate",
    status: "draft",
    entity: { keyField: "deviceId", selectedKeys: ["pump-01"] },
    time: { field: "capturedAt", order: "asc", timezone: "Asia/Shanghai" },
    features: [{ modelField: "temperature", sourceField: "temperature", unit: "℃", required: true }],
    window: { rows: 60, durationSeconds: 3_600 },
    trigger: { type: "interval", seconds: 300 },
    quality: { minimumSamples: 30, maxAgeSeconds: 600, maximumMissingRate: 0.05 },
    retry: { maxAttempts: 3, backoffSeconds: 10 },
    output: { type: "record", targetDatasetId: "maintenance-results" },
    revision: 1,
    createdAt: "2026-08-31T01:00:00.000Z",
    updatedAt: "2026-08-31T01:00:00.000Z",
  };
}
