import { describe, expect, it } from "vitest";
import type { ShaderGraphAssetV1 } from "./graphTypes.js";
import { shaderGraphEdgeKey, validateShaderGraphAsset } from "./graphValidation.js";
import { lowerShaderGraphAsset } from "./lowering.js";
import { ShaderGraphMessageStore } from "./messageStore.js";
import { prepareShaderGraphPreview } from "./preview.js";

function asset(stage: Partial<ShaderGraphAssetV1["stages"][number]> = {}): ShaderGraphAssetV1 {
  return {
    schemaVersion: 1, id: "diag", target: "webgpu-forward", properties: [],
    stages: [{ stage: "vertex", nodes: [], edges: [], outputs: [], ...stage }],
  };
}

describe("shader graph diagnostics attribution (P2)", () => {
  it("attributes unknown and duplicate nodes to their node id", () => {
    const result = validateShaderGraphAsset(asset({
      nodes: [
        { id: "a", op: "literal", type: "f32" }, { id: "a", op: "literal", type: "f32" },
        { id: "b", op: "no-such-op", type: "f32" } as never,
      ],
    }));
    const codes = new Map(result.diagnostics.map(d => [d.code, d]));
    expect(codes.get("duplicate-node")?.nodeId).toBe("a");
    expect(codes.get("unknown-node")?.nodeId).toBe("b");
    expect(result.valid).toBe(false);
  });

  it("attributes missing edges by edge key and flags duplicated input slots", () => {
    const result = validateShaderGraphAsset(asset({
      nodes: [{ id: "a", op: "literal", type: "f32" }, { id: "add", op: "add", type: "f32" }],
      edges: [
        { from: "ghost", to: "add", input: 0 },
        { from: "a", to: "add", input: 1 }, { from: "a", to: "add", input: 1 },
      ],
    }));
    const missing = result.diagnostics.find(d => d.code === "missing-edge");
    const duplicate = result.diagnostics.find(d => d.code === "duplicate-edge");
    expect(missing?.edgeKey).toBe("add#0");
    expect(duplicate).toMatchObject({ edgeKey: "add#1", nodeId: "add" });
    expect(result.valid).toBe(false);
  });

  it("reports incomplete inputs as warnings so drafts keep loading, with node attribution", () => {
    const result = validateShaderGraphAsset(asset({
      nodes: [
        { id: "a", op: "literal", type: "f32" }, { id: "b", op: "literal", type: "f32" },
        { id: "half", op: "add", type: "f32" }, { id: "mixer", op: "mix", type: "vec3f" },
      ],
      edges: [{ from: "a", to: "half", input: 0 }, { from: "a", to: "mixer", input: 0 },
        { from: "b", to: "mixer", input: 1 }, { from: "a", to: "mixer", input: 2 }, { from: "b", to: "mixer", input: 3 }],
    }));
    expect(result.valid).toBe(true);
    const missing = result.diagnostics.filter(d => d.code === "missing-input");
    const extra = result.diagnostics.filter(d => d.code === "extra-input");
    expect(missing.map(d => d.nodeId)).toEqual(["half"]);
    expect(missing[0]?.message).toContain("expects 2 inputs, 1 connected");
    expect(extra.map(d => d.nodeId)).toEqual(["mixer"]);
    expect(extra[0]?.message).toContain("expects 3 inputs, 4 connected");
  });

  it("flags dangling output references including surface fields and alpha clip", () => {
    const result = validateShaderGraphAsset(asset({
      stage: "fragment",
      nodes: [{ id: "a", op: "literal", type: "f32" }],
      outputs: [
        { semantic: "color", node: "ghost" },
        { semantic: "surface", model: "standard-pbr", context: "deep-lighting-v1",
          fields: { baseColor: "phantom", roughness: "a" } },
        { semantic: "alpha-clip", alpha: "gone", cutoff: "a" },
      ],
    }));
    const dangling = result.diagnostics.filter(d => d.code === "dangling-output");
    expect(dangling.map(d => d.path)).toEqual([
      "stages[0].outputs[0]", "stages[0].outputs[1].fields.baseColor", "stages[0].outputs[2].alpha",
    ]);
    expect(result.valid).toBe(false);
  });

  it("lowers incomplete graphs to a precise per-node failure instead of a tuple throw", () => {
    const result = lowerShaderGraphAsset(asset({
      nodes: [{ id: "solo", op: "smoothstep", type: "f32" }],
      outputs: [],
    }));
    expect(result.success).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: "missing-input", nodeId: "solo",
      message: expect.stringContaining("expects 3 inputs, 0 connected") });
  });

  it("propagates node attribution through the preview contract into the message store", () => {
    const graph = asset({
      stage: "fragment",
      nodes: [{ id: "lonely", op: "one-minus", type: "vec3f" }],
      outputs: [{ semantic: "color", node: "lonely" }],
    });
    const store = new ShaderGraphMessageStore();
    const preview = prepareShaderGraphPreview({ graph, capabilities: {
      features: [], limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 },
    } }, store);
    expect(preview.success).toBe(false);
    expect(preview.diagnostics[0]).toMatchObject({ provider: "lowering", nodeId: "lonely" });
    expect(store.forNode("lonely")).toHaveLength(1);
  });

  it("keeps edge keys stable across the canvas-facing helper", () => {
    expect(shaderGraphEdgeKey("add-1", 2)).toBe("add-1#2");
    expect(shaderGraphEdgeKey("add-1", undefined)).toBe("add-1#0");
  });
});
