import { describe, expect, it } from "vitest";
import { sceneViewportSelection } from "./sceneViewportSelection";

describe("sceneViewportSelection", () => {
  it("maps a selected 3D model to the shared application selection", () => {
    expect(sceneViewportSelection("scene-1", "model-1", false)).toEqual([
      { kind: "object", sceneId: "scene-1", modelId: "model-1" },
    ]);
  });

  it("does not clear a 2D layer selection when the editor viewport initializes", () => {
    expect(sceneViewportSelection("scene-1", undefined, false)).toBeUndefined();
  });

  it("allows runtime viewers to clear a 3D object selection", () => {
    expect(sceneViewportSelection("scene-1", undefined, true)).toEqual([]);
  });
});
