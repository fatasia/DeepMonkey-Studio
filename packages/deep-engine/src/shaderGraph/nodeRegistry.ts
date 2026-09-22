import type { ShaderNode } from "../shader/types.js";
import type { ShaderGraphNodeMetadata } from "./graphTypes.js";

/** WGSL-first author node registry. Runtime compiler remains the existing shader/compiler.ts. */
const METADATA: readonly ShaderGraphNodeMetadata[] = [
  { op: "literal", label: "Literal", category: "input", stages: ["vertex", "fragment"], preview: "scalar", ports: [] },
  { op: "property", label: "Property", category: "input", stages: ["vertex", "fragment"], preview: "none", ports: [{ name: "value", direction: "output", type: "f32" }] },
  { op: "attribute", label: "Attribute", category: "input", stages: ["vertex"], preview: "vector", ports: [] },
  { op: "varying", label: "Varying", category: "stage", stages: ["vertex", "fragment"], preview: "vector", ports: [] },
  { op: "add", label: "Add", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [] },
  { op: "subtract", label: "Subtract", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [] },
  { op: "multiply", label: "Multiply", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [] },
  { op: "divide", label: "Divide", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [] },
  { op: "dot", label: "Dot", category: "math", stages: ["vertex", "fragment"], preview: "scalar", ports: [] },
  { op: "normalize", label: "Normalize", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [] },
  { op: "negate", label: "Negate", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [] },
  { op: "saturate", label: "Saturate", category: "math", stages: ["vertex", "fragment"], preview: "scalar", ports: [] },
  { op: "compose-vec4", label: "Compose Vec4", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [] },
  { op: "swizzle", label: "Swizzle", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [] },
  { op: "texture-sample", label: "Texture Sample", category: "texture", stages: ["fragment"], preview: "color", ports: [] },
  { op: "pbr-frame-view", label: "PBR Frame View", category: "stage", stages: ["vertex", "fragment"], preview: "vector", ports: [] },
];

const BY_OP = new Map(METADATA.map(item => [item.op, item]));

export function shaderGraphNodeMetadata(op: ShaderNode["op"]): ShaderGraphNodeMetadata | undefined {
  return BY_OP.get(op);
}
export function shaderGraphNodeRegistry(): readonly ShaderGraphNodeMetadata[] { return METADATA; }
export function isShaderGraphNodeOp(value: string): value is ShaderNode["op"] { return BY_OP.has(value as ShaderNode["op"]); }
