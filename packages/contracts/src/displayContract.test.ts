import { describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY_CONTRACT } from "./displayContract.js";

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
});
