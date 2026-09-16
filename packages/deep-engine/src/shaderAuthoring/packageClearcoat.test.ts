import { describe, expect, it } from "vitest";
import { inspectDeepSlSurface } from "./deepSlParser.js";
import { adaptDeepSlStandardToShaderPackage } from "./packageAdapter.js";
import { OPAQUE, packageRequest } from "./packageAdapter.testFixture.js";
import { evaluateClearcoatReference } from "./packageClearcoat.js";

function withClearcoat(factor: string, roughness: string): string {
  return OPAQUE.replace("metallic 0.65;",
    `metallic 0.65;\n  clearcoatFactor ${factor};\n  clearcoatRoughness ${roughness};`);
}

function adapt(source: string, targetAbi: "deep.pbr.mesh.v1" | "deep.pbr.mesh.v2" | "deep.pbr.mesh.v3" = "deep.pbr.mesh.v3") {
  return adaptDeepSlStandardToShaderPackage({ ...packageRequest(source), targetAbi });
}

describe("DeepSL Standard clearcoat scalar v3", () => {
  it("parses a bounded typed model and rejects every non-unit scalar", () => {
    expect(inspectDeepSlSurface(withClearcoat("0.75", "0.2"))).toMatchObject({
      success: true, model: { clearcoatFactor: 0.75, clearcoatRoughness: 0.2 },
    });
    for (const [field, value] of [["clearcoatFactor", "-0.01"], ["clearcoatFactor", "1.01"],
      ["clearcoatRoughness", "Infinity"], ["clearcoatRoughness", "NaN"]]) {
      const source = OPAQUE.replace("metallic 0.65;", `metallic 0.65;\n  ${field} ${value};`);
      expect(inspectDeepSlSurface(source)).toMatchObject({ success: false,
        diagnostics: [expect.objectContaining({ code: expect.stringMatching(/invalid-number|out-of-range/u) })] });
    }
  });

  it("keeps factor-zero packages byte-equivalent and confines declarations to v3", () => {
    const implicit = adapt(OPAQUE), explicit = adapt(withClearcoat("0", "0.8"));
    expect(implicit.success && explicit.success).toBe(true);
    if (!implicit.success || !explicit.success) return;
    expect(explicit.package.modules).toEqual(implicit.package.modules);
    expect(explicit.package.packageCacheKey).toBe(implicit.package.packageCacheKey);
    expect(explicit.package.modules[0]!.source).not.toContain("deepClearcoatDirectSpecular");
    expect(explicit.report.clearcoat).toEqual({ factor: 0, roughness: 0.8, source: "compile-time-v3" });
    for (const targetAbi of ["deep.pbr.mesh.v1", "deep.pbr.mesh.v2"] as const) {
      expect(adapt(withClearcoat("0.5", "0.2"), targetAbi)).toMatchObject({ success: false,
        report: { issues: [{ code: "unsupported-capability", path: "$.source.clearcoatFactor" }] } });
    }
  });

  it("layers finite energy-conserving direct and IBL terms", () => {
    const neutral = evaluateClearcoatReference({ factor: 0, roughness: 0,
      nDotL: 0.7, nDotV: 0.8, nDotH: 0.9, vDotH: 0.85, dfg: [0.6, 0.2] });
    expect(neutral).toEqual({ directBaseAttenuation: 1, directLobe: 0,
      iblBaseAttenuation: 1, iblLobe: 0 });
    const coated = evaluateClearcoatReference({ factor: 0.75, roughness: 0.2,
      nDotL: 0.7, nDotV: 0.8, nDotH: 0.9, vDotH: 0.85, dfg: [0.6, 0.2] });
    expect(coated.directBaseAttenuation).toBeGreaterThanOrEqual(0);
    expect(coated.directBaseAttenuation).toBeLessThan(1);
    expect(coated.iblBaseAttenuation).toBeGreaterThanOrEqual(0);
    expect(coated.iblBaseAttenuation).toBeLessThan(1);
    expect(coated.directLobe).toBeGreaterThan(0);
    expect(coated.iblLobe).toBeGreaterThan(0);
    expect(Object.values(coated).every(Number.isFinite)).toBe(true);
    expect(() => evaluateClearcoatReference({ factor: 2, roughness: 0,
      nDotL: 1, nDotV: 1, nDotH: 1, vDotH: 1, dfg: [1, 0] })).toThrow(RangeError);
  });

  it("emits the second GGX lobe for direct and prefiltered IBL", () => {
    const result = adapt(withClearcoat("0.75", "0.2"));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.report.clearcoat).toEqual({ factor: 0.75, roughness: 0.2, source: "compile-time-v3" });
    const wgsl = result.package.modules[0]!.source;
    expect(wgsl).toContain("deepDistributionGgx(nDotH, deepClearcoatRoughness)");
    expect(wgsl).toContain("(diffuse + specular) * deepClearcoatDirectAttenuation");
    expect(wgsl).toContain("reflection, deepClearcoatRoughness * maxSpecularLod");
    expect(wgsl).toContain("deepLayeredIndirect");
  });
});
