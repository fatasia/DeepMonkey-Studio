import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pureFixture from "../../../packages/contracts/src/__fixtures__/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type PublishedApplicationRecord, type PublishedSceneRecord, type SceneSnapshot } from "@bim-studio/contracts";
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
    await store.saveApplication(original);
    const secondProject = await store.createProject("第二项目");
    const duplicate = structuredClone(original);
    duplicate.metadata.projectId = secondProject.id;

    await expect(store.saveApplication(duplicate)).rejects.toThrow(
      `应用 ID ${original.metadata.id} 已存在于项目 default`
    );
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
    await store.saveApplication(original);
    const firstPublication: PublishedApplicationRecord = {
      id: "publication-1",
      applicationId: original.metadata.id,
      projectId: original.metadata.projectId,
      applicationRevision: 1,
      document: structuredClone(original),
      publishedAt: "2026-08-20T03:00:00.000Z"
    };
    await store.savePublishedApplication(firstPublication);
    original.metadata.revision = 2;
    original.metadata.name = "第二版";
    await store.saveApplication(original);
    await store.savePublishedApplication({
      ...firstPublication,
      id: "publication-2",
      applicationRevision: 2,
      document: structuredClone(original),
      publishedAt: "2026-08-20T04:00:00.000Z"
    });
    await store.removeApplication("default", original.metadata.id);
    const expectedError = `应用 ID ${original.metadata.id} 已由项目 default 的发布历史保留`;

    await expect(store.saveApplication(structuredClone(original))).rejects.toThrow(expectedError);
    const secondProject = await store.createProject("历史冲突项目");
    const crossProjectAttempt = structuredClone(original);
    crossProjectAttempt.metadata.projectId = secondProject.id;
    await expect(store.saveApplication(crossProjectAttempt)).rejects.toThrow(expectedError);

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
});

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
