import { orderedShaderNodes } from "./compilerAnalysis.js";
import type { ShaderPassBindings } from "./compilerAnalysis.js";
import { SHADER_SCOPE_GROUP } from "./constants.js";
import { nodeInputs } from "./schemaValidation.js";
import { emitStandardPbrDeclarations, standardPbrReturn } from "./surfaceLowering.js";
import type {
  DeepShaderAsset,
  ShaderNode,
  ShaderPass,
  ShaderPropertyLayoutEntry,
  ShaderScope,
  ShaderSourceMapEntry,
  ShaderStage,
  ShaderStageGraph,
  ShaderStageOutput,
  ShaderValueType,
} from "./types.js";

const scopeVariable: Readonly<Record<ShaderScope, string>> = {
  frame: "deepFrame", material: "deepMaterial", object: "deepObject", pass: "deepPass",
};
const wgslType: Readonly<Record<ShaderValueType, string>> = {
  f32: "f32", i32: "i32", u32: "u32", bool: "bool", vec2f: "vec2f", vec3f: "vec3f",
  vec4f: "vec4f", color: "vec4f", mat3x3f: "mat3x3f", mat4x4f: "mat4x4f",
};
const typeLayout: Readonly<Record<ShaderValueType, readonly [number, number]>> = {
  f32: [4, 4], i32: [4, 4], u32: [4, 4], bool: [4, 4], vec2f: [8, 8], vec3f: [16, 12],
  vec4f: [16, 16], color: [16, 16], mat3x3f: [16, 48], mat4x4f: [16, 64],
};

const roundUp = (alignment: number, value: number): number => Math.ceil(value / alignment) * alignment;
const propertySymbol = (name: string): string => `p_${name}`;
const resourceSymbol = (name: string): string => `r_${name}`;
const attributeSymbol = (name: string): string => `a_${name}`;
const varyingSymbol = (name: string): string => `v_${name}`;

function emitPropertyDeclarations(
  propertiesInput: DeepShaderAsset["properties"],
  lines: string[],
): ShaderPropertyLayoutEntry[] {
  const layout: ShaderPropertyLayoutEntry[] = [];
  for (const scope of ["frame", "material", "object", "pass"] as const) {
    const properties = propertiesInput.filter((entry) => entry.scope === scope).sort((a, b) => a.name.localeCompare(b.name));
    if (properties.length === 0) continue;
    const structName = `Deep${scope[0]!.toUpperCase()}${scope.slice(1)}Properties`;
    lines.push(`struct ${structName} {`);
    let offset = 0;
    for (const property of properties) {
      const [alignment, byteSize] = typeLayout[property.type];
      offset = roundUp(alignment, offset);
      layout.push(Object.freeze({ name: property.name, type: property.type, group: SHADER_SCOPE_GROUP[scope], binding: 0, offset, byteSize }));
      lines.push(`  ${propertySymbol(property.name)}: ${property.type === "bool" ? "u32" : wgslType[property.type]},`);
      offset += byteSize;
    }
    lines.push("};", `@group(${SHADER_SCOPE_GROUP[scope]}) @binding(0) var<uniform> ${scopeVariable[scope]}: ${structName};`);
  }
  return layout;
}

function emitResourceDeclarations(resources: DeepShaderAsset["resources"], lines: string[]): void {
  const declaration: Readonly<Record<string, (name: string) => string>> = {
    "texture-2d-f32": (name) => `var ${name}: texture_2d<f32>;`,
    "texture-depth-2d": (name) => `var ${name}: texture_depth_2d;`,
    sampler: (name) => `var ${name}: sampler;`,
    "comparison-sampler": (name) => `var ${name}: sampler_comparison;`,
    "storage-buffer-read": (name) => `var<storage, read> ${name}: array<u32>;`,
  };
  [...resources].sort((a, b) => SHADER_SCOPE_GROUP[a.scope] - SHADER_SCOPE_GROUP[b.scope] || a.binding - b.binding)
    .forEach((resource) => lines.push(`@group(${SHADER_SCOPE_GROUP[resource.scope]}) @binding(${resource.binding}) ${declaration[resource.kind]!(resourceSymbol(resource.name))}`));
}

