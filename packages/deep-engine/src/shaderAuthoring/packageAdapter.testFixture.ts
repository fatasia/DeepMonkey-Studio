import { TEST_CAPABILITIES } from "./testFixture.js";

export function packageRequest(source: string): Record<string, unknown> {
  return {
    schemaVersion: 1, source, packageVersion: "1.0.0", compilerVersion: "1.0.0",
    capabilities: TEST_CAPABILITIES,
  };
}

export const OPAQUE = `shader deep.package {
  surface standard;
  baseColor [0.12, 0.42, 0.9, 0.8];
  metallic 0.65;
  roughness 0.24;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}`;

export const ALL_TEXTURES = OPAQUE
  .replace("baseColorTexture off", `baseColorTexture on;
  metallicRoughnessTexture on;
  normalTexture on;
  occlusionTexture on;
  emissiveTexture on`);
