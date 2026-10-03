import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { ScenePostProcessingState } from "@bim-studio/contracts";
import { INSTANCE_OUTLINE_USER_DATA_KEY } from "@bim-studio/deep-engine";
import { readStudioDeepPostProcess } from "./studioDeepColorEffects";
import { syncDeepOutlineTags } from "./deepOutlineTags";
import { deepSupportsObjectOutline } from "./deepOutlineSupport";

const state: ScenePostProcessingState = { enabled: true, smaa: false, ssao: false,
  ssaoIntensity: 1, bloom: false, bloomStrength: 0.35, bloomThreshold: 0.9 };

describe("Deep object outline host wiring", () => {
  it("forwards the author outline strength only when authored, independent of composer activity", () => {
    expect(readStudioDeepPostProcess(state, true)).not.toHaveProperty("instanceOutline");
    expect(readStudioDeepPostProcess({ ...state, outlineStrength: 4 }, false)).toMatchObject({ instanceOutline: { strength: 4 } });
  });

  it("tags only the outlined set and clears objects that leave it", () => {
    const owner = {}, a = new THREE.Group(), b = new THREE.Group(), c = new THREE.Group();
    expect(syncDeepOutlineTags(owner, [a, b])).toBe(true);
    expect(a.userData[INSTANCE_OUTLINE_USER_DATA_KEY]).toBe(true);
    expect(syncDeepOutlineTags(owner, [a, b])).toBe(false);
    expect(syncDeepOutlineTags(owner, [b, c])).toBe(true);
    expect(a.userData[INSTANCE_OUTLINE_USER_DATA_KEY]).toBeUndefined();
    expect(c.userData[INSTANCE_OUTLINE_USER_DATA_KEY]).toBe(true);
    expect(syncDeepOutlineTags(owner, [])).toBe(true);
    expect(b.userData).not.toHaveProperty(INSTANCE_OUTLINE_USER_DATA_KEY);
    expect(syncDeepOutlineTags(owner, [])).toBe(false);
  });

  it("reports the engine's object outline capability", () => {
    expect(deepSupportsObjectOutline()).toBe(true);
  });
});
