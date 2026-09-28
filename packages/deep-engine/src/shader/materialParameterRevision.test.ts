import { describe, expect, it } from "vitest";
import { DEFAULT_EXTENDED_MATERIAL_PARAMETERS } from "./materialParameters.js";
import { compareMaterialParameters, MATERIAL_PARAMETER_RESET_CONTRACT_VERSION,
  materialEvaluationResetPolicy, nextMaterialEvaluationGeneration } from "./materialParameterRevision.js";

const param = (overrides: Partial<Parameters<typeof compareMaterialParameters>[0]>) => ({
  ...DEFAULT_EXTENDED_MATERIAL_PARAMETERS, ...overrides,
});

/** 参数变更 → 求值缓存/累积重置语义(对照 T10「事件→generation 合同」口径)。 */
describe("material parameter reset semantics (T08 GPU slice)", () => {
  it("declares the contract version", () => {
    expect(MATERIAL_PARAMETER_RESET_CONTRACT_VERSION).toBe(1);
  });

  it("treats identical defaults as unchanged: no reset, generation stable", () => {
    const change = compareMaterialParameters(DEFAULT_EXTENDED_MATERIAL_PARAMETERS, param({}));
    expect(change).toEqual({ changed: false, changedKeys: [] });
    expect(materialEvaluationResetPolicy(change)).toEqual({
      resetEvaluationCache: false, resetAccumulation: false, reason: "unchanged" });
    expect(nextMaterialEvaluationGeneration(7, change)).toBe(7);
  });

  it("detects a bit-level change for every one of the six keys", () => {
    const probes: readonly [key: string, next: ReturnType<typeof param>][] = [
      ["ior", param({ ior: 1.5000001 })],
      ["clearcoatFactor", param({ clearcoat: { factor: 0.001, roughness: 0 } })],
      ["clearcoatRoughness", param({ clearcoat: { factor: 0, roughness: 0.001 } })],
      ["anisotropyStrength", param({ anisotropy: { strength: 0.001, rotation: 0 } })],
      ["anisotropyRotation", param({ anisotropy: { strength: 0, rotation: 0.001 } })],
      ["transmissionFactor", param({ transmission: { factor: 0.001 } })],
    ];
    for (const [key, next] of probes) {
      const change = compareMaterialParameters(DEFAULT_EXTENDED_MATERIAL_PARAMETERS, next);
      expect(change.changed, key).toBe(true);
      expect(change.changedKeys, key).toEqual([key]);
      const policy = materialEvaluationResetPolicy(change);
      expect(policy.resetEvaluationCache, key).toBe(true);
      expect(policy.resetAccumulation, key).toBe(true);
      expect(nextMaterialEvaluationGeneration(0, change), key).toBe(1);
    }
  });

  it("lists every drifted key when several change at once", () => {
    const change = compareMaterialParameters(DEFAULT_EXTENDED_MATERIAL_PARAMETERS,
      param({ ior: 2, transmission: { factor: 1 } }));
    expect(change.changedKeys).toEqual(["ior", "transmissionFactor"]);
  });

  it("treats zero and negative zero as equal (no spurious resets)", () => {
    const change = compareMaterialParameters(
      param({ anisotropy: { strength: 0, rotation: -0 } }),
      param({ anisotropy: { strength: 0, rotation: 0 } }));
    expect(change.changed).toBe(false);
  });

  it("keeps generation monotonic only on change and validates the counter", () => {
    const change = compareMaterialParameters(DEFAULT_EXTENDED_MATERIAL_PARAMETERS, param({ ior: 1.6 }));
    expect(nextMaterialEvaluationGeneration(0, change)).toBe(1);
    expect(nextMaterialEvaluationGeneration(41, change)).toBe(42);
    const unchanged = compareMaterialParameters(param({ ior: 1.6 }), param({ ior: 1.6 }));
    expect(nextMaterialEvaluationGeneration(42, unchanged)).toBe(42);
    expect(() => nextMaterialEvaluationGeneration(-1, change)).toThrow(RangeError);
    expect(() => nextMaterialEvaluationGeneration(1.5, change)).toThrow(RangeError);
  });
});
