import { issue } from "./diagnostics.js";
import { nodeInputs } from "./schemaValidation.js";
import { DEEP_STANDARD_SURFACE_FIELD_NAMES, DEEP_STANDARD_SURFACE_FIELD_TYPES } from "./surface.js";
import type {
  DeepShaderAsset, ShaderDiagnostic, ShaderNode, ShaderPass,
  ShaderStage, ShaderStageGraph, ShaderValueType,
} from "./types.js";

interface Symbols {
  readonly properties: ReadonlyMap<string, ShaderValueType>;
  readonly attributes: ReadonlyMap<string, ShaderValueType>;
  readonly varyings: ReadonlyMap<string, ShaderValueType>;
  readonly resources: ReadonlyMap<string, { kind: string; visibility: readonly ShaderStage[] }>;
}

const numeric = new Set<ShaderValueType>(["f32", "vec2f", "vec3f", "vec4f", "color"]);
const vector = new Set<ShaderValueType>(["vec2f", "vec3f", "vec4f", "color"]);
const swizzleType: Readonly<Record<number, ShaderValueType>> = { 1: "f32", 2: "vec2f", 3: "vec3f", 4: "vec4f" };

function checkNode(
  node: ShaderNode,
  nodes: ReadonlyMap<string, ShaderNode>,
  pass: ShaderPass,
  stage: ShaderStage,
  symbols: Symbols,
  path: string,
  diagnostics: ShaderDiagnostic[],
): void {
  const inputs = nodeInputs(node).map((id, index) => {
    const input = nodes.get(id);
    if (!input) issue(diagnostics, "missing-symbol", `${path}.inputs.${index}`, `Unknown node ${id}.`);
    return input;
  });
  if (node.op === "property") {
    const type = symbols.properties.get(node.name);
    if (!type) issue(diagnostics, "missing-symbol", `${path}.name`, `Unknown property ${node.name}.`);
    else if (type !== node.type) issue(diagnostics, "type-mismatch", `${path}.type`, `Property ${node.name} has type ${type}.`);
  } else if (node.op === "attribute") {
    if (stage !== "vertex") issue(diagnostics, "invalid-stage", path, "Attributes are only available in the vertex stage.");
    const type = symbols.attributes.get(node.name);
    if (!type) issue(diagnostics, "missing-symbol", `${path}.name`, `Unknown attribute ${node.name}.`);
    else if (type !== node.type) issue(diagnostics, "type-mismatch", `${path}.type`, `Attribute ${node.name} has type ${type}.`);
  } else if (node.op === "varying") {
    if (stage !== "fragment") issue(diagnostics, "invalid-stage", path, "Varying reads are only available in the fragment stage.");
    const type = symbols.varyings.get(node.name);
    if (!type) issue(diagnostics, "missing-symbol", `${path}.name`, `Unknown varying ${node.name}.`);
    else if (type !== node.type) issue(diagnostics, "type-mismatch", `${path}.type`, `Varying ${node.name} has type ${type}.`);
  } else if (node.op === "pbr-frame-view") {
    const surface = pass.fragment?.outputs.some((output) => output.semantic === "surface");
    if (stage !== "vertex" || !surface) issue(diagnostics, "invalid-stage", path, "pbr-frame-view is a vertex input of the standard Surface forward ABI.");
    if (node.type !== "mat4x4f") issue(diagnostics, "type-mismatch", `${path}.type`, "pbr-frame-view produces mat4x4f.");
  } else if (["add", "subtract", "multiply", "divide", "min", "max", "pow"].includes(node.op)) {
    if (!numeric.has(node.type) || inputs.some((input) => input && input.type !== node.type)) issue(diagnostics, "type-mismatch", path, `${node.op} requires equal scalar or vector types.`);
  } else if (node.op === "dot") {
    if (node.type !== "f32" || !inputs[0] || !vector.has(inputs[0].type) || inputs[1]?.type !== inputs[0].type) issue(diagnostics, "type-mismatch", path, "dot requires two equal vectors and produces f32.");
  } else if (node.op === "select") {
    if (!inputs[0] || inputs[0].type !== node.type || inputs[1]?.type !== node.type || inputs[2]?.type !== "bool") issue(diagnostics, "type-mismatch", path, "select requires two result values and a boolean condition.");
  } else if (node.op === "clamp") {
    if (!numeric.has(node.type) || inputs.some((input) => input && input.type !== node.type)) issue(diagnostics, "type-mismatch", path, "clamp requires a value and bounds of one scalar or vector type.");
  } else if (node.op === "mix") {
    if (!numeric.has(node.type) || inputs[0]?.type !== node.type || inputs[1]?.type !== node.type
      || (inputs[2]?.type !== "f32" && inputs[2]?.type !== node.type)) {
      issue(diagnostics, "type-mismatch", path, "mix requires equal endpoints and an f32 or same-type interpolation factor.");
    }
  } else if (node.op === "normalize") {
    if (!inputs[0] || !vector.has(node.type) || inputs[0].type !== node.type) issue(diagnostics, "type-mismatch", path, "normalize requires and produces the same vector type.");
  } else if (node.op === "negate" || node.op === "saturate") {
    if (!numeric.has(node.type) || inputs[0]?.type !== node.type) issue(diagnostics, "type-mismatch", path, `${node.op} requires and produces the same scalar or vector type.`);
  } else if (node.op === "scale") {
    if (!vector.has(node.type) || inputs[0]?.type !== node.type || inputs[1]?.type !== "f32") issue(diagnostics, "type-mismatch", path, "scale requires a vector and an f32 factor.");
  } else if (node.op === "cross") {
    if (node.type !== "vec3f" || inputs[0]?.type !== "vec3f" || inputs[1]?.type !== "vec3f") issue(diagnostics, "type-mismatch", path, "cross requires two vec3f inputs and produces vec3f.");
  } else if (node.op === "transform-direction") {
    if (node.type !== "vec3f" || inputs[0]?.type !== "mat3x3f" || inputs[1]?.type !== "vec3f") issue(diagnostics, "type-mismatch", path, "transform-direction requires mat3x3f and vec3f inputs.");
  } else if (node.op === "transform-position") {
    if (node.type !== "vec4f" || inputs[0]?.type !== "mat4x4f" || inputs[1]?.type !== "vec3f") issue(diagnostics, "type-mismatch", path, "transform-position requires mat4x4f and vec3f inputs and produces vec4f.");
  } else if (node.op === "compose-vec4") {
    if (node.type !== "vec4f" || inputs[0]?.type !== "vec3f" || inputs[1]?.type !== "f32") issue(diagnostics, "type-mismatch", path, "compose-vec4 requires vec3f and f32 inputs.");
  } else if (node.op === "swizzle") {
    const source = inputs[0];
    const expected = swizzleType[node.mask.length];
    if (!source || !vector.has(source.type) || (node.type !== expected && !(expected === "vec4f" && node.type === "color"))) issue(diagnostics, "type-mismatch", path, "Swizzle result type must match its mask length.");
    const available = source?.type === "vec2f" ? "xyrg" : source?.type === "vec3f" ? "xyzrgb" : "xyzwrgba";
    if ([...node.mask].some((component) => !available.includes(component))) issue(diagnostics, "type-mismatch", `${path}.mask`, "Swizzle reads a component absent from its input.");
  } else if (node.op === "texture-sample") {
    const texture = symbols.resources.get(node.texture);
    const sampler = symbols.resources.get(node.sampler);
    if (stage !== "fragment") issue(diagnostics, "invalid-stage", path, "The first compiler subset only samples textures in the fragment stage.");
    if (texture?.kind !== "texture-2d-f32") issue(diagnostics, "type-mismatch", `${path}.texture`, "texture-sample requires texture-2d-f32.");
    if (sampler?.kind !== "sampler") issue(diagnostics, "type-mismatch", `${path}.sampler`, "texture-sample requires a filtering sampler.");
    if (!texture) issue(diagnostics, "missing-symbol", `${path}.texture`, `Unknown texture ${node.texture}.`);
    if (!sampler) issue(diagnostics, "missing-symbol", `${path}.sampler`, `Unknown sampler ${node.sampler}.`);
    if (texture && !texture.visibility.includes(stage)) issue(diagnostics, "invalid-stage", `${path}.texture`, `Texture is not visible to ${stage}.`);
    if (sampler && !sampler.visibility.includes(stage)) issue(diagnostics, "invalid-stage", `${path}.sampler`, `Sampler is not visible to ${stage}.`);
    if (inputs[0]?.type !== "vec2f" || (node.type !== "vec4f" && node.type !== "color")) issue(diagnostics, "type-mismatch", path, "texture-sample requires vec2f UVs and produces vec4f/color.");
  }
}

