import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pureFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
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
    const created = await firstStore.createApplicationDraft("default", v2, v2.metadata.createdAt);
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("application setup failed");
    const storedApplication = created.application;
    const publishResult = await firstStore.publishApplication(
      "default",
      storedApplication.metadata.id,
      "publication-golden",
      "2026-08-25T00:00:00.000Z"
    );
    expect(publishResult.status).toBe("published");
    if (publishResult.status !== "published") throw new Error("publication setup failed");
    const publication = publishResult.publication;

    const restartedStore = new JsonStore(directory);
    await restartedStore.init();
    expect(restartedStore.getScene("default", v1.id)).toEqual(v1);
    expect(restartedStore.getApplication("default", storedApplication.metadata.id)).toEqual(storedApplication);
    expect(restartedStore.getPublishedApplication(publication.id)).toEqual(publication);
    expect(restartedStore.getApplicationPublicationPointer(storedApplication.metadata.id)?.activePublicationId).toBe(publication.id);

    const reloadedDraft = restartedStore.getApplication("default", storedApplication.metadata.id);
    expect(reloadedDraft).toBeDefined();
    reloadedDraft!.metadata.name = "重启后的草稿";
    const update = await restartedStore.updateApplicationDraft(
      "default",
      storedApplication.metadata.id,
      reloadedDraft!,
      "2026-08-25T01:00:00.000Z"
    );
    expect(update.status).toBe("updated");
    expect(restartedStore.getApplication("default", storedApplication.metadata.id)?.metadata.name).toBe("重启后的草稿");
    expect(restartedStore.getPublishedApplication(publication.id)?.document.metadata.name).toBe("纯三维");
  });
});
