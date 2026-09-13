import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { OperationsService } from "./operations.js";
import { createApiServer } from "./serverOptions.js";
import { registerOperationsRoutes } from "./operationsRoutes.js";

it("archives legacy records and their references without touching unrelated project data, then reloads idempotently", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-operations-isolation-"));
  try {
    const initial = new OperationsService(directory);
    await initial.init();
    const empty = initial.snapshot("p1");
    const project = {
      ...empty,
      models: [{ id: "legacy-model", source: "iot-nb" }, { id: "own-model", source: "imported" }],
      deployments: [{ id: "legacy-deployment", modelId: "legacy-model" }],
      assessments: [{ id: "legacy-assessment", deploymentId: "legacy-deployment" }],
      shadowEvaluations: [{ id: "legacy-shadow", modelId: "legacy-model" }],
      cases: [{ id: "own-case", sourceRefs: [] }, { id: "legacy-case", sourceRefs: ["legacy-assessment"] }],
      validationStudies: [{ id: "legacy-study", sourceRefs: ["legacy-case"] }],
    };
    const original = { schemaVersion: 1, projects: { p1: project, p2: empty } };
    await writeFile(path.join(directory, "operations.json"), JSON.stringify(original));
    const service = new OperationsService(directory);
    await service.init();
    const current = service.snapshot("p1");
    expect(current.models).toEqual([{ id: "own-model", source: "imported" }]);
    expect(current.cases).toEqual([{ id: "own-case", sourceRefs: [] }]);
    expect(current.deployments).toEqual([]);
    expect(current.assessments).toEqual([]);
    expect(current.shadowEvaluations).toEqual([]);
    expect(current.validationStudies).toEqual([]);
    expect(service.snapshot("p2")).toEqual(empty);
    const archives = (await readdir(directory)).filter(name => name.endsWith(".archive.json"));
    expect(archives).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(directory, archives[0]!), "utf8"))).toEqual(original);
    const reloaded = new OperationsService(directory);
    await reloaded.init();
    expect(reloaded.snapshot("p1")).toEqual(current);
    expect((await readdir(directory)).filter(name => name.endsWith(".archive.json"))).toEqual(archives);
    const app = createApiServer();
    try {
      await registerOperationsRoutes(app, { service, store: { getProject: () => ({ id: "p1" }) } as never });
      for (const endpoint of ["sync-iot-nb", "models/legacy-model/assess-iot-nb"]) {
        expect((await app.inject({ method: "POST", url: `/api/projects/p1/operations/maintenance/${endpoint}` })).statusCode).toBe(404);
      }
    } finally { await app.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
