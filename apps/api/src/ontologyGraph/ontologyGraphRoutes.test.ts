import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemUserRecord } from "@bim-studio/contracts";
import { createApiServer } from "../serverOptions.js";
import type { MetadataStore } from "../store.js";
import { OntologyPackageStore } from "../ontology/ontologyStore.js";
import { buildPublishablePackage } from "../ontology/ontologyStore.test.js";
import { ONTOLOGY_GRAPH_ROUTE, registerOntologyGraphRoutes } from "./ontologyGraphRoutes.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup(user: Partial<SystemUserRecord> | undefined) {
  const directory = await mkdtemp(path.join(tmpdir(), "ontology-graph-routes-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const ontology = new OntologyPackageStore(directory);
  await ontology.init();
  const store = {
    getProject: (projectId: string) => (projectId === "project-1" ? { id: projectId } : undefined),
  };
  const app = createApiServer();
  if (user) app.addHook("preHandler", async (request) => { request.systemUser = user as never; });
  await registerOntologyGraphRoutes(app, { store: store as unknown as MetadataStore, ontology });
  const seeded = await ontology.createPackage("project-1", buildPublishablePackage(), "seed");
  return { app, packageId: seeded.id };
}

const QUERY = { root: { type: "object", id: "Device" }, depth: 1, limit: 50 };

describe("ontology graph routes", () => {
  it("只读图查询：返回节点/边/观测统计；viewer 可用（图谱是只读投影）", async () => {
    const viewer = await setup({ id: "watcher", role: "viewer" });
    const response = await viewer.app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${viewer.packageId}/graph`, payload: QUERY });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.packageId).toBe(viewer.packageId);
    expect(body.nodes.length).toBeGreaterThanOrEqual(2);
    expect(body.edges.length).toBeGreaterThanOrEqual(1);
    expect(body.elapsedMs).toBeTypeOf("number");
    expect(body.packageUpdatedAt).toBeTypeOf("string");
    expect(typeof body.truncated).toBe("boolean");
    await viewer.app.close();
  });

  it("非法查询体 400（depth/direction/root 逐条 fail-closed）；root 不存在 400", async () => {
    const { app, packageId } = await setup({ id: "editor-1", role: "editor" });
    const badDepth = await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/graph`, payload: { ...QUERY, depth: 9 } });
    expect(badDepth.statusCode).toBe(400);
    expect(badDepth.json().message).toContain("depth");

    const badDirection = await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/graph`, payload: { ...QUERY, direction: "sideways" } });
    expect(badDirection.statusCode).toBe(400);
    expect(badDirection.json().message).toContain("direction");

    const missingRoot = await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/graph`, payload: { root: { type: "object", id: "Nope" }, depth: 1, limit: 10 } });
    expect(missingRoot.statusCode).toBe(400);
    expect(missingRoot.json().message).toContain("图根节点不存在");

    // limit 超界被 clamp（不报错）而不是拒绝
    const clamped = await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/graph`, payload: { ...QUERY, limit: 99999999 } });
    expect(clamped.statusCode).toBe(200);
    await app.close();
  });

  it("项目不存在 404；包不存在 404；空 body 400", async () => {
    const { app, packageId } = await setup({ id: "editor-1", role: "editor" });
    expect((await app.inject({ method: "POST", url: `/api/projects/other/ontology-packages/${packageId}/graph`, payload: QUERY })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/projects/project-1/ontology-packages/missing/graph", payload: QUERY })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/graph` })).statusCode).toBe(400);
    await app.close();
  });

  it("端点路径常量与注册路径一致（单一来源防漂移）", () => {
    expect(ONTOLOGY_GRAPH_ROUTE).toBe("/api/projects/:projectId/ontology-packages/:packageId/graph");
  });
});