function detectCycle(nodes: ReadonlyMap<string, ShaderNode>, path: string, diagnostics: ShaderDiagnostic[]): void {
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    const node = nodes.get(id);
    if (node && nodeInputs(node).some((input) => nodes.has(input) && visit(input))) return true;
    state.set(id, 2);
    return false;
  };
  if ([...nodes.keys()].some(visit)) issue(diagnostics, "graph-cycle", path, "Shader stage graph contains a cycle.");
}

export function validateStageGraph(
  asset: DeepShaderAsset,
  pass: ShaderPass,
  graph: ShaderStageGraph,
  stage: ShaderStage,
  path: string,
  diagnostics: ShaderDiagnostic[],
): void {
  const nodes = new Map<string, ShaderNode>();
  graph.nodes.forEach((node, index) => {
    if (nodes.has(node.id)) issue(diagnostics, "duplicate-symbol", `${path}.nodes.${index}.id`, `Duplicate node ${node.id}.`);
    else nodes.set(node.id, node);
  });
  const symbols: Symbols = {
    properties: new Map(asset.properties.map((entry) => [entry.name, entry.type])),
    attributes: new Map(asset.attributes.map((entry) => [entry.name, entry.type])),
    varyings: new Map(asset.varyings.map((entry) => [entry.name, entry.type])),
    resources: new Map(asset.resources.map((entry) => [entry.name, { kind: entry.kind, visibility: entry.visibility }])),
  };
  graph.nodes.forEach((node, index) => checkNode(node, nodes, pass, stage, symbols, `${path}.nodes.${index}`, diagnostics));
  detectCycle(nodes, path, diagnostics);

  const primary = graph.outputs.filter((output) => stage === "vertex"
    ? output.semantic === "position"
    : output.semantic === "color" || output.semantic === "surface");
  const clips = graph.outputs.filter((output) => output.semantic === "alpha-clip");
  const clipOnlyPass = stage === "fragment" && (pass.kind === "depth" || pass.kind === "shadow");
  if (primary.length !== (clipOnlyPass ? 0 : 1)) issue(diagnostics, "invalid-stage", `${path}.outputs`, stage === "vertex"
    ? "Vertex stage requires exactly one position output."
    : clipOnlyPass ? "Depth and shadow fragment stages cannot write color." : "Fragment stage requires exactly one color or surface output.");
  if (clips.length > 1 || (clipOnlyPass && clips.length !== 1)) issue(diagnostics, "invalid-stage", `${path}.outputs`, clipOnlyPass
    ? "Depth and shadow fragment stages require exactly one alpha-clip output."
    : "Fragment stages allow at most one alpha-clip output.");
  for (const [index, output] of graph.outputs.entries()) {
    const outputPath = `${path}.outputs.${index}`;
    if (output.semantic === "surface") {
      if (stage !== "fragment") issue(diagnostics, "invalid-stage", outputPath, "Surface outputs are only valid in the fragment stage.");
      for (const field of DEEP_STANDARD_SURFACE_FIELD_NAMES) {
        const nodeId = output.fields[field];
        const node = nodes.get(nodeId);
        if (!node) issue(diagnostics, "missing-symbol", `${outputPath}.fields.${field}`, `Unknown surface field node ${nodeId}.`);
        else if (node.type !== DEEP_STANDARD_SURFACE_FIELD_TYPES[field]) issue(diagnostics, "type-mismatch", `${outputPath}.fields.${field}`, `Surface ${field} requires ${DEEP_STANDARD_SURFACE_FIELD_TYPES[field]}.`);
      }
      continue;
    }
    if (output.semantic === "alpha-clip") {
      const alpha = nodes.get(output.alpha);
      const cutoff = nodes.get(output.cutoff);
      if (stage !== "fragment") issue(diagnostics, "invalid-stage", outputPath, "Alpha clip outputs are only valid in the fragment stage.");
      if (!alpha) issue(diagnostics, "missing-symbol", `${outputPath}.alpha`, `Unknown alpha node ${output.alpha}.`);
      else if (alpha.type !== "f32") issue(diagnostics, "type-mismatch", `${outputPath}.alpha`, "Alpha clip alpha must be f32.");
      if (!cutoff) issue(diagnostics, "missing-symbol", `${outputPath}.cutoff`, `Unknown cutoff node ${output.cutoff}.`);
      else if (cutoff.type !== "f32") issue(diagnostics, "type-mismatch", `${outputPath}.cutoff`, "Alpha clip cutoff must be f32.");
      continue;
    }
    const node = nodes.get(output.node);
    if (!node) issue(diagnostics, "missing-symbol", `${outputPath}.node`, `Unknown output node ${output.node}.`);
    if (output.semantic === "position" && (stage !== "vertex" || node?.type !== "vec4f")) issue(diagnostics, "type-mismatch", `${path}.outputs.${index}`, "Position output must be vertex vec4f.");
    if (output.semantic === "color" && (stage !== "fragment" || (node?.type !== "vec4f" && node?.type !== "color"))) issue(diagnostics, "type-mismatch", `${path}.outputs.${index}`, "Color output must be fragment vec4f/color.");
    if (output.semantic === "varying") {
      if (stage !== "vertex") issue(diagnostics, "invalid-stage", `${path}.outputs.${index}`, "Varyings are written by the vertex stage only.");
      const varying = asset.varyings.find((entry) => entry.name === output.name);
      if (!varying) issue(diagnostics, "missing-symbol", `${path}.outputs.${index}.name`, `Unknown varying ${String(output.name)}.`);
      else if (node && varying.type !== node.type) issue(diagnostics, "type-mismatch", `${path}.outputs.${index}`, `Varying ${varying.name} expects ${varying.type}.`);
    }
  }
  if (stage === "vertex") {
    const names = graph.outputs.filter((output) => output.semantic === "varying").map((output) => output.name);
    if (new Set(names).size !== names.length) issue(diagnostics, "duplicate-symbol", `${path}.outputs`, "Vertex varying outputs must be unique.");
  }
}
