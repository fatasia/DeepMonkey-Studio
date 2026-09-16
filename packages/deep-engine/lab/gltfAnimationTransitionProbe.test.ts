import { describe, expect, it } from "vitest";
import { verifyGltfAnimationTransitions } from "./gltfAnimationTransitionProbe.js";

describe("glTF animation transition Lab probe", () => {
  it("keeps nested switches continuous and retries a partial publish exactly once", () => {
    expect(verifyGltfAnimationTransitions()).toEqual({
      action: "gltf-animation-transition", success: true, interruptions: 24,
      maximumSwitchJump: 0, cancelledFrameRetriedOnce: true,
      revisionsMonotonic: true, finalAuthorSelectionWon: true,
    });
  });
});
