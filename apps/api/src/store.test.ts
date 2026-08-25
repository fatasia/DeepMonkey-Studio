import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pureFixture from "../../../packages/contracts/src/__fixtures__/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type DatabaseDocument, type PublishedSceneRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore, runProcess } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function scene(id: string, name: string, updatedAt: string): SceneSnapshot {
  return {
    schemaVersion: 1,
    id,
    projectId: "default",
    name,
    camera: {
      position: { x: 5, y: 5, z: 5 },
      target: { x: 0, y: 0, z: 0 },
      mode: "orbit"
    },
    models: [],
    primitives: [],
    measurements: [],
    createdAt: updatedAt,
    updatedAt
  };
}

describe("JsonStore scene management", () => {
  it("lists scenes by updated time descending", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-studio-store-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore(directory);
    await store.init();
    await store.saveScene(scene("older", "较早", "2026-08-01T10:00:00.000Z"));
    await store.saveScene(scene("newer", "较新", "2026-08-03T10:00:00.000Z"));

    expect(store.listScenes("default").map((item) => item.id)).toEqual(["newer", "older"]);
  });

  it("stores an independent publication and removes it with its scene", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-studio-store-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore(directory);
    await store.init();
    const source = scene("scene-1", "测试场景", "2026-08-03T10:00:00.000Z");
    await store.saveScene(source);
    const publication: PublishedSceneRecord = {
      sceneId: source.id,
      projectId: source.projectId,
      name: source.name,
      snapshot: structuredClone(source),
      publishedAt: "2026-08-03T10:05:00.000Z"
    };
    await store.savePublication(publication);
    source.name = "编辑后的名称";

    expect(store.getPublication(source.id)?.snapshot.name).toBe("测试场景");
    await store.removeScene(source.projectId, source.id);
    expect(store.getPublication(source.id)).toBeUndefined();
  });
});

