import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationsService } from "./operations.js";
import { registerOperationsRoutes } from "./operationsRoutes.js";
import { OPERATIONS_SNAPSHOT_PLANT_LITE_TRACE_BUDGET } from "./operationsSnapshot.js";
import { runPlantLiteStudy } from "./plantLiteStudy.js";
import { createApiServer } from "./serverOptions.js";

const cleanups: Array<() => Promise<void>> = [];
const FOUR_STUDY_FIXTURE_RESPONSE_BYTE_BUDGET = 300_000;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("operations snapshot payload budget", () => {
  it("returns only the latest full Plant Lite trace while persistence and reproduction keep complete evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-operations-snapshot-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    let runIndex = 0;
    const service = new OperationsService(directory, {
      plantLiteExecutor: {
        async run(projectId, request) {
          const generatedAt = new Date(Date.UTC(2026, 8, 3, 0, 0, runIndex++)).toISOString();
          return runPlantLiteStudy(projectId, request, generatedAt);
        },
      },
    });
    await service.init();

    for (let index = 0; index < 4; index += 1) {
      await service.runPlantLite("project-1", {
        name: `轨迹预算样本 ${index + 1}`,
        seed: `operations-snapshot-${index + 1}`,
        replications: 2,
      });
    }

    const fullSnapshot = service.snapshot("project-1");
    expect(fullSnapshot.plantLiteStudies).toHaveLength(4);
    expect(fullSnapshot.plantLiteStudies.every((study) => Boolean(study.trace))).toBe(true);
    const fullSnapshotBytes = Buffer.byteLength(JSON.stringify(fullSnapshot));

    const app = createApiServer();
    cleanups.push(() => app.close());
    await registerOperationsRoutes(app, {
      service,
      store: { getProject: (id: string) => id === "project-1" ? { id } : undefined } as never,
    });
    const response = await app.inject({ method: "GET", url: "/api/projects/project-1/operations" });
    expect(response.statusCode).toBe(200);
    const snapshot = response.json() as typeof fullSnapshot;
    const snapshotBytes = Buffer.byteLength(response.body);

    expect(snapshot.plantLiteStudies.filter((study) => Boolean(study.trace))).toHaveLength(
      OPERATIONS_SNAPSHOT_PLANT_LITE_TRACE_BUDGET,
    );
    expect(snapshot.plantLiteStudies.map((study) => Boolean(study.trace))).toEqual([true, false, false, false]);
    expect(snapshot.plantLiteStudies[1]).toMatchObject({
      model: expect.any(Object),
      outcome: { throughputPerHour: expect.any(Object) },
      execution: { inputFingerprint: expect.any(String), trace: expect.any(Object) },
    });
    expect(snapshotBytes).toBeLessThan(FOUR_STUDY_FIXTURE_RESPONSE_BYTE_BUDGET);
    expect(snapshotBytes).toBeLessThan(fullSnapshotBytes * 0.4);

    // 响应投影不能反向删除内存或 operations.json 中的权威轨迹。
    expect(service.snapshot("project-1").plantLiteStudies.every((study) => Boolean(study.trace))).toBe(true);
    const reloaded = new OperationsService(directory);
    await reloaded.init();
    expect(reloaded.snapshot("project-1").plantLiteStudies.every((study) => Boolean(study.trace))).toBe(true);

    const oldest = fullSnapshot.plantLiteStudies.at(-1)!;
    const reproduction = await app.inject({
      method: "POST",
      url: `/api/projects/project-1/operations/logistics/des-studies/${oldest.id}/reproduce`,
    });
    expect(reproduction.statusCode).toBe(200);
    expect(reproduction.json()).toMatchObject({ reproductionOf: oldest.id, trace: oldest.trace });
  });
});
