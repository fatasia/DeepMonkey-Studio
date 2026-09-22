import { describe, expect, it } from "vitest";
import { staticLightmapDescriptorFromExtras } from "./staticLightmapAdapter.js";
import { validateRuntimeStaticLightmapBinding } from "./environment.js";

const extras = {
  mode: "occlusion+chroma-emissive", texCoord: 1, resolution: 256,
  shadows: true, softShadowSamples: 4, indirectSamples: 2,
  indirectMethod: "single-bounce-diffuse", ambientOcclusion: true, denoise: true,
  colored: true, preservesBaseColor: true, uvAtlas: "projected-fallback",
};
const texture = { id: "model.lightmap", semantic: "occlusion" as const, width: 256, height: 256,
  data: Array.from({ length: 64 }, (_, index) => index % 256) };

describe("bimStudioLightmap extras → runtime descriptor adapter", () => {
  it("produces a descriptor that passes runtime binding validation", () => {
    const descriptor = staticLightmapDescriptorFromExtras({ extras, texture });
    const environment = { schema: "deep-engine.solid-environment", schemaVersion: 8,
      id: "scene.environment", revision: 1, kind: "solid-background-builtin-ibl",
      backgroundSrgb: [0, 0, 0], outputTransform: "native-aces-studio-v8", staticLightmap: descriptor };
    const uv1 = [0, 0, 1, 0, 1, 1, 0, 1];
    const packet = { geometries: [{ id: "g", revision: 0, uv1 }],
      materials: [], instances: [],
      textures: [{ ...texture, data: texture.data, revision: 1 }] };
    expect(() => validateRuntimeStaticLightmapBinding(environment, packet)).not.toThrow();
  });
  it("rejects unsupported mode and mismatched resolution fail-closed", () => {
    expect(() => staticLightmapDescriptorFromExtras({ extras: { ...extras, mode: "emissive-only" }, texture }))
      .toThrow(/unsupported-mode/);
    const mismatched = { ...texture, width: 128 };
    expect(() => staticLightmapDescriptorFromExtras({ extras, texture: mismatched }))
      .toThrow(/invalid-resolution/);
  });
});
