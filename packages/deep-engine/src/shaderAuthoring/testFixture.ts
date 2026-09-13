import { compileShaderPass, type DeepShaderAsset, type ShaderCompileCapabilities } from "../shader/index.js";
import type { ShaderAuthoringArtifact, ShaderGraphAuthoringDocument, ShaderTextAuthoringDocument } from "./types.js";

export const TEST_CAPABILITIES: ShaderCompileCapabilities = Object.freeze({
  features: Object.freeze([]),
  limits: Object.freeze({ maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 }),
});

export function testAsset(color = 1): DeepShaderAsset {
  return {
    schemaVersion: 1,
    id: "deep.authoring-test",
    properties: [],
    resources: [],
    attributes: [],
    varyings: [],
    keywords: [],
    techniques: [{
      id: "webgpu",
      requirements: { webgpu: true },
      passes: [{
        id: "forward",
        kind: "forward",
        state: {
          topology: "triangle-list",
          cullMode: "back",
          frontFace: "ccw",
          depthCompare: "less-equal",
          depthWrite: true,
          colorWriteMask: 15,
        },
        vertex: {
          nodes: [{ id: "position", op: "literal", type: "vec4f", value: [0, 0, 0, 1] }],
          outputs: [{ semantic: "position", node: "position" }],
        },
        fragment: {
          nodes: [{ id: "color", op: "literal", type: "vec4f", value: [color, 0, 0, 1] }],
          outputs: [{ semantic: "color", node: "color" }],
        },
      }],
    }],
  };
}

export function graphDocument(color = 1): ShaderGraphAuthoringDocument {
  return {
    schemaVersion: 1,
    id: "authoring.graph",
    mode: "graph",
    asset: testAsset(color),
    techniqueId: "webgpu",
    passId: "forward",
  };
}

export function textDocument(source = "surface { color: red; }"): ShaderTextAuthoringDocument {
  return { schemaVersion: 1, id: "authoring.text", mode: "text", language: "deepsl", source };
}

export function testArtifact(): ShaderAuthoringArtifact {
  const compiled = compileShaderPass(testAsset(), "webgpu", "forward", TEST_CAPABILITIES);
  if (!compiled.value) throw new Error("Invalid authoring test fixture.");
  return {
    target: "webgpu",
    pass: compiled.value,
    sourceMap: [{
      sourceKind: "text-range",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 8 } },
      generatedLine: 1,
    }],
  };
}