function interpolation(type: ShaderValueType, mode: string | undefined): string {
  if (type === "i32" || type === "u32" || type === "bool") return " @interpolate(flat)";
  return mode && mode !== "perspective" ? ` @interpolate(${mode})` : "";
}

function emitIoDeclarations(asset: DeepShaderAsset, lines: string[]): void {
  if (asset.attributes.length > 0) {
    lines.push("struct DeepVertexInput {");
    [...asset.attributes].sort((a, b) => a.location - b.location)
      .forEach((attribute) => lines.push(`  @location(${attribute.location}) ${attributeSymbol(attribute.name)}: ${wgslType[attribute.type]},`));
    lines.push("};");
  }
  lines.push("struct DeepVertexOut {", "  @builtin(position) position: vec4f,");
  [...asset.varyings].sort((a, b) => a.location - b.location)
    .forEach((varying) => lines.push(`  @location(${varying.location})${interpolation(varying.type, varying.interpolation)} ${varyingSymbol(varying.name)}: ${wgslType[varying.type]},`));
  lines.push("};");
}

function numberLiteral(value: number, type: ShaderValueType): string {
  if (type === "i32") return `${value}i`;
  if (type === "u32" || type === "bool") return `${value}u`;
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function literal(node: Extract<ShaderNode, { op: "literal" }>): string {
  if (node.type === "bool") return node.value ? "true" : "false";
  if (typeof node.value === "number") return numberLiteral(node.value, node.type);
  const values = node.value as readonly number[];
  return `${wgslType[node.type]}(${values.map((value) => numberLiteral(value, "f32")).join(", ")})`;
}

function splat(type: ShaderValueType, value: string): string {
  return type === "f32" ? value : `${wgslType[type]}(${value})`;
}

function expression(node: ShaderNode, nodes: ReadonlyMap<string, ShaderNode>, asset: DeepShaderAsset): string {
  const input = (index: number): string => `n_${nodeInputs(node)[index]!}`;
  if (node.op === "literal") return literal(node);
  if (node.op === "attribute") return `input.${attributeSymbol(node.name)}`;
  if (node.op === "varying") return `input.${varyingSymbol(node.name)}`;
  if (node.op === "pbr-frame-view") return "deepPbrFrame.view";
  if (node.op === "property") {
    const property = asset.properties.find((entry) => entry.name === node.name)!;
    const value = `${scopeVariable[property.scope]}.${propertySymbol(property.name)}`;
    return property.type === "bool" ? `(${value} != 0u)` : value;
  }
  if (node.op === "add") return `${input(0)} + ${input(1)}`;
  if (node.op === "subtract") return `${input(0)} - ${input(1)}`;
  if (node.op === "multiply") return `${input(0)} * ${input(1)}`;
  if (node.op === "divide") return `${input(0)} / ${input(1)}`;
  if (node.op === "min") return `min(${input(0)}, ${input(1)})`;
  if (node.op === "max") return `max(${input(0)}, ${input(1)})`;
  if (node.op === "pow") return `pow(${input(0)}, ${input(1)})`;
  if (node.op === "dot") return `dot(${input(0)}, ${input(1)})`;
  if (node.op === "cross") return `cross(${input(0)}, ${input(1)})`;
  if (node.op === "select") return `select(${input(0)}, ${input(1)}, ${input(2)})`;
  if (node.op === "clamp") return `clamp(${input(0)}, ${input(1)}, ${input(2)})`;
  if (node.op === "mix") {
    const factor = nodes.get(nodeInputs(node)[2]!)?.type === "f32" ? splat(node.type, input(2)) : input(2);
    return `mix(${input(0)}, ${input(1)}, ${factor})`;
  }
  if (node.op === "normalize") return `normalize(${input(0)})`;
  if (node.op === "negate") return `-${input(0)}`;
  if (node.op === "saturate") return `clamp(${input(0)}, ${splat(node.type, "0.0")}, ${splat(node.type, "1.0")})`;
  if (node.op === "scale") return `${input(0)} * ${splat(node.type, input(1))}`;
  if (node.op === "transform-direction") return `${input(0)} * ${input(1)}`;
  if (node.op === "transform-position") return `${input(0)} * vec4f(${input(1)}, 1.0)`;
  if (node.op === "compose-vec4") return `vec4f(${input(0)}, ${input(1)})`;
  if (node.op === "swizzle") return `${input(0)}.${node.mask}`;
  if (node.op === "texture-sample") return `textureSample(${resourceSymbol(node.texture)}, ${resourceSymbol(node.sampler)}, ${input(0)})`;
  return "0.0";
}

function emitGraph(
  asset: DeepShaderAsset,
  graph: ShaderStageGraph,
  stage: ShaderStage,
  lines: string[],
  sourceMap: ShaderSourceMapEntry[],
): void {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of orderedShaderNodes(graph)) {
    lines.push(`  let n_${node.id}: ${wgslType[node.type]} = ${expression(node, nodes, asset)};`);
    sourceMap.push(Object.freeze({ stage, nodeId: node.id, generatedLine: lines.length }));
  }
}

