import { expect, it } from "vitest";
import { localDirectModule } from "./c8LocalDirectProbe.js";
import { sceneShader } from "../src/webgpu/pbrShader.js";
import { FORWARD_PLUS_PBR_WGSL, forwardPlusPbrLibrary } from "../src/lighting/clusterLightingPbrWgsl.js";

it("formal captures the unchanged production shader, ablation changes only its cluster library", () => {
  const formal = localDirectModule("formal"), ablation = localDirectModule("single-scatter-ablation");
  expect(formal.code).toBe(sceneShader); expect(formal.actualHash).toBe(formal.originalHash);
  expect(ablation.actualHash).not.toBe(formal.originalHash); expect(ablation.originalHash).toBe(formal.originalHash);
  expect(ablation.code.slice(FORWARD_PLUS_PBR_WGSL.length)).toBe(formal.code.slice(forwardPlusPbrLibrary("direct-multiscattering").length));
});
it("rejects unknown shader profiles", () => expect(() => localDirectModule("unknown" as never)).toThrow("Unknown local shader profile"));
