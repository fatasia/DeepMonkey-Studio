import { frozenDiagnostics, issue } from "./diagnostics.js";
import { validateStageGraph } from "./graphValidation.js";
import { validateShaderSchema } from "./schemaValidation.js";
import type { DeepShaderAsset, ShaderDiagnostic, ShaderFeaturePredicate, ShaderValidationResult } from "./types.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validatePredicateReferences(
  predicate: ShaderFeaturePredicate | undefined,
  keywords: ReadonlyMap<string, readonly string[]>,
  path: string,
  diagnostics: ShaderDiagnostic[],
): void {
  if (!predicate) return;
  if (predicate.op === "keyword") {
    const values = keywords.get(predicate.name);
    if (!values) issue(diagnostics, "missing-symbol", `${path}.name`, `Unknown keyword ${predicate.name}.`);
    else if (!values.includes(predicate.equals)) issue(diagnostics, "invalid-value", `${path}.equals`, `Keyword ${predicate.name} has no value ${predicate.equals}.`);
  } else if (predicate.op === "all" || predicate.op === "any") {
    predicate.terms.forEach((term, index) => validatePredicateReferences(term, keywords, `${path}.terms.${index}`, diagnostics));
  } else if (predicate.op === "not") validatePredicateReferences(predicate.term, keywords, `${path}.term`, diagnostics);
}

function duplicate(
  values: readonly [string, string][],
  diagnostics: ShaderDiagnostic[],
  label: string,
  code: "duplicate-symbol" | "duplicate-binding" = "duplicate-symbol",
): void {
  const seen = new Set<string>();
  for (const [value, path] of values) {
    if (seen.has(value)) issue(diagnostics, code, path, `Duplicate ${label} ${value}.`);
    seen.add(value);
  }
}

function semanticValidation(asset: DeepShaderAsset, diagnostics: ShaderDiagnostic[]): void {
  duplicate(asset.properties.map((entry, index) => [entry.name, `$.properties.${index}.name`]), diagnostics, "property");
  duplicate(asset.resources.map((entry, index) => [entry.name, `$.resources.${index}.name`]), diagnostics, "resource");
  duplicate(asset.attributes.map((entry, index) => [entry.name, `$.attributes.${index}.name`]), diagnostics, "attribute");
  duplicate(asset.attributes.map((entry, index) => [entry.semantic, `$.attributes.${index}.semantic`]), diagnostics, "attribute semantic");
  duplicate(asset.varyings.map((entry, index) => [entry.name, `$.varyings.${index}.name`]), diagnostics, "varying");
  duplicate(asset.keywords.map((entry, index) => [entry.name, `$.keywords.${index}.name`]), diagnostics, "keyword");
  duplicate(asset.techniques.map((entry, index) => [entry.id, `$.techniques.${index}.id`]), diagnostics, "technique");
  duplicate(asset.attributes.map((entry, index) => [String(entry.location), `$.attributes.${index}.location`]), diagnostics, "attribute location");
  duplicate(asset.varyings.map((entry, index) => [String(entry.location), `$.varyings.${index}.location`]), diagnostics, "varying location");
  duplicate(asset.resources.map((entry, index) => [`${entry.scope}:${entry.binding}`, `$.resources.${index}.binding`]), diagnostics, "binding", "duplicate-binding");
  const globalNames = [...asset.properties.map((entry) => entry.name), ...asset.resources.map((entry) => entry.name)];
  if (new Set(globalNames).size !== globalNames.length) issue(diagnostics, "duplicate-symbol", "$", "Properties and resources share the WGSL global namespace.");

  const formatType: Readonly<Record<string, string>> = {
    float32: "f32", float32x2: "vec2f", float32x3: "vec3f", float32x4: "vec4f",
    uint32: "u32",
  };
  asset.attributes.forEach((entry, index) => {
    if (formatType[entry.format] !== entry.type) issue(diagnostics, "type-mismatch", `$.attributes.${index}`, `${entry.format} does not encode ${entry.type}.`);
  });
  asset.varyings.forEach((entry, index) => {
    if (!["f32", "i32", "u32", "vec2f", "vec3f", "vec4f", "color"].includes(entry.type)) issue(diagnostics, "type-mismatch", `$.varyings.${index}.type`, "This WGSL subset only supports scalar and vector varyings.");
    if ((entry.type === "i32" || entry.type === "u32" || entry.type === "bool") && entry.interpolation !== "flat") issue(diagnostics, "invalid-value", `$.varyings.${index}.interpolation`, "Integer and boolean varyings require flat interpolation.");
  });

  const keywords = new Map(asset.keywords.map((entry) => [entry.name, entry.values]));
  const passIds: [string, string][] = [];
  asset.techniques.forEach((technique, techniqueIndex) => {
    const techniquePath = `$.techniques.${techniqueIndex}`;
    validatePredicateReferences(technique.predicate, keywords, `${techniquePath}.predicate`, diagnostics);
    technique.passes.forEach((pass, passIndex) => {
      const path = `${techniquePath}.passes.${passIndex}`;
      passIds.push([pass.id, `${path}.id`]);
      validatePredicateReferences(pass.predicate, keywords, `${path}.predicate`, diagnostics);
      const colorPass = pass.kind === "forward" || pass.kind === "picking";
      if (colorPass && !pass.fragment) issue(diagnostics, "invalid-stage", `${path}.fragment`, `${pass.kind} pass requires a fragment graph.`);
      if (!colorPass && pass.fragment) issue(diagnostics, "invalid-stage", `${path}.fragment`, `${pass.kind} pass is vertex-only in schema v1.`);
      if (colorPass && pass.state.colorWriteMask === 0) issue(diagnostics, "invalid-state", `${path}.state.colorWriteMask`, "Color passes require a non-zero write mask.");
      if (!colorPass && pass.state.colorWriteMask !== 0) issue(diagnostics, "invalid-state", `${path}.state.colorWriteMask`, "Depth/shadow passes must disable color writes.");
      if (!colorPass && pass.state.blend) issue(diagnostics, "invalid-state", `${path}.state.blend`, "Depth/shadow passes cannot blend in schema v1.");
      validateStageGraph(asset, pass, pass.vertex, "vertex", `${path}.vertex`, diagnostics);
      if (pass.fragment) validateStageGraph(asset, pass, pass.fragment, "fragment", `${path}.fragment`, diagnostics);
      const produced = new Set(pass.vertex.outputs.filter((output) => output.semantic === "varying").map((output) => output.name));
      for (const node of pass.fragment?.nodes ?? []) {
        if (node.op === "varying" && !produced.has(node.name)) issue(diagnostics, "missing-symbol", `${path}.fragment`, `Fragment varying ${node.name} is not produced by this pass.`);
      }
    });
  });
  duplicate(passIds, diagnostics, "pass id");
}

export function validateShaderAsset(input: unknown): ShaderValidationResult {
  const diagnostics: ShaderDiagnostic[] = [];
  const asset = validateShaderSchema(input, diagnostics);
  if (asset) semanticValidation(asset, diagnostics);
  const frozen = frozenDiagnostics(diagnostics);
  if (!asset || diagnostics.length > 0) return Object.freeze({ valid: false, diagnostics: frozen });
  const clone = JSON.parse(JSON.stringify(asset)) as DeepShaderAsset;
  return Object.freeze({ valid: true, diagnostics: frozen, value: deepFreeze(clone) });
}