describe("JsonStore application management", () => {
  it("rejects a cross-project duplicate application ID", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-studio-store-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore(directory);
    await store.init();
    const original = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
    original.metadata.projectId = "default";
    expect((await store.createApplicationDraft("default", original, "2026-08-20T01:00:00.000Z")).status).toBe("created");
    const secondProject = await store.createProject("第二项目");
    const duplicate = structuredClone(original);
    duplicate.metadata.projectId = secondProject.id;

    expect(await store.createApplicationDraft(secondProject.id, duplicate, "2026-08-20T01:01:00.000Z")).toMatchObject({
      status: "conflict",
      reservation: { projectId: "default", currentRevision: 1 }
    });
    expect(store.getApplicationById(original.metadata.id)?.metadata.projectId).toBe("default");
    expect(store.getApplication(secondProject.id, original.metadata.id)).toBeUndefined();
  });

  it("rejects same-project and cross-project saves after immutable history reserves an ID", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-studio-store-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore(directory);
    await store.init();
    const original = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
    original.metadata.projectId = "default";
    await store.createApplicationDraft("default", original, "2026-08-20T01:00:00.000Z");
    await store.publishApplication("default", original.metadata.id, "publication-1", "2026-08-20T03:00:00.000Z");
    original.metadata.name = "第二版";
    const update = await store.updateApplicationDraft("default", original.metadata.id, original, "2026-08-20T03:30:00.000Z");
    expect(update).toMatchObject({ status: "updated", application: { metadata: { revision: 2 } } });
    await store.publishApplication("default", original.metadata.id, "publication-2", "2026-08-20T04:00:00.000Z");
    await store.unpublishApplication("default", original.metadata.id);
    await store.deleteApplicationDraft("default", original.metadata.id);

    expect(await store.createApplicationDraft("default", original, "2026-08-20T05:00:00.000Z")).toMatchObject({
      status: "conflict",
      reservation: { projectId: "default", currentRevision: 2 }
    });
    const secondProject = await store.createProject("历史冲突项目");
    const crossProjectAttempt = structuredClone(original);
    crossProjectAttempt.metadata.projectId = secondProject.id;
    expect(await store.createApplicationDraft(secondProject.id, crossProjectAttempt, "2026-08-20T05:00:00.000Z")).toMatchObject({
      status: "conflict",
      reservation: { projectId: "default", currentRevision: 2 }
    });

    expect(store.getApplicationIdReservation(original.metadata.id)).toEqual({
      projectId: "default",
      currentRevision: 2
    });
    expect(store.getApplicationById(original.metadata.id)).toBeUndefined();
    expect(store.listApplicationPublications(original.metadata.id).map((item) => item.id)).toEqual([
      "publication-1",
      "publication-2"
    ]);
  });

  it("does not expose candidate lifecycle state when persistence fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-studio-store-failure-"));
    temporaryDirectories.push(directory);
    const store = new FaultInjectingJsonStore(directory);
    await store.init();
    const application = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
    application.metadata.projectId = "default";
    await store.createApplicationDraft("default", application, "2026-08-20T01:00:00.000Z");
    store.failPersistence = true;

    await expect(store.publishApplication(
      "default",
      application.metadata.id,
      "publication-failed",
      "2026-08-20T03:00:00.000Z"
    )).rejects.toThrow("injected persistence failure");

    expect(store.getApplication("default", application.metadata.id)?.metadata.revision).toBe(1);
    expect(store.getPublishedApplication("publication-failed")).toBeUndefined();
    expect(store.getApplicationPublicationPointer(application.metadata.id)).toBeUndefined();
  });

  it("serializes publish against draft deletion, unpublish, and project deletion", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-studio-store-race-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore(directory);
    await store.init();

    const draftDelete = migratedApplication("race-delete", "default");
    await store.createApplicationDraft("default", draftDelete, "2026-08-20T01:00:00.000Z");
    await Promise.all([
      store.publishApplication("default", draftDelete.metadata.id, "publication-race-delete", "2026-08-20T03:00:00.000Z"),
      store.deleteApplicationDraft("default", draftDelete.metadata.id)
    ]);
    assertActivePointerHasLivePath(store, draftDelete.metadata.id);

    const unpublish = migratedApplication("race-unpublish", "default");
    await store.createApplicationDraft("default", unpublish, "2026-08-20T01:00:00.000Z");
    await store.publishApplication("default", unpublish.metadata.id, "publication-before-race", "2026-08-20T02:00:00.000Z");
    await Promise.all([
      store.publishApplication("default", unpublish.metadata.id, "publication-race-unpublish", "2026-08-20T03:00:00.000Z"),
      store.unpublishApplication("default", unpublish.metadata.id)
    ]);
    assertActivePointerHasLivePath(store, unpublish.metadata.id);

    const project = await store.createProject("并发删除项目");
    const projectDelete = migratedApplication("race-project-delete", project.id);
    await store.createApplicationDraft(project.id, projectDelete, "2026-08-20T01:00:00.000Z");
    await Promise.all([
      store.publishApplication(project.id, projectDelete.metadata.id, "publication-race-project", "2026-08-20T03:00:00.000Z"),
      store.removeProject(project.id)
    ]);

    expect(store.getProject(project.id)).toBeUndefined();
    expect(store.getApplication(project.id, projectDelete.metadata.id)).toBeUndefined();
    expect(store.getApplicationPublicationPointer(projectDelete.metadata.id)).toBeUndefined();
    expect(store.listApplicationPublications(projectDelete.metadata.id)).toHaveLength(1);
  });
});

class FaultInjectingJsonStore extends JsonStore {
  failPersistence = false;

  protected override async persistDocument(document: DatabaseDocument): Promise<void> {
    if (this.failPersistence) throw new Error("injected persistence failure");
    await super.persistDocument(document);
  }
}

function migratedApplication(id: string, projectId: string) {
  const application = migrateSceneSnapshotV1(pureFixture as unknown as SceneSnapshot);
  application.metadata.id = id;
  application.metadata.projectId = projectId;
  return application;
}

function assertActivePointerHasLivePath(store: JsonStore, applicationId: string): void {
  const pointer = store.getApplicationPublicationPointer(applicationId);
  if (!pointer) return;
  expect(store.getProject(pointer.projectId)).toBeDefined();
  expect(store.getApplication(pointer.projectId, applicationId)).toBeDefined();
  expect(store.getPublishedApplication(pointer.activePublicationId)).toBeDefined();
}

describe("process input", () => {
  it("streams large content through stdin instead of command arguments", async () => {
    const largeInput = "scene-state-".repeat(20_000);
    const output = await runProcess(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      {},
      largeInput
    );

    expect(output).toBe(largeInput);
  });
});
