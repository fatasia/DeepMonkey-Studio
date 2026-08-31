import { describe, expect, it } from "vitest";
import { normalizeSpatialAudioState } from "./viewerEngineSpatialAudio";

describe("spatial audio state", () => {
  it("normalizes text, playback and attenuation limits", () => {
    expect(normalizeSpatialAudioState({
      enabled: true,
      url: "  /assets/audio/motor.ogg  ",
      name: "  主电机  ",
      autoplay: true,
      loopMode: "once",
      muted: false,
      volume: 4,
      refDistance: -2,
      maxDistance: 0,
      rolloffFactor: 20,
    })).toEqual({
      enabled: true,
      url: "/assets/audio/motor.ogg",
      name: "主电机",
      autoplay: true,
      loopMode: "once",
      muted: false,
      volume: 1,
      refDistance: 0.01,
      maxDistance: 0.01,
      rolloffFactor: 10,
    });
  });
});
