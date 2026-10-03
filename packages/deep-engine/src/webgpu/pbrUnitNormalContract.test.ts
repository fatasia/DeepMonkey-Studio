import { describe, expect, it } from "vitest";
import { sceneShader } from "./pbrShader.js";
import { deformedSceneShader } from "./pbrDeformationShader.js";
import { composeTextureArraySceneShader } from "./textureArrayWgsl.js";
import { composeLayeredMaterialSceneShader } from "./pbrLayeredMaterialShader.js";

function body(source: string, name: string): string {
  const marker = `fn ${name}(`, start = source.indexOf(marker);
  expect(start, name).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(marker, start + 1), name).toBe(-1);
  let end = source.indexOf("{", start) + 1, depth = 1;
  while (depth && end < source.length) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") depth--;
    end++;
  }
  expect(depth, name).toBe(0);
  return source.slice(start, end);
}

const variants = {
  plain: sceneShader,
  deformation: deformedSceneShader,
  array: composeTextureArraySceneShader(sceneShader),
  deformationArray: composeTextureArraySceneShader(deformedSceneShader),
  layered: composeLayeredMaterialSceneShader(sceneShader),
  deformationLayered: composeLayeredMaterialSceneShader(deformedSceneShader),
};

describe("normalized material inputs share one consumption contract", () => {
  for (const [variant, source] of Object.entries(variants)) {
    it(`${variant}: shade inputs keep orientation, mapping and fallback before consumption`, () => {
      for (const name of ["fragmentMain", "fragmentMainColor", "fragmentMainTransparent",
        "fragmentMainDisplay", "fragmentMainDisplayNoEffects"]) {
        expect(body(source, name)).toContain("normal = orientedNormal(v.normal, v.material, frontFacing)");
      }
      for (const name of ["fragmentMaterial", "fragmentMaterialColor", "fragmentMaterialDisplay",
        "fragmentMaterialTransparent"]) {
        expect(body(source, name)).toContain("geometryNormal = orientedNormal(v.normal, v.material, frontFacing)");
        expect(body(source, name)).toContain("normal = mappedNormal(v, frontFacing)");
      }
      expect(body(source, "orientedNormal")).toContain("return safeNormalize(select(normalInput, -normalInput, reverseBackFace)");
      expect(body(source, "mappedNormal")).toContain("return safeNormalize(tangent * tangentNormal.x");
      for (const name of ["shade", "shadeDirectNoEffects"]) {
        expect(body(source, name)).toContain("let n = normalInput;");
        expect(body(source, name)).not.toContain("safeNormalize(normalInput,");
      }
      for (const name of ["fragmentMainDisplayNoEffectsOneCascade", "fragmentMainDisplayDirectional"]) {
        expect(body(source, name)).toContain("let n = orientedNormal(v.normal, v.material, frontFacing);");
        expect(body(source, name)).not.toContain("safeNormalize(orientedNormal(");
      }
    });
  }
  it("retains generic safety, half-vector safety and default screen derivatives", () => {
    expect(body(sceneShader, "safeNormalize")).toContain("fallback");
    expect(body(sceneShader, "brdfWithDielectricF0")).toContain("let h = safeNormalize(v + l, n)");
    expect(sceneShader).toContain("max(abs(dpdx(normal)), abs(dpdy(normal)))");
    expect(body(sceneShader, "shade")).toContain("deepViewGeometryRoughness(geometryNormal)");
    expect(body(sceneShader, "shadeDirectNoEffects")).toContain("deepViewGeometryRoughness(n)");
    expect(body(sceneShader, "shadeDirectOneCascade")).toContain("safeNormalize(frame.eye.xyz - world");
  });
});
