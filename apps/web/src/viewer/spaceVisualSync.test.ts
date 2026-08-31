import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { syncSpaceVisualTransforms, type SpaceVisualRuntime } from "./spaceVisualSync";
import type { LoadedSceneModel } from "./viewerTypes";

describe("syncSpaceVisualTransforms", () => {
  it("updates one model matrix once and skips unchanged overlay propagation", () => {
    const scene = new THREE.Scene();
    const modelObject = new THREE.Group();
    modelObject.position.set(3, 2, 1);
    scene.add(modelObject);
    const model = loadedModel(modelObject);
    const visuals = [runtime(scene, "space-a"), runtime(scene, "space-b")];
    const modelUpdate = vi.spyOn(modelObject, "updateWorldMatrix");
    const visualUpdates = visuals.map((visual) => vi.spyOn(visual.object, "updateMatrixWorld"));

    syncSpaceVisualTransforms(visuals, new Map([[model.id, model]]));
    expect(modelUpdate).toHaveBeenCalledTimes(1);
    expect(visuals[0]!.object.matrixWorld.elements).toEqual(modelObject.matrixWorld.elements);
    expect(visuals[1]!.object.matrixWorld.elements).toEqual(modelObject.matrixWorld.elements);

    syncSpaceVisualTransforms(visuals, new Map([[model.id, model]]));
    expect(modelUpdate).toHaveBeenCalledTimes(2);
    expect(visualUpdates[0]).toHaveBeenCalledTimes(1);
    expect(visualUpdates[1]).toHaveBeenCalledTimes(1);
  });

  it("updates visibility independently from an unchanged matrix", () => {
    const scene = new THREE.Scene();
    const modelObject = new THREE.Group();
    scene.add(modelObject);
    const model = loadedModel(modelObject);
    const visual = runtime(scene, "space-a");
    syncSpaceVisualTransforms([visual], new Map([[model.id, model]]));

    model.visible = false;
    syncSpaceVisualTransforms([visual], new Map([[model.id, model]]));
    expect(visual.object.visible).toBe(false);
  });
});

function loadedModel(object: THREE.Group): LoadedSceneModel {
  return { id: "model-1", name: "Model", object, kind: "model", visible: true, opacity: 1 };
}

function runtime(scene: THREE.Scene, name: string): SpaceVisualRuntime {
  const object = new THREE.Group();
  object.name = name;
  object.matrixAutoUpdate = false;
  scene.add(object);
  return { modelId: "model-1", object };
}
