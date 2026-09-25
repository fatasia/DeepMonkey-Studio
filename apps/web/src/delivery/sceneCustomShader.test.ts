import { describe, expect, it } from "vitest";
import { inspectSceneCustomShader } from "./sceneCustomShader";

const SOURCE = `shader deep.material {
  surface standard;
  baseColor [0.12, 0.42, 0.9, 1];
  metallic 0.65;
  roughness 0.24;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}`;

describe("scene custom shader authoring", () => {
  it("returns executable package evidence and deterministic pass keys", () => {
    const first = inspectSceneCustomShader(SOURCE);
    const second = inspectSceneCustomShader(SOURCE);
    expect(first.success).toBe(true);
    expect(second).toEqual(first);
    if (first.success) {
      expect(first.shader.shaderAbi.id).toBe("deep.pbr.mesh.v2");
      expect(first.cacheKeys.length).toBeGreaterThan(0);
    }
  });

  it("fails closed on invalid DeepSL instead of emitting a preview", () => {
    const result = inspectSceneCustomShader("shader broken { surface standard;");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
