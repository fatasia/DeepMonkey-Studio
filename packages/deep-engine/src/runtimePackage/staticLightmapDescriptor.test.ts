import { describe, expect, it } from "vitest";
import { validateRuntimeEnvironment } from "./environment.js";

describe("static lightmap runtime descriptor", () => {
  const base = () => ({ schema: "deep-engine.solid-environment", schemaVersion: 8,
    id: "scene.environment", revision: 1, kind: "solid-background-builtin-ibl",
    backgroundSrgb: [0, 0, 0], outputTransform: "native-aces-studio-v8",
    staticLightmap: { schema: "deep-engine.static-lightmap", schemaVersion: 1,
      textureId: "scene.lightmap", textureHash: { algorithm: "sha256", value: "a".repeat(64) },
      uvSet: 1, colorSpace: "linear", intensity: 1, width: 512, height: 512 } });
  it("accepts a validated descriptor without changing legacy environment identity", () => {
    expect(() => validateRuntimeEnvironment(base(), "scene.environment", 1, "$.environment")).not.toThrow();
  });
  it("rejects invalid hash, UV set and dimensions fail-closed", () => {
    for (const patch of [
      { textureHash: { algorithm: "sha256", value: "bad" } },
      { uvSet: 2 }, { width: 0 }, { height: 20_000 }, { intensity: -1 },
    ]) {
      const value = base(); value.staticLightmap = { ...value.staticLightmap, ...patch };
      expect(() => validateRuntimeEnvironment(value, "scene.environment", 1, "$.environment")).toThrow();
    }
  });
});
