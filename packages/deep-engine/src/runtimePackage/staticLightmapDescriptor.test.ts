import { describe, expect, it } from "vitest";
import { validateRuntimeEnvironment } from "./environment.js";
import { buildDeepRuntimePackage, parseDeepRuntimePackage, runtimeContentSha256 } from "./index.js";

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
  it("survives runtime package build and serialize/parse round-trip", () => {
    const env = base();
    const texture = { id: "scene.lightmap", revision: 1, semantic: "occlusion" as const, width: 1, height: 1,
      data: new Uint8Array([255, 255, 255, 255]) };
    env.staticLightmap = { ...env.staticLightmap, width: 1, height: 1,
      textureHash: { algorithm: "sha256", value: runtimeContentSha256({ ...texture, data: Array.from(texture.data) }) } };
    const geometry = { id: "geo", revision: 1, vertices: new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), uv1: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
    const packet = { geometries: [geometry], materials: [], instances: [], textures: [texture] } as never;
    const value = buildDeepRuntimePackage({ packageId: "lightmap", packageVersion: "1.0.0", renderPacket: { id: "scene", revision: 1, value: packet }, environment: env });
    expect(value.payloads["scene.environment"]).toMatchObject({ staticLightmap: env.staticLightmap });
    expect(parseDeepRuntimePackage(JSON.stringify(value)).valid).toBe(true);
    const mismatched = { ...env, staticLightmap: { ...env.staticLightmap, textureHash: { algorithm: "sha256", value: "b".repeat(64) } } };
    expect(() => buildDeepRuntimePackage({ packageId: "lightmap", packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: packet }, environment: mismatched })).toThrow(/hash does not match/);
    const absent = { ...env, staticLightmap: { ...env.staticLightmap, textureId: "absent" } };
    expect(() => buildDeepRuntimePackage({ packageId: "lightmap", packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: packet }, environment: absent })).toThrow(/missing/);
    const noUv = { ...env, staticLightmap: { ...env.staticLightmap, uvSet: 0 } };
    const noUvGeometry = { ...geometry }; delete (noUvGeometry as { uv0?: Float32Array; uv1?: Float32Array }).uv1;
    expect(() => buildDeepRuntimePackage({ packageId: "lightmap", packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: { ...packet, geometries: [noUvGeometry] } }, environment: noUv })).toThrow(/UV set/);
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
