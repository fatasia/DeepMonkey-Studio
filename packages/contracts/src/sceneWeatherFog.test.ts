import { describe, expect, it } from "vitest";
import { SCENE_WEATHER_FOG_VERSION, isParticleFreeWeather, sceneWeatherFog } from "./sceneWeatherFog.js";
import type { WeatherMode } from "./scene.js";

/** 冻结值与 viewerEngineRig 既有 FogExp2 字面量逐位一致；改值必须升合同版本。 */
const FROZEN_RIG_LITERALS: Readonly<Record<WeatherMode, readonly [number, number]>> = {
  sunny: [0x9fc2d4, 0.0018],
  cloudy: [0x87939a, 0.0042],
  rain: [0x64717a, 0.008],
  snow: [0xc5cdd1, 0.006],
  fog: [0xaab4b7, 0.018],
  storm: [0x38454f, 0.012],
};

const ALL_WEATHERS: readonly WeatherMode[] = ["sunny", "cloudy", "rain", "snow", "fog", "storm"];

describe("scene weather fog contract v1", () => {
  it("freezes every weather mode to the rig's existing FogExp2 literals", () => {
    for (const mode of ALL_WEATHERS) {
      const fog = sceneWeatherFog(mode);
      expect(fog.version).toBe(SCENE_WEATHER_FOG_VERSION);
      expect(fog.kind).toBe("exp2");
      expect(parseInt(fog.colorSrgbHex.slice(1), 16)).toBe(FROZEN_RIG_LITERALS[mode][0]);
      expect(fog.colorSrgbHex).toMatch(/^#[0-9a-f]{6}$/);
      expect(fog.density).toBe(FROZEN_RIG_LITERALS[mode][1]);
      expect(fog.density).toBeGreaterThan(0);
    }
  });

  it("classifies particle-free weathers for offline compilation", () => {
    expect(ALL_WEATHERS.filter(isParticleFreeWeather)).toEqual(["sunny", "cloudy", "fog"]);
    expect(ALL_WEATHERS.filter(mode => !isParticleFreeWeather(mode))).toEqual(["rain", "snow", "storm"]);
  });
});
