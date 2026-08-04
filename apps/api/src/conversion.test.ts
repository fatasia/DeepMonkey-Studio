import { describe, expect, it } from "vitest";
import { supportedExtensions } from "@bim-studio/contracts";

describe("conversion contract", () => {
  it("keeps every required upload format registered", () => {
    expect(supportedExtensions).toEqual(["rvt", "ifc", "step", "stp", "dwg", "dxf", "gltf", "glb", "fbx"]);
  });
});
