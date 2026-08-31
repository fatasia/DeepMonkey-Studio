import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA_CONSTRAINTS,
  DEFAULT_BRANDING,
  DEFAULT_ENVIRONMENT,
  DEFAULT_LIGHTING,
  DEFAULT_POST_PROCESSING,
  normalizeCameraConstraints
} from "./appDefaults";

describe("app defaults", () => {
  it("uses a neutral first-party product name in user-visible defaults", () => {
    expect(DEFAULT_BRANDING.systemName).toBe("Industrial Studio");
    expect(DEFAULT_BRANDING.browserTitle).toBe("Industrial Studio");
  });

  it("repairs invalid persisted camera ranges without discarding valid settings", () => {
    expect(normalizeCameraConstraints({
      ...DEFAULT_CAMERA_CONSTRAINTS,
      minDistance: 20,
      maxDistance: 10,
      minPolarAngle: 200,
      maxPolarAngle: -1,
      nearClip: Number.NaN,
      farClip: 0,
      collisionRadius: -1,
      collisionEnabled: false
    })).toEqual(expect.objectContaining({
      minDistance: 20,
      maxDistance: 20.01,
      minPolarAngle: 179,
      maxPolarAngle: 179.1,
      nearClip: DEFAULT_CAMERA_CONSTRAINTS.nearClip,
      collisionRadius: 0.02,
      collisionEnabled: false
    }));
  });

  it("provides a restrained industrial visual baseline without decorative effects", () => {
    expect(DEFAULT_ENVIRONMENT.skybox).toBe("studio");
    expect(DEFAULT_LIGHTING).toEqual(expect.objectContaining({
      shadowsEnabled: true,
      reflectionsEnabled: true,
      globalIlluminationEnabled: true
    }));
    expect(DEFAULT_POST_PROCESSING).toEqual(expect.objectContaining({
      enabled: true,
      smaa: true,
      gtao: true,
      bloom: false,
      depthOfField: false,
      filmGrain: false,
      afterimage: false
    }));
  });
});
