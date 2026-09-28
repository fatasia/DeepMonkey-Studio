import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTENDED_MATERIAL_PARAMETERS, deserializeMaterialParameters, isDefaultExtendedMaterialParameters,
  MATERIAL_PARAMETER_KEYS, MATERIAL_PARAMETER_SCHEMA_VERSION, normalizeAnisotropyRotation,
  normalizeExtendedMaterialParameters, packMaterialParameterArray, serializeMaterialParameters,
  type ExtendedMaterialParameters,
} from "./materialParameters.js";

const SAMPLE: ExtendedMaterialParameters = {
  ior: 1.52,
  clearcoat: { factor: 1, roughness: 0.45 },
  anisotropy: { strength: 0.8, rotation: 0.6 },
  transmission: { factor: 0.25 },
};

describe("extended material parameter schema (T08 slice 1)", () => {
  it("freezes defaults that exactly reproduce the legacy PBR path", () => {
    expect(MATERIAL_PARAMETER_SCHEMA_VERSION).toBe(1);
    expect(isDefaultExtendedMaterialParameters(DEFAULT_EXTENDED_MATERIAL_PARAMETERS)).toBe(true);
    expect(DEFAULT_EXTENDED_MATERIAL_PARAMETERS).toEqual({
      ior: 1.5, clearcoat: { factor: 0, roughness: 0 },
      anisotropy: { strength: 0, rotation: 0 }, transmission: { factor: 0 },
    });
  });

  it("normalizes fields and normalizes rotation into (-pi, pi]", () => {
    const normalized = normalizeExtendedMaterialParameters({
      ...SAMPLE, anisotropy: { strength: 0.8, rotation: 4 * Math.PI + 0.6 },
    });
    expect(normalized.ior).toBe(Math.fround(1.52));
    expect(normalized.anisotropy.rotation).toBe(Math.fround(0.6));
    expect(normalizeAnisotropyRotation(Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(normalizeAnisotropyRotation(-Math.PI - 0.25)).toBeCloseTo(Math.PI - 0.25, 12);
    expect(normalizeAnisotropyRotation(-0)).toBe(0);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it("fails closed on missing, non-finite, or out-of-range fields", () => {
    expect(() => normalizeExtendedMaterialParameters({ ior: 0.9 })).toThrow(RangeError);
    expect(() => normalizeExtendedMaterialParameters({ ior: Number.NaN })).toThrow(RangeError);
    expect(() => normalizeExtendedMaterialParameters({ clearcoat: { factor: -0.1, roughness: 0 } })).toThrow(RangeError);
    expect(() => normalizeExtendedMaterialParameters({ clearcoat: { factor: 0, roughness: 1.1 } })).toThrow(RangeError);
    expect(() => normalizeExtendedMaterialParameters({ anisotropy: { strength: 1.5, rotation: 0 } })).toThrow(RangeError);
    expect(() => normalizeExtendedMaterialParameters({ transmission: { factor: -1 } })).toThrow(RangeError);
    expect(() => normalizeExtendedMaterialParameters({ anisotropy: { strength: 0, rotation: Number.POSITIVE_INFINITY } }))
      .toThrow(RangeError);
  });

  it("round-trips schema → serialized record → schema bit-exactly (float32 semantics)", () => {
    const record = serializeMaterialParameters(SAMPLE);
    expect(Object.keys(record).sort()).toEqual([...MATERIAL_PARAMETER_KEYS].sort());
    const restored = deserializeMaterialParameters(record);
    expect(Object.is(restored.ior, Math.fround(1.52))).toBe(true);
    expect(Object.is(restored.clearcoat.factor, 1)).toBe(true);
    expect(Object.is(restored.clearcoat.roughness, Math.fround(0.45))).toBe(true);
    expect(Object.is(restored.anisotropy.strength, Math.fround(0.8))).toBe(true);
    expect(Object.is(restored.anisotropy.rotation, Math.fround(0.6))).toBe(true);
    expect(Object.is(restored.transmission.factor, Math.fround(0.25))).toBe(true);
    // 深度往返:再次序列化逐键相等(0..1 f32 值无舍入漂移)。
    expect(serializeMaterialParameters(restored)).toEqual(record);
  });

  it("survives float32 lossy values without drift across two round-trips", () => {
    const lossy: ExtendedMaterialParameters = {
      ior: 1.3333333333333333, clearcoat: { factor: 0.1, roughness: 0.9 },
      anisotropy: { strength: 1 / 3, rotation: -2.7 }, transmission: { factor: 0.9 },
    };
    const once = serializeMaterialParameters(lossy);
    const twice = serializeMaterialParameters(deserializeMaterialParameters(once));
    expect(twice).toEqual(once);
    expect(MATERIAL_PARAMETER_KEYS.map((key) => once[key])).toEqual([1.3333333333333333, 0.1, 0.9, 1 / 3, -2.7, 0.9]
      .map((value) => Math.fround(value)));
  });

  it("round-trips rotation wrapping without drift", () => {
    const wrapped = normalizeExtendedMaterialParameters({ anisotropy: { strength: 0, rotation: -3.5 } });
    const record = serializeMaterialParameters(wrapped);
    expect(Object.is(deserializeMaterialParameters(record).anisotropy.rotation, record.anisotropyRotation)).toBe(true);
  });

  it("rejects unknown serialized keys and missing records fail to defaults", () => {
    expect(() => deserializeMaterialParameters({ ...serializeMaterialParameters(SAMPLE), rogue: 1 })).toThrow(RangeError);
    const fromEmpty = deserializeMaterialParameters({});
    expect(isDefaultExtendedMaterialParameters(fromEmpty)).toBe(true);
  });

  it("packs a fixed-order float32 array for the GPU instance layout", () => {
    const packed = packMaterialParameterArray(SAMPLE);
    expect(packed).toEqual([1.52, 1, 0.45, 0.8, 0.6, 0.25].map((value) => Math.fround(value)));
    expect(packMaterialParameterArray(DEFAULT_EXTENDED_MATERIAL_PARAMETERS)).toEqual([1.5, 0, 0, 0, 0, 0]);
  });
});
