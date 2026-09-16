import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { deformedSceneShader, PBR_DEFORMATION_VERTEX_WGSL } from "./pbrDeformationShader.js";
import { sceneShader } from "./pbrShader.js";

describe("PBR deformation vertex consumers", () => {
  it("retains the static shader and adds four consumers without additional vertex locations", () => {
    expect(deformedSceneShader.startsWith(sceneShader)).toBe(true);
    expect(PBR_DEFORMATION_VERTEX_WGSL.match(/@vertex fn /g)).toHaveLength(4);
    expect(PBR_DEFORMATION_VERTEX_WGSL).not.toContain("@location(");
    expect(PBR_DEFORMATION_VERTEX_WGSL).toContain("@group(1) @binding(11)");
    expect(PBR_DEFORMATION_VERTEX_WGSL).toContain("@group(1) @binding(12)");
  });

  it("uses previous pose with previous transform, and current pose in both shadow paths", () => {
    expect(PBR_DEFORMATION_VERTEX_WGSL).toContain("deepPreviousPose[index].position.xyz");
    expect(PBR_DEFORMATION_VERTEX_WGSL).toContain("dot(previous.row0, oldP)");
    expect(PBR_DEFORMATION_VERTEX_WGSL.match(/deepCurrentPose\[index\]\.position.xyz/g)).toHaveLength(2);
    expect(PBR_DEFORMATION_VERTEX_WGSL).toContain("pose.tangent.w * v.material.z");
    expect(PBR_DEFORMATION_VERTEX_WGSL).toContain("vec2f(v.emissiveAlpha.w, v.material.y)");
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates full shader with all deformation entry points", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-pbr-deformation.wgsl", "--input-kind", "wgsl"],
      { input: deformedSceneShader, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
