import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiServer } from "./serverOptions.js";
import { OperationsService } from "./operations.js";
import { registerOperationsRoutes } from "./operationsRoutes.js";
import { runPlantLiteStudy } from "./plantLiteStudy.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((action) => action())); });

describe("Plant Lite study adapter", () => {
  it("marks one replication as insufficient data instead of overstating a confidence interval", () => {
    const result = runPlantLiteStudy("project-1", { name: "单次试跑", seed: "fixed", replications: 1 }, "2026-08-31T08:00:00.000Z");
    expect(result).toMatchObject({ templateId: "agv-line-v1", outcome: { status: "insufficient-data", completedReplications: 1, throughputPerHour: { samples: 1 } } });
  });

  it("persists a bounded DES study and exactly reproduces its evidence and statistics", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-plant-lite-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const service = new OperationsService(directory); await service.init();
    const app = createApiServer(); cleanups.push(() => app.close());
    await registerOperationsRoutes(app, { service, store: { getProject: (id: string) => id === "project-1" ? { id } : undefined } as never });
    const payload = { name: "AGV 基线", agvCount: 3, bufferCapacity: 8, seed: "baseline-42", replications: 3 };
    const first = await app.inject({ method: "POST", url: "/api/projects/project-1/operations/logistics/des-studies", payload });
    expect(first.statusCode).toBe(200);
    const baseline = first.json() as { id: string; inputFingerprint: string; execution: { inputFingerprint: string; engineVersion: string }; outcome: { status: string; throughputPerHour: { samples: number } } };
    expect(baseline).toMatchObject({ execution: { engineVersion: "1.0.0" }, outcome: { status: "completed", throughputPerHour: { samples: 3 } } });
    expect(baseline.execution.inputFingerprint).toBe(baseline.inputFingerprint);
    const repeat = await app.inject({ method: "POST", url: `/api/projects/project-1/operations/logistics/des-studies/${baseline.id}/reproduce` });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toMatchObject({
      reproductionOf: baseline.id,
      inputFingerprint: baseline.inputFingerprint,
      execution: first.json().execution,
      outcome: first.json().outcome,
    });
    expect(service.snapshot("project-1").plantLiteStudies).toHaveLength(2);

    const reloaded = new OperationsService(directory);
    await reloaded.init();
    expect(reloaded.snapshot("project-1").plantLiteStudies).toMatchObject([
      { reproductionOf: baseline.id, outcome: first.json().outcome },
      { id: baseline.id, outcome: first.json().outcome },
    ]);
  });
});
