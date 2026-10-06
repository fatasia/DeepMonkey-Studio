import type { ShaderNode } from "../shader/types.js";
import type { ShaderGraphNodeMetadata } from "./graphTypes.js";

/**
 * WGSL 一等公民的作者节点注册表；运行时仍复用既有 shader/compiler.ts。
 * inputCount 是图校验/降级共用的输入端口数（diagnostics 归因与 tuple 检查同源）；
 * 固定输出类型的 op 在 ports 声明输出端，画布 addNode 由此取默认类型。
 */
const METADATA: readonly ShaderGraphNodeMetadata[] = [
  { op: "literal", label: "Literal", category: "input", stages: ["vertex", "fragment"], preview: "scalar", ports: [] },
  { op: "property", label: "Property", category: "input", stages: ["vertex", "fragment"], preview: "none", ports: [{ name: "value", direction: "output", type: "f32" }] },
  { op: "attribute", label: "Attribute", category: "input", stages: ["vertex"], preview: "vector", ports: [] },
  { op: "varying", label: "Varying", category: "stage", stages: ["vertex", "fragment"], preview: "vector", ports: [] },
  { op: "add", label: "Add", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 2 },
  { op: "subtract", label: "Subtract", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 2 },
  { op: "multiply", label: "Multiply", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 2 },
  { op: "divide", label: "Divide", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 2 },
  { op: "min", label: "Min", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 2 },
  { op: "max", label: "Max", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 2 },
  { op: "pow", label: "Pow", category: "math", stages: ["vertex", "fragment"], preview: "scalar", ports: [], inputCount: 2 },
  { op: "dot", label: "Dot", category: "math", stages: ["vertex", "fragment"], preview: "scalar", ports: [], inputCount: 2 },
  { op: "normalize", label: "Normalize", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 1 },
  { op: "negate", label: "Negate", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 1 },
  { op: "saturate", label: "Saturate", category: "math", stages: ["vertex", "fragment"], preview: "scalar", ports: [], inputCount: 1 },
  { op: "one-minus", label: "One Minus", category: "math", stages: ["vertex", "fragment"], preview: "scalar", ports: [], inputCount: 1 },
  { op: "abs", label: "Abs", category: "math", stages: ["vertex", "fragment"], preview: "scalar", ports: [], inputCount: 1 },
  { op: "floor", label: "Floor", category: "math", stages: ["vertex", "fragment"], preview: "scalar", ports: [], inputCount: 1 },
  { op: "fract", label: "Fract", category: "math", stages: ["vertex", "fragment"], preview: "scalar", ports: [], inputCount: 1 },
  { op: "compose-vec4", label: "Compose Vec4", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 2 },
  { op: "swizzle", label: "Swizzle", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 1 },
  { op: "select", label: "Select", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 3 },
  { op: "clamp", label: "Clamp", category: "math", stages: ["vertex", "fragment"], preview: "scalar", ports: [], inputCount: 3 },
  { op: "mix", label: "Mix", category: "math", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 3 },
  { op: "smoothstep", label: "Smoothstep", category: "math", stages: ["vertex", "fragment"], preview: "scalar", ports: [], inputCount: 3 },
  { op: "cross", label: "Cross", category: "geometry", stages: ["vertex", "fragment"], preview: "vector", ports: [{ name: "value", direction: "output", type: "vec3f" }], inputCount: 2 },
  { op: "scale", label: "Scale", category: "geometry", stages: ["vertex", "fragment"], preview: "vector", ports: [], inputCount: 2 },
  { op: "transform-direction", label: "Transform Direction", category: "geometry", stages: ["vertex", "fragment"], preview: "vector", ports: [{ name: "value", direction: "output", type: "vec3f" }], inputCount: 2 },
  { op: "transform-position", label: "Transform Position", category: "geometry", stages: ["vertex"], preview: "vector", ports: [{ name: "value", direction: "output", type: "vec4f" }], inputCount: 2 },
  { op: "texture-sample", label: "Texture Sample", category: "texture", stages: ["fragment"], preview: "color", ports: [], inputCount: 1 },
  { op: "pbr-frame-view", label: "PBR Frame View", category: "stage", stages: ["vertex", "fragment"], preview: "vector", ports: [] },
];

const BY_OP = new Map(METADATA.map(item => [item.op, item]));

export function shaderGraphNodeMetadata(op: ShaderNode["op"]): ShaderGraphNodeMetadata | undefined {
  return BY_OP.get(op);
}
export function shaderGraphNodeRegistry(): readonly ShaderGraphNodeMetadata[] { return METADATA; }
export function isShaderGraphNodeOp(value: string): value is ShaderNode["op"] { return BY_OP.has(value as ShaderNode["op"]); }
/** 节点 op 的边输入端口数（未注册 op 返回 0）；graphValidation 与 lowering 共用同源。 */
export function shaderGraphNodeInputCount(op: string): number {
  return BY_OP.get(op as ShaderNode["op"])?.inputCount ?? 0;
}
