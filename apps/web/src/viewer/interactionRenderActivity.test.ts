import { describe, expect, it } from "vitest";
import type { SceneInteractionScriptState } from "@bim-studio/contracts";
import { interactionRenderActivity } from "./interactionRenderActivity";

const script = (code: string, enabled = true): SceneInteractionScriptState => ({
  id: "click", name: "Select", enabled, trigger: "click", target: { kind: "object", modelId: "base" }, code,
});

describe("interaction render activity", () => {
  it("allows event-only and disabled scripts to sleep between invalidations", () => {
    expect(interactionRenderActivity([script(""), script(" \n "), script("requestAnimationFrame(tick)", false)])).toBe(false);
  });
  it("keeps enabled trusted code conservatively live", () => {
    expect(interactionRenderActivity([script("requestAnimationFrame(tick)")])).toBe(true);
  });
});
