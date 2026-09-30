import { describe, expect, it, vi } from "vitest";
import { ViewerEngineRig } from "./viewerEngineRig";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";
import { readStudioDeepPostProcess } from "./studioDeepColorEffects";

describe("god rays production snapshot owner", () => {
  it("retains the actual enabled author settings through set/get and the Deep frame profile", () => {
    const owner = { postProcessingState: DEFAULT_POST_PROCESSING, syncPostProcessing: vi.fn() };
    const set = ViewerEngineRig.prototype.setPostProcessing, get = ViewerEngineRig.prototype.getPostProcessing;
    set.call(owner as unknown as ViewerEngineRig, { ...DEFAULT_POST_PROCESSING,
      volumetricFog: true, volumetricGodRays: true, volumetricGodRaysStrength: 0 });
    const snapshot = get.call(owner as unknown as ViewerEngineRig);
    expect(snapshot.volumetricGodRays).toBe(true); expect(snapshot.volumetricGodRaysStrength).toBe(0);
    expect(readStudioDeepPostProcess(snapshot, true).volumetricFogProfile?.godRaysStrength).toBe(0);
    snapshot.volumetricGodRaysStrength = 8;
    expect(get.call(owner as unknown as ViewerEngineRig).volumetricGodRaysStrength).toBe(0);
    set.call(owner as unknown as ViewerEngineRig, { ...snapshot, volumetricGodRays: false });
    const disabled = get.call(owner as unknown as ViewerEngineRig);
    expect(disabled.volumetricGodRaysStrength).toBe(8);
    expect(readStudioDeepPostProcess(disabled, true).volumetricFogProfile?.godRaysStrength).toBeUndefined();
    expect(owner.syncPostProcessing).toHaveBeenCalledTimes(2);
  });
  it("uses legacy defaults and clamps the field at the snapshot boundary", () => {
    const owner = { postProcessingState: DEFAULT_POST_PROCESSING, syncPostProcessing: vi.fn() };
    for (const [value, expected] of [[-2, 0], [12, 8], [undefined, 1]]) {
      ViewerEngineRig.prototype.setPostProcessing.call(owner as unknown as ViewerEngineRig,
        { ...DEFAULT_POST_PROCESSING, ...(value === undefined ? {} : { volumetricGodRaysStrength: value }) });
      const saved = ViewerEngineRig.prototype.getPostProcessing.call(owner as unknown as ViewerEngineRig);
      expect(saved.volumetricGodRaysStrength).toBe(expected); expect(saved.volumetricGodRays).toBe(false);
    }
  });
});
