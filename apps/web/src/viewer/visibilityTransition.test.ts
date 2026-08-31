import { describe, expect, it } from "vitest";
import { normalizeVisualTransition, visibilityTransitionSample } from "./visibilityTransition";

describe("visibility transitions", () => {
  it("samples reversible scale and rise transitions", () => {
    const scale = { kind: "scale", durationMs: 300, easing: "linear" } as const;
    expect(visibilityTransitionSample(scale, 0, true)).toMatchObject({ opacityFactor: 0, scaleFactor: 0.82 });
    expect(visibilityTransitionSample(scale, 1, true)).toMatchObject({ opacityFactor: 1, scaleFactor: 1 });
    expect(visibilityTransitionSample(scale, 1, false)).toMatchObject({ opacityFactor: 0, scaleFactor: 0.82 });
    expect(visibilityTransitionSample({ ...scale, kind: "rise" }, 0, true).riseFactor).toBe(-1);
  });

  it("clamps untrusted durations", () => {
    expect(normalizeVisualTransition({ kind: "fade", durationMs: 99_999, easing: "ease-out" }).durationMs).toBe(5_000);
  });
});
