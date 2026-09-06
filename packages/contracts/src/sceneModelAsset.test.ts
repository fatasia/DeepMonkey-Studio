import { describe, expect, it } from "vitest";
import fixture from "../../../test-fixtures/scene-v1-interaction.json";
import type { SceneModelState, SceneSnapshot } from "./scene.js";
import { applicationToSceneSnapshotV1, migrateSceneSnapshotV1 } from "./applicationMigration.js";
import { getSceneModelAssetId } from "./sceneModelAsset.js";
import { validateScene } from "./sceneValidation.js";
import { validateApplicationDocument } from "./applicationValidation.js";

function model(): SceneModelState {
  return {
    modelId: "pump-1", name: "泵", visible: true, opacity: 1,
    transform: { position: { x: 2, y: 0, z: 1 }, rotation: { x: 0, y: 1, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  };
}

describe("scene model resource identity", () => {
  it("resolves legacy identity without adding fields to the saved model", () => {
    const legacy = { modelId: "old-resource" };
    expect(getSceneModelAssetId(legacy)).toBe("old-resource");
    expect(legacy).toEqual({ modelId: "old-resource" });
    expect(getSceneModelAssetId({ modelId: "instance", assetModelId: "resource" })).toBe("resource");
  });

  it("deduplicates application assets while round-tripping independent instance references", () => {
    const scene = structuredClone(fixture) as unknown as SceneSnapshot;
    const original = model();
    scene.models = [
      { ...original, assetModelId: "shared-resource" },
      { ...structuredClone(original), modelId: "second-instance", assetModelId: "shared-resource", name: "第二实例" },
    ];
    scene.selectedModelId = original.modelId;
    scene.selectionSets = [{ id: "set", name: "双实例", objectIds: scene.models.map(model => model.modelId) }];
    const before = structuredClone(scene);
    const application = migrateSceneSnapshotV1(scene);
    expect(application.assets.map(asset => asset.id)).toEqual(["shared-resource"]);
    expect(application.scenes[0]!.models.map(model => model.modelId)).toEqual([original.modelId, "second-instance"]);
    expect(applicationToSceneSnapshotV1(application)).toEqual(before);
    expect(scene).toEqual(before);
  });

  it.each(["", " ", "../other", null, 3, undefined])("rejects explicit invalid resource identity %s", assetModelId => {
    const scene = migrateSceneSnapshotV1(fixture as unknown as SceneSnapshot).scenes[0]!;
    scene.models = [Object.assign(model(), { assetModelId }) as SceneModelState];
    expect(() => validateScene(scene, "scene")).toThrow("assetModelId");
  });

  it("allows reversible removal to retain scripts, selection, and simulation references", () => {
    const application = migrateSceneSnapshotV1(fixture as unknown as SceneSnapshot);
    const scene = application.scenes[0]!;
    scene.models = [];
    scene.selectedModelId = "pump-1";
    scene.selectionSets = [{ id: "selection", name: "设备", objectIds: ["pump-1"] }];
    scene.simulationEntities = [{ id: "path", kind: "path", name: "路线", targetModelId: "pump-1", points: [[0, 0, 0], [1, 0, 0]], speed: 1, loopMode: "once" }];
    expect(() => validateScene(scene, "scene")).not.toThrow();
    expect(() => validateApplicationDocument(application)).not.toThrow();
    expect(application.interactions[0]!.source).toMatchObject({ modelId: "pump-1" });
  });
});
