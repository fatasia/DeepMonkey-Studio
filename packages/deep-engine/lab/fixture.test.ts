import { describe, expect, it } from "vitest";
import { sceneExtent } from "./fixture.js";

describe("Lab scene view profiles", () => {
  it("tightens only the single-model detail view and preserves benchmark extents", () => {
    expect(sceneExtent(1)).toBe(4);
    expect(sceneExtent(1, "single-model-detail")).toBe(1.25);
    for (const count of [49, 256, 1024]) expect(sceneExtent(count, "single-model-detail")).toBe(sceneExtent(count, "benchmark"));
  });
});
