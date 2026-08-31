import { describe, expect, it } from "vitest";
import { ShadowUpdateGovernor } from "./shadowUpdateGovernor";

describe("ShadowUpdateGovernor", () => {
  it("renders static shadows once and refreshes only after a scene change", () => {
    const governor = new ShadowUpdateGovernor();
    expect(governor.evaluate(true, false)).toEqual({ mode: "cached", autoUpdate: false, needsUpdate: true });
    expect(governor.evaluate(true, false)).toEqual({ mode: "cached", autoUpdate: false, needsUpdate: false });
    governor.markDirty();
    expect(governor.evaluate(true, false).needsUpdate).toBe(true);
    expect(governor.snapshot().requestedUpdates).toBe(2);
  });

  it("keeps animated scenes live and captures one final frame when they stop", () => {
    const governor = new ShadowUpdateGovernor();
    expect(governor.evaluate(true, true)).toEqual({ mode: "dynamic", autoUpdate: true, needsUpdate: false });
    expect(governor.evaluate(true, true).autoUpdate).toBe(true);
    expect(governor.evaluate(true, false)).toEqual({ mode: "cached", autoUpdate: false, needsUpdate: true });
    expect(governor.evaluate(false, false).mode).toBe("disabled");
  });

  it("reports unsupported renderer caching instead of claiming a cached result", () => {
    const governor = new ShadowUpdateGovernor();
    expect(governor.evaluate(true, false, false)).toEqual({
      mode: "backend-managed",
      autoUpdate: true,
      needsUpdate: false,
    });
    expect(governor.snapshot().requestedUpdates).toBe(0);
  });
});
