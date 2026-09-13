import { describe, expect, it } from "vitest";
import {
  evaluateShaderHotReloadChecks,
  type ShaderHotReloadProbeChecks,
} from "./shaderHotReloadProbe.js";

const complete: ShaderHotReloadProbeChecks = Object.freeze({
  initialPublish: true,
  successfulReplacement: true,
  gpuFailurePreservedActive: true,
  latestRequestOnly: true,
  identicalPackageNoOp: true,
  compilationInfoFailure: true,
  validationScopesBalanced: true,
  pipelineWarmupObserved: true,
  deviceLossInvalidated: true,
  disposeFinal: true,
});

describe("shader hot reload real GPU probe evidence", () => {
  it("requires every transactional and real-GPU lifecycle check", () => {
    expect(evaluateShaderHotReloadChecks(complete)).toBe(true);
    for (const key of Object.keys(complete) as (keyof ShaderHotReloadProbeChecks)[]) {
      expect(evaluateShaderHotReloadChecks({ ...complete, [key]: false })).toBe(false);
    }
  });
});
