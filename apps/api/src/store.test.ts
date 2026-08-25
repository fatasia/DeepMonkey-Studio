import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pureFixture from "../../../packages/contracts/src/__fixtures__/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type PublishedSceneRecord, type SceneSnapshot } from "@bim-studio/contracts";
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
