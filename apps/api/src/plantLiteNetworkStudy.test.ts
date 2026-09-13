import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgvNetworkPlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { OperationsService } from "./operations.js";
import { createApiServer } from "./serverOptions.js";
import { registerOperationsRoutes } from "./operationsRoutes.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(action => action())); });

it("persists and reproduces blocked multi-AGV journeys through the Worker and project routes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-network-study-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const service = new OperationsService(directory); await service.init();
  const app = createApiServer(); cleanups.push(() => app.close());
  await registerOperationsRoutes(app, { service, store: { getProject: (id: string) => ["qa", "other"].includes(id) ? { id } : undefined } as never });
  const model = createAgvNetworkPlantLiteModel();
  model.transportNetwork!.segments.forEach(segment => { segment.blockedUntilMinute = 10; });
  const first = await app.inject({ method: "POST", url: "/api/projects/qa/operations/logistics/des-studies", payload: { name: model.name, model, seed: "network", replications: 3, limits: { durationMinutes: 60 } } });
  expect(first.statusCode).toBe(200);
  const baseline = first.json();
  expect(baseline.model).toEqual(model);
  expect(baseline.trace.events.some((event: { transport?: unknown }) => event.transport)).toBe(true);
  expect(service.snapshot("other").plantLiteStudies).toHaveLength(0);
  const forbidden = await app.inject({ method: "POST", url: `/api/projects/other/operations/logistics/des-studies/${baseline.id}/reproduce` });
  expect(forbidden.statusCode).toBe(400);
  expect(forbidden.body).toContain("Study 不存在");
  const reloaded = new OperationsService(directory); await reloaded.init();
  expect(reloaded.snapshot("qa").plantLiteStudies[0]).toMatchObject({ model, trace: baseline.trace });
  const repeat = await app.inject({ method: "POST", url: `/api/projects/qa/operations/logistics/des-studies/${baseline.id}/reproduce` });
  expect(repeat.statusCode).toBe(200);
  expect(repeat.json()).toMatchObject({ reproductionOf: baseline.id, inputFingerprint: baseline.inputFingerprint, outcome: baseline.outcome, trace: baseline.trace });
});
