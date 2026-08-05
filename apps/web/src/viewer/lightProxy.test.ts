import { describe, expect, it } from "vitest";
import { shouldRenderSceneLightProxy } from "./ViewerEngine";

describe("shouldRenderSceneLightProxy", () => {
  it("hides every virtual light model in browse and published views", () => {
    for (const type of ["ambient", "hemisphere", "directional", "point", "spot", "rectArea"] as const) {
      expect(shouldRenderSceneLightProxy(true, type)).toBe(false);
    }
  });

  it("shows editable light handles only for positional lights", () => {
    expect(shouldRenderSceneLightProxy(false, "directional")).toBe(true);
    expect(shouldRenderSceneLightProxy(false, "point")).toBe(true);
    expect(shouldRenderSceneLightProxy(false, "ambient")).toBe(false);
    expect(shouldRenderSceneLightProxy(false, "hemisphere")).toBe(false);
  });
});
