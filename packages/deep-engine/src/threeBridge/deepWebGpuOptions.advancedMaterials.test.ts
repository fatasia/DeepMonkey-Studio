import { describe, expect, it } from "vitest";
import { snapshotRendererOptions } from "./deepWebGpuOptions.js";

describe("advancedMaterials renderer option snapshot", () => {
  it("is opt-in: absent by default, preserved when true, boolean-only", () => {
    expect(snapshotRendererOptions({})).not.toHaveProperty("advancedMaterials");
    expect(snapshotRendererOptions({ advancedMaterials: true })).toMatchObject({ advancedMaterials: true });
    expect(snapshotRendererOptions({ advancedMaterials: false })).toMatchObject({ advancedMaterials: false });
    expect(() => snapshotRendererOptions({ advancedMaterials: "yes" as unknown as boolean })).toThrow(TypeError);
  });
});