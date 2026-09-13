import { describe, expect, it } from "vitest";
import type { ModelProcessingRecord, ModelRecord } from "@bim-studio/contracts";
import { applyOptimizationPreset, assessModelQuality, modelVersionChain, readProcessingRecipe } from "./modelEngineering";
import type { ModelOptimizationOptions } from "./modelOptimizer";

const options: ModelOptimizationOptions = { simplifyEnabled: true, simplifyRatio: .5, simplifyError: .001, dracoEnabled: true, textureEnabled: true, textureSize: 2048, textureFormat: "webp", bakeEnabled: false, bakeMode: "vertex", bakeStrength: .35, bakeAmbient: .28, bakeAmbientColor: "#ffffff", bakeLights: [], lightmapResolution: 512, lightmapAmbientOcclusion: true, lightmapAoSamples: 4, lightmapShadows: true, lightmapShadowSamples: 4, lightmapIndirectSamples: 2, lightmapDenoise: true, origin: "ground", removeUnused: true };
const recipe = (patch: object = {}) => ({ optionsJson: JSON.stringify({ ...options, ...patch }), layerEditsJson: JSON.stringify([{ id: 0, action: "rename", name: "泵" }]) }) as ModelProcessingRecord;
describe("model engineering", () => {
  it("preserves hierarchy and pivot when selecting device presets", () => {
    for (const id of ["detail", "balanced", "mobile"] as const) {
      const result = applyOptimizationPreset(options, id);
      expect(result.removeUnused).toBe(false); expect(result.origin).toBe("keep");
    }
    expect(applyOptimizationPreset(options, "mobile").textureSize).toBe(1024);
    expect(applyOptimizationPreset(options, "mobile").textureFormat).toBe("ktx2-etc1s");
    expect(applyOptimizationPreset(options, "detail").textureFormat).toBe("ktx2-uastc");
  });
  it("distinguishes empty geometry, over-budget, measured and incomplete assets", () => {
    expect(assessModelQuality({ triangles: 0 }, "detail").status).toBe("blocked");
    expect(assessModelQuality({ triangles: 100_001, materials: 1, bytes: 1 }, "mobile").status).toBe("warning");
    expect(assessModelQuality({ triangles: 1000, materials: 1, bytes: 1 }, "mobile").status).toBe("ready");
    expect(assessModelQuality({ bytes: 1 }, "mobile").status).toBe("unknown");
  });
  it("follows actual immutable ancestry and terminates malformed cycles", () => {
    const a = { id: "a" } as ModelRecord;
    const b = { id: "b", optimization: { sourceModelId: "a" } } as ModelRecord;
    const c = { id: "c", generation: { supersedesModelId: "b" } } as ModelRecord;
    expect(modelVersionChain(c, [a, b, c]).map(item => item.id)).toEqual(["a", "b", "c"]);
    expect(modelVersionChain(c, [b, c]).map(item => item.id)).toEqual(["b", "c"]);
    expect(modelVersionChain({ ...a, optimization: { sourceModelId: "a" } } as ModelRecord, [a])).toHaveLength(1);
  });
  it("restores recorded controls and layer operations, rejecting unsafe work sizes", () => {
    expect(readProcessingRecipe(recipe(), options)).toEqual({ options, edits: [{ id: 0, action: "rename", name: "泵" }] });
    for (const patch of [{ textureSize: 100_000 }, { simplifyRatio: -1 }, { lightmapResolution: 8192 }, { bakeLights: Array(9).fill({}) }, { command: "run" }]) expect(() => readProcessingRecipe(recipe(patch), options)).toThrow();
    expect(() => readProcessingRecipe({ ...recipe(), layerEditsJson: '[{"id":-1,"action":"delete"}]' }, options)).toThrow();
  });
});
