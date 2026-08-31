import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PprBopVersionDraft } from "@bim-studio/contracts";
import { createApiServer } from "./serverOptions.js";
import { PprBopService } from "./pprBopService.js";
import { registerPprBopRoutes } from "./pprBopRoutes.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("PPR/BOP routes", () => {
  it("appends immutable versions, analyzes them, compares their impact and persists history", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-ppr-bop-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const service = new PprBopService(directory);
    await service.init();
    const app = createApiServer();
    cleanups.push(() => app.close());
    await registerPprBopRoutes(app, {
      service,
      store: { getProject: (id: string) => id === "project-1" ? { id } : undefined } as never,
    });

    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/ppr/bop-versions",
      payload: draft(),
    });
    expect(firstResponse.statusCode).toBe(201);
    const first = firstResponse.json() as { id: string; version: string };
    expect(first.version).toBe("v1");

    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/ppr/bop-versions",
      payload: draft(first.id, 10),
    });
    expect(secondResponse.statusCode).toBe(201);
    const second = secondResponse.json() as { id: string; version: string };
    expect(second.version).toBe("v2");

    const analysis = await app.inject({
      method: "GET",
      url: `/api/projects/project-1/ppr/bop-versions/${second.id}/analysis`,
    });
    expect(analysis.statusCode).toBe(200);
    expect(analysis.json()).toMatchObject({ criticalPath: { durationMinutes: 14 } });

    const comparison = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/ppr/bop-versions/compare",
      payload: { beforeVersionId: first.id, afterVersionId: second.id },
    });
    expect(comparison.statusCode).toBe(200);
    expect(comparison.json()).toMatchObject({
      impact: { operationIds: ["assemble"], componentIds: ["assembly"] },
      regressions: expect.arrayContaining([expect.objectContaining({ code: "standard-time-increased" })]),
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/ppr/bop-versions",
      payload: { ...draft(), version: "v1" },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().message).toContain("不可覆盖");

    const reloaded = new PprBopService(directory);
    await reloaded.init();
    expect(reloaded.list("project-1").map((version) => version.version)).toEqual(["v1", "v2"]);
  });
});

function draft(basedOnVersionId?: string, assembleMinutes = 8): PprBopVersionDraft {
  return {
    planId: "door-plan",
    name: "车门装配",
    ...(basedOnVersionId ? { basedOnVersionId } : {}),
    references: [{ kind: "scene", id: "scene-1" }, { kind: "study", id: "study-1" }],
    components: [{ id: "assembly", name: "车门总成", kind: "product" }],
    operations: [
      { id: "locate", name: "定位", standardTimeMinutes: 4, componentRefs: [{ componentId: "assembly", role: "in-process" }] },
      { id: "assemble", name: "装配", standardTimeMinutes: assembleMinutes, componentRefs: [{ componentId: "assembly", role: "output" }] },
    ],
    precedenceRelations: [{ id: "locate-assemble", predecessorOperationId: "locate", successorOperationId: "assemble" }],
    resources: [{ id: "station", name: "工位", kind: "station" }],
    resourceAssignments: [
      { id: "locate-station", operationId: "locate", resourceId: "station" },
      { id: "assemble-station", operationId: "assemble", resourceId: "station" },
    ],
  };
}
