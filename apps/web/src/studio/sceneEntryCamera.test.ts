import { describe, expect, it } from "vitest";
import type { CameraState } from "@bim-studio/contracts";
import { resolveSceneEntryCamera } from "./sceneEntryCamera";

const thirdPerson: CameraState = {
  position: { x: 8, y: 4, z: 2 },
  target: { x: 0, y: 0, z: 0 },
  mode: "thirdPerson",
  avatarVisible: true,
};

describe("resolveSceneEntryCamera", () => {
  it("enters a saved experience scene in a safe orbit authoring mode", () => {
    expect(resolveSceneEntryCamera(thirdPerson, { readOnly: false, safeAuthoringEntry: true })).toEqual({
      ...thirdPerson,
      mode: "orbit",
      avatarVisible: false,
    });
  });

  it("preserves authored navigation for preview and in-editor snapshot operations", () => {
    expect(resolveSceneEntryCamera(thirdPerson, { readOnly: true, safeAuthoringEntry: true })).toBe(thirdPerson);
    expect(resolveSceneEntryCamera(thirdPerson, { readOnly: false, safeAuthoringEntry: false })).toBe(thirdPerson);
  });
});
