import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import pureFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { registerApplicationRoutes } from "./applicationRoutes.js";
import { JsonStore } from "./store.js";
import { createApiServer } from "./serverOptions.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-app-routes-"));
  directories.push(directory);
  const store = new JsonStore(directory);
  await store.init();
  const app = createApiServer();
  await registerApplicationRoutes(app, store);
  return { app, store };
}

describe("application routes", () => {
  it("accepts application IDs through 128 characters and rejects 129", async () => {
    const { app } = await harness();
    for (const length of [100, 101, 128]) {
      const document = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
      document.metadata.projectId = "default";
      document.metadata.id = "a".repeat(length);
      expect((await app.inject({
        method: "POST",
        url: "/api/projects/default/applications",
        payload: document
      })).statusCode).toBe(201);
      expect((await app.inject({
        method: "GET",
        url: `/api/projects/default/applications/${document.metadata.id}`
      })).statusCode).toBe(200);
    }

    expect((await app.inject({
      method: "GET",
      url: `/api/projects/default/applications/${"a".repeat(129)}`
    })).statusCode).toBe(400);
    await app.close();
  });

  it("creates, reads, revisions, and deletes an application", async () => {
    const { app } = await harness();
    const document = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
    document.metadata.projectId = "default";
    expect((await app.inject({ method: "POST", url: "/api/projects/default/applications", payload: document })).statusCode).toBe(201);
    const loaded = await app.inject({ method: "GET", url: `/api/projects/default/applications/${document.metadata.id}` });
    expect(loaded.json().metadata.revision).toBe(1);
    document.metadata.name = "并发修改";
    const updated = await app.inject({ method: "PUT", url: `/api/projects/default/applications/${document.metadata.id}`, payload: document });
    expect(updated.json().metadata.revision).toBe(2);
    const stale = await app.inject({ method: "PUT", url: `/api/projects/default/applications/${document.metadata.id}`, payload: document });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/default/applications/${document.metadata.id}` })).statusCode).toBe(204);
    await app.close();
  });

  it("rejects repeated creation without overwriting the original draft", async () => {
    const { app, store } = await harness();
    const document = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
    document.metadata.projectId = "default";
    expect((await app.inject({ method: "POST", url: "/api/projects/default/applications", payload: document })).statusCode).toBe(201);

    document.metadata.name = "不应覆盖原稿";
    const duplicate = await app.inject({ method: "POST", url: "/api/projects/default/applications", payload: document });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ message: "应用 ID 已存在", currentRevision: 1 });
    expect(store.getApplication("default", document.metadata.id)?.metadata.name).toBe("纯三维");
    await app.close();
  });

  it("rejects a cross-project duplicate and keeps public lookup and history unambiguous", async () => {
    const { app, store } = await harness();
    const document = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
    document.metadata.projectId = "default";
    expect((await app.inject({ method: "POST", url: "/api/projects/default/applications", payload: document })).statusCode).toBe(201);
    const secondProject = await store.createProject("第二项目");
    const duplicate = structuredClone(document);
    duplicate.metadata.projectId = secondProject.id;
    duplicate.metadata.name = "跨项目冲突稿";

    const conflict = await app.inject({
      method: "POST",
      url: `/api/projects/${secondProject.id}/applications`,
      payload: duplicate
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ message: "应用 ID 已存在", currentRevision: 1 });
    expect(store.getApplication(secondProject.id, document.metadata.id)).toBeUndefined();
    expect(store.getApplication("default", document.metadata.id)?.metadata.name).toBe("纯三维");

    const publication = await app.inject({
      method: "POST",
      url: `/api/projects/default/applications/${document.metadata.id}/publish`
    });
    expect(publication.statusCode).toBe(201);
    const publicationId = publication.json().id as string;
    expect((await app.inject({ method: "GET", url: `/api/public/applications/${document.metadata.id}` })).json().id).toBe(publicationId);
    expect((await app.inject({ method: "GET", url: `/api/public/applications/${document.metadata.id}/revisions/${publicationId}` })).json().id).toBe(publicationId);
    expect(store.listApplicationPublications(document.metadata.id).map((item) => item.id)).toEqual([publicationId]);
    await app.close();
  });

  it("permanently reserves an application ID after its draft is deleted", async () => {
    const { app, store } = await harness();
    const document = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
    document.metadata.projectId = "default";
    expect((await app.inject({ method: "POST", url: "/api/projects/default/applications", payload: document })).statusCode).toBe(201);
    const publication = await app.inject({
      method: "POST",
      url: `/api/projects/default/applications/${document.metadata.id}/publish`
    });
    const publicationId = publication.json().id as string;
    expect((await app.inject({ method: "DELETE", url: `/api/projects/default/applications/${document.metadata.id}/publish` })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/default/applications/${document.metadata.id}` })).statusCode).toBe(204);
    expect(store.getApplicationById(document.metadata.id)).toBeUndefined();
    const secondProject = await store.createProject("历史冲突项目");
    const replacement = structuredClone(document);
    replacement.metadata.projectId = secondProject.id;
    replacement.metadata.name = "不应继承历史";

    const conflict = await app.inject({
      method: "POST",
      url: `/api/projects/${secondProject.id}/applications`,
      payload: replacement
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ message: "应用 ID 已存在", currentRevision: 1 });
    expect(store.getApplication(secondProject.id, document.metadata.id)).toBeUndefined();
    expect((await app.inject({ method: "GET", url: `/api/public/applications/${document.metadata.id}` })).statusCode).toBe(404);
    const historical = await app.inject({
      method: "GET",
      url: `/api/public/applications/${document.metadata.id}/revisions/${publicationId}`
    });
    expect(historical.statusCode).toBe(200);
    expect(historical.json().projectId).toBe("default");
    expect(historical.json().document.metadata.name).toBe("纯三维");
    await app.close();
  });

  it("creates immutable publication records and only moves the active pointer", async () => {
    const { app, store } = await harness();
    const document = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
    document.metadata.projectId = "default";
    await app.inject({ method: "POST", url: "/api/projects/default/applications", payload: document });
    const first = await app.inject({ method: "POST", url: `/api/projects/default/applications/${document.metadata.id}/publish` });
    document.metadata.name = "第二版";
    const saved = await app.inject({ method: "PUT", url: `/api/projects/default/applications/${document.metadata.id}`, payload: document });
    const second = await app.inject({ method: "POST", url: `/api/projects/default/applications/${document.metadata.id}/publish` });
    expect(first.json().id).not.toBe(second.json().id);
    expect(store.getPublishedApplication(first.json().id)?.document.metadata.name).toBe("纯三维");
    expect(saved.json().metadata.revision).toBe(2);
    expect((await app.inject({ method: "GET", url: `/api/public/applications/${document.metadata.id}` })).json().id).toBe(second.json().id);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/default/applications/${document.metadata.id}/publish` })).statusCode).toBe(204);
    expect(store.getPublishedApplication(first.json().id)).toBeDefined();
    expect(store.getPublishedApplication(second.json().id)).toBeDefined();
    expect((await app.inject({ method: "GET", url: `/api/public/applications/${document.metadata.id}` })).statusCode).toBe(404);
    await app.close();
  });

  it("blocks application publication when a managed Unity resource is missing", async () => {
    const { app } = await harness();
    const document = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
    document.metadata.projectId = "default";
    document.pages[0]!.nodes.push({ id: "unity-widget", name: "Factory", kind: "data-widget", zIndex: 2, frame: { x: 0, y: 0, width: 800, height: 450 }, widget: { title: "Factory", key: "factory", type: "unity", unit: "", unityResourceId: "missing", unityResourceVersionId: "v1" } });
    expect((await app.inject({ method: "POST", url: "/api/projects/default/applications", payload: document })).statusCode).toBe(201);
    const publication = await app.inject({ method: "POST", url: `/api/projects/default/applications/${document.metadata.id}/publish` });
    expect(publication.statusCode).toBe(409);
    expect(publication.json()).toMatchObject({ message: expect.stringContaining("Unity 发布检查未通过"), issues: [expect.objectContaining({ code: "missing-resource", severity: "blocker" })] });
    await app.close();
  });

  it("removes project drafts and active pointers while retaining hidden immutable history", async () => {
    const { app, store } = await harness();
    const project = await store.createProject("待删除项目");
    const document = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
    document.metadata.projectId = project.id;
    document.metadata.id = "project-delete-history";
    expect((await app.inject({ method: "POST", url: `/api/projects/${project.id}/applications`, payload: document })).statusCode).toBe(201);
    const publication = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/applications/${document.metadata.id}/publish`
    });
    const publicationId = publication.json().id as string;

    expect(await store.removeProject(project.id)).toBe(true);

    expect(store.getApplication(project.id, document.metadata.id)).toBeUndefined();
    expect(store.getApplicationPublicationPointer(document.metadata.id)).toBeUndefined();
    expect(store.getPublishedApplication(publicationId)).toBeDefined();
    expect(store.getApplicationIdReservation(document.metadata.id)?.projectId).toBe(project.id);
    expect((await app.inject({ method: "GET", url: `/api/public/applications/${document.metadata.id}` })).statusCode).toBe(404);
    expect((await app.inject({
      method: "GET",
      url: `/api/public/applications/${document.metadata.id}/revisions/${publicationId}`
    })).statusCode).toBe(404);
    await app.close();
  });

  it("rejects unsafe project and application path IDs", async () => {
    const { app } = await harness();
    const oversized = "a".repeat(129);

    expect((await app.inject({ method: "GET", url: `/api/projects/${oversized}/applications` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/projects/default/applications/${oversized}` })).statusCode).toBe(400);
    await app.close();
  });
});
