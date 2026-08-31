import { describe, expect, it } from "vitest";
import type { SceneAssetBindingState } from "@bim-studio/contracts";
import type { ComponentRecord } from "../viewer/analysis";
import { mergeConfirmedSceneAssetBindings } from "./sceneAssetBindings";

const component: ComponentRecord = {
  id: "node-pump-1",
  stableId: "model-1/node-pump-1",
  modelId: "model-1",
  modelName: "泵房",
  name: "循环泵 P-001",
  type: "Mesh",
  path: "泵房/循环泵 P-001",
  properties: {},
  searchText: "循环泵 p-001",
};

describe("mergeConfirmedSceneAssetBindings", () => {
  it("persists only resolvable human-confirmed mappings", () => {
    const result = mergeConfirmedSceneAssetBindings(
      [],
      [
        { sceneObjectId: component.stableId, deviceId: "P-001", confidence: 0.94 },
        { sceneObjectId: "removed-object", deviceId: "P-404", confidence: 0.8 },
      ],
      [component],
      "2026-08-30T08:00:00.000Z",
    );

    expect(result).toMatchObject({ confirmedCount: 1, skippedCount: 1 });
    expect(result.bindings[0]).toMatchObject({
      sceneObjectId: component.stableId,
      modelId: "model-1",
      layerId: "node-pump-1",
      deviceId: "P-001",
      confidence: 0.94,
      confirmedAt: "2026-08-30T08:00:00.000Z",
    });
  });

  it("replaces conflicts by both scene object and device identity", () => {
    const current: SceneAssetBindingState[] = [
      binding("old-object", "P-001"),
      binding(component.stableId, "OLD-DEVICE"),
      binding("retained-object", "P-002"),
    ];
    const result = mergeConfirmedSceneAssetBindings(
      current,
      [{ sceneObjectId: component.stableId, deviceId: "P-001", confidence: 0.91 }],
      [component],
    );

    expect(result.bindings.map((item) => item.deviceId)).toEqual(["P-002", "P-001"]);
    expect(new Set(result.bindings.map((item) => item.sceneObjectId)).size).toBe(2);
  });
});

function binding(sceneObjectId: string, deviceId: string): SceneAssetBindingState {
  return {
    id: `${sceneObjectId}:${deviceId}`,
    sceneObjectId,
    objectName: sceneObjectId,
    modelId: "model-1",
    deviceId,
    confidence: 0.8,
    confirmedAt: "2026-08-30T08:00:00.000Z",
  };
}
