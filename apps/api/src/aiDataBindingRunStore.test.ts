import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AiDataBindingRunRecord, DatabaseDocument, ProjectRecord } from "@bim-studio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./jsonStore.js";

const PROJECT_ID = "default";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AI data binding run storage", () => {
  it("persists run evidence and isolates all returned copies", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonStore(directory);
    await store.init();
    const run = runRecord(1, "succeeded");

    const saved = await store.saveAiDataBindingRun(PROJECT_ID, run);
    saved.input!.sourceEvidence!.fieldKeys[0] = "external-save-mutation";
    const listed = store.listAiDataBindingRuns(PROJECT_ID);
    listed[0]!.output!.metrics!.confidence = 0;

    expect(store.getAiDataBindingRun(PROJECT_ID, run.id)).toEqual(run);

    const restarted = new JsonStore(directory);
    await restarted.init();
    expect(restarted.listAiDataBindingRuns(PROJECT_ID)).toEqual([run]);
  });

  it("orders newest first and filters by binding, status and limit", async () => {
    const store = new JsonStore(await temporaryDirectory());
    await store.init();
    await store.saveAiDataBindingRun(PROJECT_ID, runRecord(1, "succeeded"));
    await store.saveAiDataBindingRun(PROJECT_ID, { ...runRecord(2, "failed"), bindingId: "binding-b" });
    await store.saveAiDataBindingRun(PROJECT_ID, runRecord(3, "failed"));

    expect(store.listAiDataBindingRuns(PROJECT_ID, { status: "failed", limit: 1 })).toEqual([
      expect.objectContaining({ id: "run-003" }),
    ]);
    expect(store.listAiDataBindingRuns(PROJECT_ID, { bindingId: "binding-b" })).toEqual([
      expect.objectContaining({ id: "run-002" }),
    ]);
    expect(store.listAiDataBindingRuns(PROJECT_ID, { limit: 0 })).toEqual([]);
  });

  it("keeps only the latest 500 runs when saving new history", async () => {
    const directory = await temporaryDirectory();
    const document = legacyDocument(Array.from({ length: 500 }, (_, index) => runRecord(index, "succeeded")));
    await writeFile(path.join(directory, "database.json"), JSON.stringify(document), "utf8");
    const store = new JsonStore(directory);
    await store.init();

    await store.saveAiDataBindingRun(PROJECT_ID, runRecord(500, "succeeded"));

    const runs = store.listAiDataBindingRuns(PROJECT_ID);
    expect(runs).toHaveLength(500);
    expect(runs[0]?.id).toBe("run-500");
    expect(runs.some((item) => item.id === "run-000")).toBe(false);
  });

  it("normalizes old and oversized project documents during initialization", async () => {
    const legacyDirectory = await temporaryDirectory();
    await writeFile(path.join(legacyDirectory, "database.json"), JSON.stringify(legacyDocument()), "utf8");
    const legacyStore = new JsonStore(legacyDirectory);
    await legacyStore.init();
    expect(legacyStore.listAiDataBindingRuns(PROJECT_ID)).toEqual([]);

    const oversizedDirectory = await temporaryDirectory();
    const history = Array.from({ length: 505 }, (_, index) => runRecord(index, "succeeded"));
    await writeFile(path.join(oversizedDirectory, "database.json"), JSON.stringify(legacyDocument(history)), "utf8");
    const oversizedStore = new JsonStore(oversizedDirectory);
    await oversizedStore.init();
    expect(oversizedStore.listAiDataBindingRuns(PROJECT_ID)).toHaveLength(500);

    const persisted = JSON.parse(await readFile(path.join(oversizedDirectory, "database.json"), "utf8")) as DatabaseDocument;
    expect(persisted.projects[0]?.aiDataBindingRuns).toHaveLength(500);
  });

  it("rejects a run from another project", async () => {
    const store = new JsonStore(await temporaryDirectory());
    await store.init();
    await expect(store.saveAiDataBindingRun(PROJECT_ID, { ...runRecord(1, "running"), projectId: "other" }))
      .rejects.toThrow("project mismatch");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-studio-ai-binding-run-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runRecord(index: number, status: AiDataBindingRunRecord["status"]): AiDataBindingRunRecord {
  const timestamp = new Date(Date.UTC(2026, 7, 31, 0, 0, index)).toISOString();
  const id = `run-${String(index).padStart(3, "0")}`;
  return {
    id,
    projectId: PROJECT_ID,
    bindingId: "binding-a",
    bindingRevision: 2,
    capabilityId: "operations.maintenance.evaluate",
    datasetId: "dataset-telemetry",
    trigger: { type: "interval", seconds: 300 },
    status,
    attempt: 1,
    input: {
      sourceEvidence: {
        datasetId: "dataset-telemetry",
        datasetName: "设备遥测",
        connectionId: "connection-http",
        connectionType: "http",
        rowCount: 60,
        fieldKeys: ["temperature"],
        sampledAt: timestamp,
        durationMs: 8,
      },
      entityKeys: ["pump-01"],
      sampleCount: 60,
      windowStartAt: timestamp,
      windowEndAt: timestamp,
    },
    output: { type: "record", referenceIds: [`assessment-${id}`], metrics: { confidence: 0.92 } },
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 20,
    updatedAt: timestamp,
  };
}

function legacyDocument(runs?: AiDataBindingRunRecord[]): DatabaseDocument {
  const project: ProjectRecord = {
    id: PROJECT_ID,
    name: "旧项目",
    description: "",
    models: [],
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...(runs ? { aiDataBindingRuns: runs } : {}),
  };
  return { projects: [project], scenes: [] };
}
