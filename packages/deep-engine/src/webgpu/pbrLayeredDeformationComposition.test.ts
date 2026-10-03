import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sceneShader } from "./pbrShader.js";
import { deformedSceneShader } from "./pbrDeformationShader.js";
import { composeLayeredMaterialSceneShader } from "./pbrLayeredMaterialShader.js";

function functionText(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let end = open + 1, depth = 1;
  while (end < source.length && depth > 0) {
    if (source[end] === "{") depth += 1;
    if (source[end] === "}") depth -= 1;
    end += 1;
  }
  expect(depth).toBe(0);
  return source.slice(start, end);
}

const variants = {
  layered: sceneShader,
  deformationLayered: deformedSceneShader,
};

describe("layered shader vertex composition", () => {
  for (const [name, source] of Object.entries(variants)) {
    it(`${name} scopes tangent replacements to the correct vertex functions`, () => {
      const shader = composeLayeredMaterialSceneShader(source);
      expect(functionText(shader, "vertexMain")).toContain("out.metalTangent = safeNormalize(metalTangent - out.normal");
      expect(functionText(shader, "vertexNormalMapped")).toContain("out.metalTangent = safeNormalize(rawTangent - n");
      if (name.includes("deformation")) {
        const pose = functionText(shader, "deepPoseVertex");
        expect(pose).toContain("dot(v.row0.xyz, pose.tangent.xyz)");
        expect(pose).toContain("out.metalTangent = safeNormalize(metalTangent - n");
        expect(pose).not.toContain("rawTangent");
      }
    });

    it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))(`${name} validates the complete composed module with Naga`, () => {
      const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", `${name}.wgsl`, "--input-kind", "wgsl"], {
        input: composeLayeredMaterialSceneShader(source), encoding: "utf8",
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    });
  }

  it("rejects a modified vertex anchor and accidental recomposition", () => {
    expect(() => composeLayeredMaterialSceneShader(sceneShader.replace("fn vertexMain(", "fn removedVertex("))).toThrow("function anchor changed");
    expect(() => composeLayeredMaterialSceneShader(composeLayeredMaterialSceneShader(deformedSceneShader))).toThrow("anchor changed");
  });
});
