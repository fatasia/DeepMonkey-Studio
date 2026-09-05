import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSceneSnapshotV1, type ApplicationDocument, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import fixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import { JsonStore } from "./store.js";
import { LocalObjectStore } from "./objects.js";
import { createApiServer } from "./serverOptions.js";
import { registerApplicationRoutes } from "./applicationRoutes.js";
import { registerPublishedApplicationRoutes, publishedApplicationBundle } from "./publishedApplicationRoutes.js";
import { registerScriptDependencyRoutes } from "./scriptDependencyRoutes.js";
import { ScriptDependencyService } from "./scriptDependencyService.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-public-application-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory); await store.init();
  const objects = new LocalObjectStore(directory); await objects.init();
  const service = new ScriptDependencyService({ dataDir: directory, objects });
  const app = createApiServer(); cleanup.push(() => app.close());
  await registerApplicationRoutes(app, store);
  await registerPublishedApplicationRoutes(app, { store, dependencies: service });
  await registerScriptDependencyRoutes(app, { store, service });
  const document = migrateSceneSnapshotV1(fixture as SceneSnapshot);
  document.metadata.projectId = "default";
  const base = `/api/projects/default/applications/${document.metadata.id}`;
  return { app, store, service, document, base };
}

describe("published application runtime boundary", () => {
  it("returns only the active immutable document and stops current browsing after withdrawal", async () => {
    const { app, document, base } = await harness();
    await app.inject({ method: "POST", url: "/api/projects/default/applications", payload: document });
    const publication = (await app.inject({ method: "POST", url: `${base}/publish` })).json();
    const publicPath = `/api/public/applications/${document.metadata.id}/browse`;
    const browse = await app.inject({ method: "GET", url: publicPath });
    expect(browse.statusCode).toBe(200);
    expect(browse.headers["cache-control"]).toBe("no-store");
    expect(browse.json().publication.id).toBe(publication.id);
    const changed = { ...publication.document, metadata: { ...publication.document.metadata, name: "新草稿" } };
    expect((await app.inject({ method: "PUT", url: base, payload: changed })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: publicPath })).json().publication.document.metadata.name).toBe(document.metadata.name);
    await app.inject({ method: "DELETE", url: `${base}/publish` });
    expect((await app.inject({ method: "GET", url: publicPath })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/public/applications/missing/browse" })).statusCode).toBe(404);
  });

  it("scopes dependency reads to the exact publication and retains historical references after draft deletion", async () => {
    const { app, store, service, document, base } = await harness();
    const dependency = await service.installUpload("default", "@test/math", "math.js", Buffer.from("export const answer = 42;"));
    const unpublished = await service.installUpload("default", "@test/private", "private.js", Buffer.from("export const answer = 99;"));
    document.scriptDependencies = [dependency];
    await app.inject({ method: "POST", url: "/api/projects/default/applications", payload: document });
    const publication = (await app.inject({ method: "POST", url: `${base}/publish` })).json();
    const prefix = `/api/public/applications/${document.metadata.id}/revisions/${publication.id}/dependencies/`;
    const response = await app.inject({ method: "GET", url: prefix + dependency.id });
    expect(response.statusCode).toBe(200); expect(response.body).toContain("42");
    expect((await app.inject({ method: "GET", url: prefix + unpublished.id })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: prefix.replace(document.metadata.id, "other-app") + dependency.id })).statusCode).toBe(404);
    const remove = `/api/projects/default/script-dependencies/${dependency.id}`;
    expect((await app.inject({ method: "DELETE", url: remove })).statusCode).toBe(409);
    await app.inject({ method: "DELETE", url: `${base}/publish` });
    await app.inject({ method: "DELETE", url: base });
    expect(store.getApplication("default", document.metadata.id)).toBeUndefined();
    expect((await app.inject({ method: "DELETE", url: remove })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: prefix + dependency.id })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/default/script-dependencies/${unpublished.id}` })).statusCode).toBe(204);
  });

  it("filters project integrations and unreferenced models from the browse bundle", () => {
    const document: ApplicationDocument = migrateSceneSnapshotV1(fixture as SceneSnapshot);
    document.scenes[0]!.models = [{ modelId: "used", name: "used", visible: true }] as ApplicationDocument["scenes"][number]["models"];
    const project = { id: document.metadata.projectId, name: "项目", description: "", createdAt: "now", updatedAt: "now",
      models: [{ id: "used" }, { id: "private" }], dataConnections: [{ id: "private-source" }], aiBindings: [{ id: "private-ai" }] } as ProjectRecord;
    const publication = { id: "publication", applicationId: document.metadata.id, projectId: project.id, applicationRevision: 1, publishedAt: "now", document };
    const bundle = publishedApplicationBundle(publication, project);
    expect(bundle.project.models.map(model => model.id)).toEqual(["used"]);
    expect(bundle.project).not.toHaveProperty("dataConnections");
    expect(bundle.project).not.toHaveProperty("aiBindings");
    expect(bundle.publication.document).not.toBe(document);
    expect(() => publishedApplicationBundle(publication, { ...project, id: "wrong-project" })).toThrow("不匹配");
  });
});
