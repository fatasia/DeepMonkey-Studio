import { describe, expect, it } from "vitest";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import {
  assertTextureArrayProductionReady,
  TEXTURE_ARRAY_PRODUCTION_BLOCKERS,
} from "./textureArrayProductionGate.js";

describe("texture array production gate", () => {
  it("keeps the established production PBR path unchanged when the feature is off", () => {
    expect(() => assertTextureArrayProductionReady(resolvePbrRendererFeatures())).not.toThrow();
  });

  it("admits the opt-in after the packet consumer and paired fallback variants are wired", () => {
    expect(TEXTURE_ARRAY_PRODUCTION_BLOCKERS).toEqual([]);
    expect(() => assertTextureArrayProductionReady(
      resolvePbrRendererFeatures({ textureArrays: true }),
    )).not.toThrow();
  });
});
