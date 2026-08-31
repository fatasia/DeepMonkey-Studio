import { describe, expect, it } from "vitest";
import { DEFAULT_ENVIRONMENT, DEFAULT_LIGHTING, DEFAULT_POST_PROCESSING } from "../appDefaults";
import { applySceneEnvironmentPreset, SCENE_ENVIRONMENT_PRESETS } from "./sceneEnvironmentPresets";

describe("scene environment presets", () => {
  it("ships a useful offline catalog without duplicate identities", () => {
    expect(SCENE_ENVIRONMENT_PRESETS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(SCENE_ENVIRONMENT_PRESETS.map((item) => item.id)).size).toBe(SCENE_ENVIRONMENT_PRESETS.length);
    expect(new Set(SCENE_ENVIRONMENT_PRESETS.map((item) => item.family))).toEqual(new Set(["indoor", "outdoor", "night", "weather"]));
  });

  it("applies a complete quality baseline while retaining an uploaded environment map", () => {
    const result = applySceneEnvironmentPreset(SCENE_ENVIRONMENT_PRESETS[0]!, {
      environment: { ...DEFAULT_ENVIRONMENT, environmentMapUrl: "/asset/workshop.hdr", environmentMapName: "workshop.hdr" },
      lighting: DEFAULT_LIGHTING,
      postProcessing: DEFAULT_POST_PROCESSING
    });

    expect(result.environment.environmentMapUrl).toBe("/asset/workshop.hdr");
    expect(result.lighting).toEqual(expect.objectContaining({ shadowsEnabled: true, reflectionsEnabled: true, globalIlluminationEnabled: true }));
    expect(result.postProcessing).toEqual(expect.objectContaining({ enabled: true, smaa: true, gtao: true }));
  });
});
