import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { readSceneModelMaterialState } from "./sceneAuthorMaterialState";

describe("scene author material state", () => {
  it("reads authored state by stable scene model id without a viewer", () => {
    const scene = {
      models: [
        { modelId: "robot", material: { color: "#12abef", roughness: 0.35, customShader: { source: "void main(){}" } }, transform: {} },
      ],
    } as unknown as Pick<SceneSnapshot, "models">;
    const state = readSceneModelMaterialState(scene, "robot");
    expect(state).toEqual({ color: "#12abef", roughness: 0.35, customShader: { source: "void main(){}" } });
    expect(state).not.toBe(scene.models[0]!.material);
  });

  it("returns no state for missing or un-authored models", () => {
    const scene = { models: [{ modelId: "robot" }] } as unknown as Pick<SceneSnapshot, "models">;
    expect(readSceneModelMaterialState(scene, "missing")).toBeUndefined();
    expect(readSceneModelMaterialState(scene, "robot")).toBeUndefined();
  });
});
