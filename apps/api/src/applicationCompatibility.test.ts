import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pureFixture from "../../../packages/contracts/src/__fixtures__/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("v1 and application persistence compatibility", () => {
  it("survives restart while keeping draft and immutable publication independent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-application-compatibility-"));
    temporaryDirectories.push(directory);
    const firstStore = new JsonStore(directory);
    await firstStore.init();
    const v1 = { ...(pureFixture as unknown as SceneSnapshot), projectId: "default" };
    await firstStore.saveScene(v1);
    const v2 = migrateSceneSnapshotV1(v1);
    await firstStore.saveApplication(v2);
    const publication = await firstStore.savePublishedApplication({
      id: "publication-golden",
      applicationId: v2.metadata.id,
      projectId: v2.metadata.projectId,
      applicationRevision: v2.metadata.revision,
      document: structuredClone(v2),
      publishedAt: "2026-08-25T00:00:00.000Z"
    });
    await firstStore.saveApplicationPublicationPointer({
      applicationId: v2.metadata.id,
      projectId: v2.metadata.projectId,
      activePublicationId: publication.id,
      updatedAt: publication.publishedAt
    });

    const restartedStore = new JsonStore(directory);
    await restartedStore.init();
    expect(restartedStore.getScene("default", v1.id)).toEqual(v1);
    expect(restartedStore.getApplication("default", v2.metadata.id)).toEqual(v2);
    expect(restartedStore.getPublishedApplication(publication.id)).toEqual(publication);
    expect(restartedStore.getApplicationPublicationPointer(v2.metadata.id)?.activePublicationId).toBe(publication.id);

    const reloadedDraft = restartedStore.getApplication("default", v2.metadata.id);
    expect(reloadedDraft).toBeDefined();
    reloadedDraft!.metadata.name = "重启后的草稿";
    await restartedStore.saveApplication(reloadedDraft!);
    expect(restartedStore.getApplication("default", v2.metadata.id)?.metadata.name).toBe("重启后的草稿");
    expect(restartedStore.getPublishedApplication(publication.id)?.document.metadata.name).toBe("纯三维");
  });
});
