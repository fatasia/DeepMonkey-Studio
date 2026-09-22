import { describe, expect, it } from "vitest";
import { canonicalShaderGraphJson, cloneCanonicalShaderGraph, shaderGraphHash } from "./graphSerialization.js";
import { shaderGraphNodeMetadata, shaderGraphNodeRegistry } from "./nodeRegistry.js";
import { validateShaderGraphAsset } from "./graphValidation.js";
import type { ShaderGraphAssetV1 } from "./graphTypes.js";

function asset(): ShaderGraphAssetV1 {
  return { schemaVersion: 1, id: "asset-a", label: "Surface", target: "webgpu-forward", properties: [],
    stages: [{ stage: "vertex", nodes: [
      { id: "position", op: "attribute", type: "vec3f" },
      { id: "one", op: "literal", type: "f32", config: { value: 1 } },
    ], edges: [], outputs: [{ semantic: "position", node: "position" }] }],
    dependencies: [] };
}

describe("WGSL-first shader graph S1 contract", () => {
  it("canonicalizes key order and round-trips without editor-only mutation", () => {
    const first = asset();
    const second = { ...first, stages: first.stages.map(stage => ({ ...stage,
      nodes: [...stage.nodes].reverse() })) };
    expect(canonicalShaderGraphJson(first)).not.toBe(canonicalShaderGraphJson(second));
    expect(shaderGraphHash(first)).toBe(shaderGraphHash(cloneCanonicalShaderGraph(first)));
    expect(cloneCanonicalShaderGraph(first)).toEqual(first);
  });

  it("exposes a registry descriptor for every supported node op", () => {
    expect(shaderGraphNodeRegistry().length).toBeGreaterThan(10);
    expect(shaderGraphNodeMetadata("texture-sample")).toMatchObject({ category: "texture", stages: ["fragment"] });
    expect(shaderGraphNodeMetadata("not-a-node" as never)).toBeUndefined();
  });

  it("rejects duplicate nodes, missing edges and stage-incompatible nodes", () => {
    const invalid = { ...asset(), stages: [{ stage: "fragment" as const,
      nodes: [{ id: "same", op: "literal" as const, type: "f32" as const },
        { id: "same", op: "literal" as const, type: "f32" as const },
        { id: "bad", op: "attribute" as const, type: "vec3f" as const }],
      edges: [{ from: "same", to: "missing" }], outputs: [] }] };
    const result = validateShaderGraphAsset(invalid);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      "duplicate-node", "unknown-node", "missing-edge",
    ]);
  });

  it("accepts a valid multi-stage graph and remains bounded for 100 nodes", () => {
    const nodes = Array.from({ length: 100 }, (_, index) => ({ id: `n${index}`, op: "literal" as const, type: "f32" as const }));
    const valid = { ...asset(), stages: [{ stage: "vertex" as const, nodes,
      edges: [], outputs: [{ semantic: "position", node: "n0" }] }] };
    const start = performance.now();
    const result = validateShaderGraphAsset(valid);
    const elapsed = performance.now() - start;
    expect(result.valid).toBe(true);
    expect(elapsed).toBeLessThan(16);
  });
});
