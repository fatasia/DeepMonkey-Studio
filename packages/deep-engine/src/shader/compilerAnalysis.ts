import { SHADER_SCOPE_GROUP } from "./constants.js";
import { issue } from "./diagnostics.js";
import { nodeInputs, outputNodeIds } from "./schemaValidation.js";
import { DEEP_STANDARD_LIGHTING_LAYOUT_V1 } from "./surface.js";
import type {
  DeepShaderAsset,
  ShaderCompileCapabilities,
  ShaderDiagnostic,
  ShaderNode,
  ShaderPass,
  ShaderScope,
  ShaderStageGraph,
} from "./types.js";

export interface ShaderPassBindings {
  readonly properties: DeepShaderAsset["properties"];
  readonly resources: DeepShaderAsset["resources"];
  readonly lightingContext?: typeof DEEP_STANDARD_LIGHTING_LAYOUT_V1;
}

export function orderedShaderNodes(graph: ShaderStageGraph): ShaderNode[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const result: ShaderNode[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = nodes.get(id)!;
    nodeInputs(node).forEach(visit);
    result.push(node);
  };
  graph.outputs.forEach((output) => outputNodeIds(output).forEach(visit));
  return result;
}

export function collectPassBindings(asset: DeepShaderAsset, pass: ShaderPass): ShaderPassBindings {
  const reachable = [
    ...orderedShaderNodes(pass.vertex),
    ...(pass.fragment ? orderedShaderNodes(pass.fragment) : []),
  ];
  const propertyScopes = new Set<ShaderScope>();
  const propertiesByName = new Map(asset.properties.map((property) => [property.name, property]));
  const resourceNames = new Set<string>();
  for (const node of reachable) {
    if (node.op === "property") propertyScopes.add(propertiesByName.get(node.name)!.scope);
    if (node.op === "texture-sample") {
      resourceNames.add(node.texture);
      resourceNames.add(node.sampler);
    }
  }
  const lightingContext = pass.fragment?.outputs.some((output) => output.semantic === "surface")
    ? DEEP_STANDARD_LIGHTING_LAYOUT_V1 : undefined;
  return {
    // A used scope keeps its full struct so offsets never vary between passes.
    properties: asset.properties.filter((property) => propertyScopes.has(property.scope)),
    // Resource bindings are explicit, so unused entries can be removed without renumbering.
    resources: asset.resources.filter((resource) => resourceNames.has(resource.name)),
    ...(lightingContext ? { lightingContext } : {}),
  };
}

function validateSurfaceBindings(
  asset: DeepShaderAsset,
  pass: ShaderPass,
  bindings: ShaderPassBindings,
  diagnostics: ShaderDiagnostic[],
): void {
  if (!bindings.lightingContext) return;
  if (pass.kind !== "forward") {
    issue(diagnostics, "unsupported-surface-lighting", "pass.kind", "standard-pbr Surface Output is supported only by forward passes.");
  }
  const worldPosition = asset.varyings.find((varying) => varying.name === bindings.lightingContext!.worldPositionVarying);
  const produced = pass.vertex.outputs.some((output) => output.semantic === "varying" && output.name === bindings.lightingContext!.worldPositionVarying);
  if (!worldPosition || worldPosition.type !== "vec3f" || !produced) {
    issue(diagnostics, "unsupported-surface-lighting", "pass.vertex.outputs", "deep-lighting-v1 requires a produced vec3f varying named worldPosition.");
  }
  if (bindings.properties.some((property) => property.scope === "frame")) {
    issue(diagnostics, "duplicate-binding", "pass.fragment", "deep-lighting-v1 owns the 208-byte frame uniform at group 0 binding 0; reachable frame properties are not supported by this lowering.");
  }
  const reserved = new Set(bindings.lightingContext.bindings.map((binding) => `${binding.group}:${binding.binding}`));
  for (const resource of bindings.resources) {
    const key = `${SHADER_SCOPE_GROUP[resource.scope]}:${resource.binding}`;
    if (reserved.has(key)) issue(diagnostics, "duplicate-binding", `resources.${resource.name}`, `Resource ${resource.name} collides with deep-lighting-v1 binding ${key}.`);
  }
}

function validateTargetLimits(
  asset: DeepShaderAsset,
  bindings: ShaderPassBindings,
  capabilities: ShaderCompileCapabilities,
  diagnostics: ShaderDiagnostic[],
): void {
  const generated = bindings.lightingContext?.bindings ?? [];
  const usedGroups = [
    ...bindings.resources.map((entry) => SHADER_SCOPE_GROUP[entry.scope]),
    ...bindings.properties.map((entry) => SHADER_SCOPE_GROUP[entry.scope]),
    ...generated.map((entry) => entry.group),
  ];
  if (usedGroups.some((group) => group >= capabilities.limits.maxBindGroups)) issue(diagnostics, "unsupported-capability", "capabilities.limits.maxBindGroups", "Shader bind group policy exceeds the target limit.");
  for (const scope of ["frame", "material", "object", "pass"] as const) {
    const group = SHADER_SCOPE_GROUP[scope];
    const count = bindings.resources.filter((entry) => entry.scope === scope).length
      + (bindings.properties.some((entry) => entry.scope === scope) ? 1 : 0)
      + generated.filter((entry) => entry.group === group).length;
    if (count > capabilities.limits.maxBindingsPerBindGroup) issue(diagnostics, "unsupported-capability", "capabilities.limits.maxBindingsPerBindGroup", `Shader ${scope} group exceeds the target binding-count limit.`);
  }
  if (asset.varyings.length > capabilities.limits.maxInterStageShaderVariables) issue(diagnostics, "unsupported-capability", "capabilities.limits.maxInterStageShaderVariables", "Shader varyings exceed the target limit.");
}

export function validatePassBindings(
  asset: DeepShaderAsset,
  pass: ShaderPass,
  bindings: ShaderPassBindings,
  capabilities: ShaderCompileCapabilities,
  diagnostics: ShaderDiagnostic[],
): void {
  validateSurfaceBindings(asset, pass, bindings, diagnostics);
  validateTargetLimits(asset, bindings, capabilities, diagnostics);
}
