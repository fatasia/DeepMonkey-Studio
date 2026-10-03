import { describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY_CONTRACT, resolveDisplayGiMode, resolveDisplayGiTemporalAlpha,
  resolveDisplayMsaaSampleCount, resolveDisplayShadowMode } from "./displayContract.js";

describe("display contract", () => {
  it("keeps the product display defaults explicit and immutable", () => {
    expect(DEFAULT_DISPLAY_CONTRACT).toMatchObject({
      toneMapping: {
        operator: "three-aces-r185",
        exposure: 1.05,
        dynamicExposure: { enabled: true, min: 0.55, max: 1.55 },
      },
      outputColorSpace: "srgb",
      environment: { environmentIntensity: 1 },
      shadow: { filter: "pcf", mapSize: 2_048 },
      antialias: { smaa: true, gtao: true },
      bloom: { enabled: false, strength: 0.35, radius: 0.25, threshold: 0.9 },
    });
    expect(Object.isFrozen(DEFAULT_DISPLAY_CONTRACT)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DISPLAY_CONTRACT.toneMapping)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DISPLAY_CONTRACT.toneMapping.dynamicExposure)).toBe(true);
  });

  // B1 Brief-VSM:shadow.mode 缺字段 = 级联(向后兼容),fail-closed 解析单源。
  describe("resolveDisplayShadowMode", () => {
    it("resolves a missing mode field to cascaded (backward compatible default)", () => {
      expect(resolveDisplayShadowMode(DEFAULT_DISPLAY_CONTRACT.shadow)).toBe("cascaded");
      expect(resolveDisplayShadowMode(undefined)).toBe("cascaded");
    });
    it("resolves explicit modes and fails closed on invalid values", () => {
      expect(resolveDisplayShadowMode({ ...DEFAULT_DISPLAY_CONTRACT.shadow, mode: "cascaded" })).toBe("cascaded");
      expect(resolveDisplayShadowMode({ ...DEFAULT_DISPLAY_CONTRACT.shadow, mode: "virtual" })).toBe("virtual");
      expect(resolveDisplayShadowMode({ ...DEFAULT_DISPLAY_CONTRACT.shadow,
        mode: "unknown" as "virtual" })).toBe("cascaded");
    });
  });

  // AA-M1:主 pass MSAA 档缺字段 = 4(引擎默认开,向后兼容旧合同);非法值 fail-closed 回 4。
  describe("resolveDisplayMsaaSampleCount", () => {
    it("resolves a missing msaa field to the engine default 4 (backward compatible)", () => {
      expect(resolveDisplayMsaaSampleCount(undefined)).toBe(4);
      expect(resolveDisplayMsaaSampleCount(DEFAULT_DISPLAY_CONTRACT.antialias)).toBe(4);
    });
    it("resolves explicit values and fails closed on anything outside the 1/4 lattice", () => {
      expect(resolveDisplayMsaaSampleCount({ ...DEFAULT_DISPLAY_CONTRACT.antialias, msaaSampleCount: 1 })).toBe(1);
      expect(resolveDisplayMsaaSampleCount({ ...DEFAULT_DISPLAY_CONTRACT.antialias, msaaSampleCount: 4 })).toBe(4);
      expect(resolveDisplayMsaaSampleCount({ ...DEFAULT_DISPLAY_CONTRACT.antialias,
        msaaSampleCount: 8 as 4 })).toBe(4);
      expect(resolveDisplayMsaaSampleCount({ ...DEFAULT_DISPLAY_CONTRACT.antialias,
        msaaSampleCount: 0 as 4 })).toBe(4);
    });
  });

  // Brief-GI M1:gi 档缺字段 = off(现行为,向后兼容),fail-closed 解析单源。
  describe("resolveDisplayGiMode", () => {
    it("resolves a missing gi field to off (backward compatible default)", () => {
      expect(resolveDisplayGiMode(undefined)).toBe("off");
      expect(resolveDisplayGiMode(DEFAULT_DISPLAY_CONTRACT.gi)).toBe("off");
      expect("gi" in DEFAULT_DISPLAY_CONTRACT).toBe(false);
    });
    it("resolves explicit modes and fails closed on invalid values", () => {
      expect(resolveDisplayGiMode({ mode: "sdf-probe" })).toBe("sdf-probe");
      expect(resolveDisplayGiMode({ mode: "off" })).toBe("off");
      expect(resolveDisplayGiMode({ mode: "lumen" as "sdf-probe" })).toBe("off");
    });
  });

  describe("resolveDisplayGiTemporalAlpha", () => {
    it("defaults to 0.1 and fails closed on out-of-domain values", () => {
      expect(resolveDisplayGiTemporalAlpha(undefined)).toBeCloseTo(0.1, 12);
      expect(resolveDisplayGiTemporalAlpha({})).toBeCloseTo(0.1, 12);
      expect(resolveDisplayGiTemporalAlpha({ temporalAlpha: 0.25 })).toBe(0.25);
      expect(resolveDisplayGiTemporalAlpha({ temporalAlpha: 0 })).toBeCloseTo(0.1, 12);
      expect(resolveDisplayGiTemporalAlpha({ temporalAlpha: 2 })).toBeCloseTo(0.1, 12);
      expect(resolveDisplayGiTemporalAlpha({ temporalAlpha: Number.NaN })).toBeCloseTo(0.1, 12);
    });
  });
});