function emitEntryPoints(asset: DeepShaderAsset, pass: ShaderPass, lines: string[], sourceMap: ShaderSourceMapEntry[]): void {
  const vertexInput = asset.attributes.length > 0 ? "input: DeepVertexInput" : "";
  lines.push(`@vertex fn deepVertex(${vertexInput}) -> DeepVertexOut {`, "  var output: DeepVertexOut;");
  emitGraph(asset, pass.vertex, "vertex", lines, sourceMap);
  const position = pass.vertex.outputs.find((output) => output.semantic === "position") as Extract<ShaderStageOutput, { semantic: "position" }>;
  lines.push(`  output.position = n_${position.node};`);
  for (const output of pass.vertex.outputs) {
    if (output.semantic === "varying") lines.push(`  output.${varyingSymbol(output.name)} = n_${output.node};`);
  }
  lines.push("  return output;", "}");
  if (!pass.fragment) return;
  const primary = pass.fragment.outputs.find((output) => output.semantic === "color" || output.semantic === "surface");
  lines.push(`@fragment fn deepFragment(input: DeepVertexOut)${primary ? " -> @location(0) vec4f" : ""} {`);
  emitGraph(asset, pass.fragment, "fragment", lines, sourceMap);
  const clip = pass.fragment.outputs.find((output) => output.semantic === "alpha-clip");
  if (clip?.semantic === "alpha-clip") lines.push(`  if (n_${clip.alpha} < n_${clip.cutoff}) { discard; }`);
  if (primary) {
    const result = primary.semantic === "surface" ? standardPbrReturn(primary) : `n_${primary.node}`;
    lines.push(`  return ${result};`);
  }
  lines.push("}");
}

export interface EmittedShaderPass {
  readonly code: string;
  readonly propertyLayout: ShaderPropertyLayoutEntry[];
  readonly sourceMap: ShaderSourceMapEntry[];
}

export function emitShaderPass(
  asset: DeepShaderAsset,
  pass: ShaderPass,
  bindings: ShaderPassBindings,
): EmittedShaderPass {
  const lines = ["// Deep Shader IR schema 1; generated deterministically."];
  const propertyLayout = emitPropertyDeclarations(bindings.properties, lines);
  emitResourceDeclarations(bindings.resources, lines);
  if (bindings.lightingContext) emitStandardPbrDeclarations(lines);
  emitIoDeclarations(asset, lines);
  const sourceMap: ShaderSourceMapEntry[] = [];
  emitEntryPoints(asset, pass, lines, sourceMap);
  return { code: `${lines.join("\n")}\n`, propertyLayout, sourceMap };
}
