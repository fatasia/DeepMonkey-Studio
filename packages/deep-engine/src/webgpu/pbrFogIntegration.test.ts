import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sceneShader } from "./pbrShader.js";
import { PBR_FOG_WGSL } from "./pbrFogWgsl.js";
import { pbrDirectDisplayClear } from "./pbrDirectDisplay.js";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import { validatePbrRenderView } from "./pbrRenderViewValidation.js";
import type { RenderView } from "./pbrRendererTypes.js";

const view: RenderView = { eye: [0, 0, 5], target: [0, 0, 0], extent: 5,
  background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 0.5, width: 64, height: 64, pixelRatio: 1 };
const fog = { kind: "exp2" as const, color: [0.2, 0.3, 0.4] as const, density: 0.018 };

describe("PBR author fog GPU integration", () => {
  it("keeps explicit authored fog on the HDR path even when every optional effect is disabled", () => {
    const features = resolvePbrRendererFeatures({ fog: false, environment: false, groundGrid: false,
      ambientOcclusion: false, temporalAa: false, spatialAa: false, occlusionCulling: false, bloom: false, vignette: false });
    expect(pbrDirectDisplayClear(view, features, false)).toBeDefined();
    expect(pbrDirectDisplayClear({ ...view, fog: null }, features, false)).toBeDefined();
    expect(pbrDirectDisplayClear({ ...view, fog }, features, false)).toBeUndefined();
  });

  it("validates authored fog at the render-view boundary without changing legacy defaults", () => {
    expect(() => validatePbrRenderView(view)).not.toThrow();
    expect(() => validatePbrRenderView({ ...view, fog: null })).not.toThrow();
    expect(() => validatePbrRenderView({ ...view, fog })).not.toThrow();
    expect(() => validatePbrRenderView({ ...view, fog: { ...fog, density: NaN } })).toThrow();
  });

  it("uses signed view depth and authored color before the preserved legacy radial branch", () => {
    expect(sceneShader).toContain("deepApplyAuthorFog(color, -(frame.worldToView * vec4f(world, 1.0)).z)");
    expect(sceneShader.indexOf("deepFog.colorMode.w < 2.5")).toBeLessThan(sceneShader.indexOf("let distance = length(frame.eye.xyz - world)"));
    expect(PBR_FOG_WGSL).toContain("@group(0) @binding(8)");
    expect(PBR_FOG_WGSL).toContain("smoothstep(deepFog.parameters.x, deepFog.parameters.y, viewDepth)");
    expect(PBR_FOG_WGSL).toContain("mix(color, deepFog.colorMode.rgb, factor)");
    expect(PBR_FOG_WGSL.slice(0, PBR_FOG_WGSL.indexOf("fn deepApplySceneFog"))).not.toContain("0.95");
  });

  it("honors material fog opt-out before both authored and legacy fog for every main material path", () => {
    const gate = sceneShader.indexOf("if (flag(materialFlags, 32u)) { return color; }");
    expect(gate).toBeGreaterThan(sceneShader.indexOf("fn deepApplySceneFog"));
    expect(sceneShader).toContain("return deepApplySceneFog(select(color, baseInput, flag(materialFlags, 64u)), world, materialFlags)");
    expect(gate).toBeLessThan(sceneShader.indexOf("deepFog.colorMode.w < 2.5"));
    for (const entry of ["fragmentMain", "fragmentMainColor", "fragmentMainTransparent", "fragmentMainDisplay",
      "fragmentMaterial", "fragmentMaterialColor", "fragmentMaterialTransparent", "fragmentMaterialDisplay"]) {
      const start = sceneShader.indexOf(`@fragment fn ${entry}(`);
      expect(start, entry).toBeGreaterThan(0);
      const body = sceneShader.slice(start, sceneShader.indexOf("\n}", start));
      expect(body, entry).toContain("shade(v.clip.xy");
      expect(body, entry).toContain("v.material.w)");
    }
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("compiles the complete PBR shader with authored fog using Naga", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "deep-fog-pbr.wgsl", "--input-kind", "wgsl"],
      { input: sceneShader, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
