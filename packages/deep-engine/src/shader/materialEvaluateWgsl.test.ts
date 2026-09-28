import { describe, expect, it } from "vitest";
import { DEFAULT_EXTENDED_MATERIAL_PARAMETERS, MATERIAL_PARAMETER_KEYS } from "./materialParameters.js";
import { GOLDEN_EXPECTED, GOLDEN_SWATCHES, GOLDEN_VIEW_DIRECTIONS } from "./materialGoldens.js";
import { assertIorAbiAlignment, EXTENDED_PARAMETER_FLOAT_COUNT, EXTENDED_PARAMETER_INSTANCE_EMBEDDING,
  EXTENDED_PARAMETER_STRIDE_BYTES, EXTENDED_PARAMETER_WGSL_STRUCT, expectedV5InstanceIorSlot,
  packExtendedParameterBlock } from "./materialParameterAbi.js";
import { EXTENDED_MATERIAL_EVALUATION_WGSL } from "./materialEvaluateWgsl.js";

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** WGSL 求值核与 CPU 参考的镜像契约:结构、常量、命名隔离逐项钉死。 */
describe("extended material WGSL evaluation kernel (T08 GPU slice)", () => {
  it("is a function library: no compute entry point, balanced braces", () => {
    expect(EXTENDED_MATERIAL_EVALUATION_WGSL).not.toContain("@compute");
    expect(EXTENDED_MATERIAL_EVALUATION_WGSL).toContain(
      "fn deepEvaluateExtendedMaterial(baseColorIn: vec3f, metallicIn: f32, roughnessIn: f32,");
    const opens = countOccurrences(EXTENDED_MATERIAL_EVALUATION_WGSL, "{");
    const closes = countOccurrences(EXTENDED_MATERIAL_EVALUATION_WGSL, "}");
    expect(opens).toBe(closes);
  });

  it("embeds the ABI struct verbatim from its single source", () => {
    expect(countOccurrences(EXTENDED_MATERIAL_EVALUATION_WGSL, EXTENDED_PARAMETER_WGSL_STRUCT)).toBe(1);
    for (const key of MATERIAL_PARAMETER_KEYS) {
      expect(EXTENDED_PARAMETER_WGSL_STRUCT).toContain(key);
    }
  });

  it("mirrors the CPU reference constants exactly", () => {
    const kernel = EXTENDED_MATERIAL_EVALUATION_WGSL;
    expect(kernel).toContain("clamp(roughnessIn, 0.045, 1.0)"); // CPU ROUGHNESS_FLOOR
    expect(kernel).toContain("clamp(dot(normal, view), 0.0001, 1.0)"); // nDotV 下限 1e-4
    expect(kernel).toContain("max(DEEP_MATERIAL_PI * denominator * denominator, 0.000001)"); // GGX 1e-6
    expect(kernel).toContain("max(DEEP_MATERIAL_PI * ax * ay * d * d, 0.000000000001)"); // aniso 1e-12
    expect(kernel).toContain("max(alpha * (1.0 + strength), 0.001)"); // Burley ax/ay 下限
    expect(kernel).toContain("let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;"); // Smith k
    expect(kernel).toContain("0.04 + 0.96 * pow(1.0 - clamp(vDotHIn, 0.0, 1.0), 5.0)"); // coat F0=0.04
    expect(kernel).toContain("params.anisotropyStrength != 0.0"); // 与 CPU 严格零判定一致
    expect(kernel).toContain("deepDielectricF0(params.ior)"); // 复用既有 dielectricF0 WGSL
  });

  it("does not collide with the stock surface lowering namespace", () => {
    const names = [...EXTENDED_MATERIAL_EVALUATION_WGSL.matchAll(/^fn (\w+)/gmu)].map((match) => match[1]!);
    expect(names.length).toBeGreaterThan(6);
    for (const name of names) expect(name.startsWith("deep")).toBe(true);
    const stockNames = ["deepSafeNormalize", "deepFresnelSchlick", "deepDistributionGgx",
      "deepGeometrySchlickGgx", "deepShadowVisibility", "deepLowerStandardPbr"];
    for (const stock of stockNames) expect(names).not.toContain(stock);
  });
});

describe("extended parameter ABI (T08 GPU slice)", () => {
  it("declares the 6-float block with a 24-byte stride matching MATERIAL_PARAMETER_KEYS", () => {
    expect(EXTENDED_PARAMETER_FLOAT_COUNT).toBe(6);
    expect(MATERIAL_PARAMETER_KEYS).toHaveLength(EXTENDED_PARAMETER_FLOAT_COUNT);
    expect(EXTENDED_PARAMETER_STRIDE_BYTES).toBe(24);
    expect(EXTENDED_PARAMETER_INSTANCE_EMBEDDING).toBe("requires-abi-revision-v6");
  });

  it("packs in canonical key order with float32 semantics", () => {
    const params = { ...DEFAULT_EXTENDED_MATERIAL_PARAMETERS,
      ior: 1.52,
      clearcoat: { factor: 0.7, roughness: 0.3 },
      anisotropy: { strength: 0.4, rotation: -1.2 },
      transmission: { factor: 0.9 } };
    const block = packExtendedParameterBlock(params);
    const fround = Math.fround;
    expect([...block]).toEqual([fround(1.52), fround(0.7), fround(0.3), fround(0.4), fround(-1.2), fround(0.9)]);
    expect([...block]).not.toEqual([1.52, 0.7, 0.3, 0.4, -1.2, 0.9]); // 证明确实是 f32 舍入,不是 f64 透传
  });

  it("keeps v5 instance IOR slot aligned: 1.5 → sentinel 0, otherwise fround(ior)", () => {
    expect(expectedV5InstanceIorSlot(DEFAULT_EXTENDED_MATERIAL_PARAMETERS)).toBe(0);
    const instance = new Array<number>(36).fill(0);
    const nonDefault = { ...DEFAULT_EXTENDED_MATERIAL_PARAMETERS, ior: 1.52 };
    instance[15] = expectedV5InstanceIorSlot(nonDefault);
    expect(() => assertIorAbiAlignment(nonDefault, instance)).not.toThrow();
    expect(() => assertIorAbiAlignment(DEFAULT_EXTENDED_MATERIAL_PARAMETERS, instance)).toThrow(/slot mismatch/u);
    instance[15] = 1.52;
    expect(() => assertIorAbiAlignment(nonDefault, instance)).not.toThrow();
    instance[15] = 1.53;
    expect(() => assertIorAbiAlignment(nonDefault, instance)).toThrow(/slot mismatch/u);
  });

  it("keeps the frozen golden table at 42 rows", () => {
    expect(GOLDEN_EXPECTED).toHaveLength(GOLDEN_SWATCHES.length * GOLDEN_VIEW_DIRECTIONS.length);
    expect(GOLDEN_SWATCHES).toHaveLength(14);
  });
});
