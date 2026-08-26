import { describe, expect, it } from "vitest";
import type { SceneDocument } from "@bim-studio/contracts";
import { sceneViewportRevision } from "./sceneViewportRevision";

const scene = {
  id: "scene:test",
  name: "Test",
  camera: { position: [1, 2, 3], target: [0, 0, 0], mode: "perspective" },
  models: [],
  primitives: [],
  measurements: []
} as unknown as SceneDocument;

describe("sceneViewportRevision", () => {
  it("does not change when an application command only recreates the containing objects", () => {
    expect(sceneViewportRevision(structuredClone(scene))).toBe(sceneViewportRevision(scene));
  });

  it("changes when semantic 3D content changes", () => {
    expect(sceneViewportRevision({ ...scene, name: "Changed" })).not.toBe(sceneViewportRevision(scene));
  });
});
