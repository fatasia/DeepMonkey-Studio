import { describe, expect, it } from "vitest";
import { lowerShaderGraphAsset } from "./lowering.js";
import type { ShaderGraphAssetV1 } from "./graphTypes.js";

const graph = (edges: readonly { from: string; to: string; input?: number }[] = []): ShaderGraphAssetV1 => ({
  schemaVersion: 1, id: "lowering", target: "webgpu-forward", properties: [],
  stages: [{ stage: "vertex", nodes: [
    { id: "position", op: "attribute", type: "vec3f", config: { name: "position" } },
    { id: "one", op: "literal", type: "f32", config: { value: 1 } },
    { id: "clip", op: "compose-vec4", type: "vec4f" },
  ], edges, outputs: [{ semantic: "position", node: "clip" }] }],
});

describe("shader graph lowering", () => {
  it("lowers editor nodes to the existing ShaderStageGraph IR in deterministic order", () => {
    const result = lowerShaderGraphAsset(graph([
      { from: "position", to: "clip", input: 0 }, { from: "one", to: "clip", input: 1 },
    ]));
    expect(result.success).toBe(true);
    expect(result.stages![0]!.nodes.map(node => node.id)).toEqual(["one", "position", "clip"]);
    expect(result.stages![0]!.outputs).toEqual([{ semantic: "position", node: "clip" }]);
    expect(result.stages![0]!.nodes[2]).toMatchObject({ op: "compose-vec4", inputs: ["position", "one"] });
  });

  it("rejects cycles before reaching the WGSL compiler", () => {
    const result = lowerShaderGraphAsset(graph([{ from: "clip", to: "position", input: 0 }, { from: "position", to: "clip", input: 0 }]));
    expect(result.success).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ code: "cycle" });
  });

  it("keeps graph validation diagnostics instead of throwing on missing nodes", () => {
    const result = lowerShaderGraphAsset(graph([{ from: "missing", to: "clip", input: 0 }]));
    expect(result.success).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ code: "missing-edge" });
  });
});
