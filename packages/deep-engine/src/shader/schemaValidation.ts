import { ASSET_ID, DEEP_SHADER_BUDGETS } from "./constants.js";
import { issue } from "./diagnostics.js";
import { exactFields, inspectCanonicalShaderInput, record } from "./safeInput.js";
import { validName, validTypedValue, validValueType, validatePredicate, validateRenderState, validateRequirements } from "./schemaPrimitives.js";
import { DEEP_STANDARD_SURFACE_FIELD_NAMES } from "./surface.js";
import type { DeepShaderAsset, ShaderDiagnostic, ShaderNode, ShaderStageGraph, ShaderStageOutput, ShaderValueType } from "./types.js";

const SCOPES = new Set(["frame", "material", "object", "pass"]);
const RESOURCE_KINDS = new Set(["texture-2d-f32", "texture-depth-2d", "sampler", "comparison-sampler", "storage-buffer-read"]);
const STAGES = new Set(["vertex", "fragment"]);
const FORMATS = new Set(["float32", "float32x2", "float32x3", "float32x4", "uint32"]);
const INTERPOLATION = new Set(["perspective", "linear", "flat"]);
const PASS_KINDS = new Set(["forward", "depth", "shadow", "picking"]);

function arrayField(value: unknown, path: string, max: number, diagnostics: ShaderDiagnostic[]): readonly unknown[] {
  if (!Array.isArray(value)) { issue(diagnostics, "invalid-type", path, "Expected array."); return []; }
  if (value.length > max) issue(diagnostics, "budget-exceeded", path, `Array exceeds its limit of ${max}.`);
  return value.slice(0, max);
}

function validateProperty(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): void {
  if (!record(value)) { issue(diagnostics, "invalid-type", path, "Expected property record."); return; }
  exactFields(value, ["name", "type", "scope", "default"], path, diagnostics);
  validName(value.name, `${path}.name`, diagnostics);
  const typed = validValueType(value.type, `${path}.type`, diagnostics);
  if (typeof value.scope !== "string" || !SCOPES.has(value.scope)) issue(diagnostics, "invalid-value", `${path}.scope`, "Unknown property scope.");
  if (typed && !validTypedValue(value.type as ShaderValueType, value.default)) issue(diagnostics, "type-mismatch", `${path}.default`, "Default value does not match the property type.");
}

function validateResource(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): void {
  if (!record(value)) { issue(diagnostics, "invalid-type", path, "Expected resource binding."); return; }
  exactFields(value, ["name", "scope", "binding", "kind", "visibility"], path, diagnostics);
  validName(value.name, `${path}.name`, diagnostics);
  if (typeof value.scope !== "string" || !SCOPES.has(value.scope)) issue(diagnostics, "invalid-value", `${path}.scope`, "Unknown binding scope.");
  if (!Number.isSafeInteger(value.binding) || (value.binding as number) < 1 || (value.binding as number) > 31) issue(diagnostics, "invalid-value", `${path}.binding`, "Binding must be an integer from 1 to 31; binding zero is reserved.");
  if (typeof value.kind !== "string" || !RESOURCE_KINDS.has(value.kind)) issue(diagnostics, "invalid-value", `${path}.kind`, "Unknown resource kind.");
  const visibility = arrayField(value.visibility, `${path}.visibility`, 2, diagnostics);
  let previous = "";
  for (let index = 0; index < visibility.length; index += 1) {
    const stage = visibility[index];
    if (typeof stage !== "string" || !STAGES.has(stage)) issue(diagnostics, "invalid-stage", `${path}.visibility.${index}`, "Unknown shader stage.");
    if (typeof stage === "string" && stage <= previous) issue(diagnostics, "non-deterministic", `${path}.visibility`, "Visibility stages must be sorted and unique.");
    if (typeof stage === "string") previous = stage;
  }
  if (visibility.length === 0) issue(diagnostics, "invalid-value", `${path}.visibility`, "At least one visible stage is required.");
}

function validateAttribute(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): void {
  if (!record(value)) { issue(diagnostics, "invalid-type", path, "Expected vertex attribute."); return; }
  exactFields(value, ["name", "semantic", "location", "format", "type"], path, diagnostics);
  validName(value.name, `${path}.name`, diagnostics);
  if (typeof value.semantic !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.semantic)) issue(diagnostics, "invalid-value", `${path}.semantic`, "Expected canonical uppercase semantic.");
  if (!Number.isSafeInteger(value.location) || (value.location as number) < 0 || (value.location as number) > 31) issue(diagnostics, "invalid-value", `${path}.location`, "Attribute location must be 0 to 31.");
  if (typeof value.format !== "string" || !FORMATS.has(value.format)) issue(diagnostics, "invalid-value", `${path}.format`, "Unknown vertex format.");
  validValueType(value.type, `${path}.type`, diagnostics);
}

function validateVarying(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): void {
  if (!record(value)) { issue(diagnostics, "invalid-type", path, "Expected varying."); return; }
  exactFields(value, ["name", "location", "type", "interpolation"], path, diagnostics);
  validName(value.name, `${path}.name`, diagnostics);
  if (!Number.isSafeInteger(value.location) || (value.location as number) < 0 || (value.location as number) > 31) issue(diagnostics, "invalid-value", `${path}.location`, "Varying location must be 0 to 31.");
  validValueType(value.type, `${path}.type`, diagnostics);
  if (value.interpolation !== undefined && (typeof value.interpolation !== "string" || !INTERPOLATION.has(value.interpolation))) issue(diagnostics, "invalid-value", `${path}.interpolation`, "Unknown interpolation mode.");
}

function validateKeyword(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): void {
  if (!record(value)) { issue(diagnostics, "invalid-type", path, "Expected keyword."); return; }
  exactFields(value, ["name", "values", "default"], path, diagnostics);
  validName(value.name, `${path}.name`, diagnostics);
  const values = arrayField(value.values, `${path}.values`, 8, diagnostics);
  let previous = "";
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (typeof item !== "string" || !IDENTIFIER_VALUE.test(item)) issue(diagnostics, "invalid-value", `${path}.values.${index}`, "Expected canonical keyword value.");
    if (typeof item === "string" && item <= previous) issue(diagnostics, "non-deterministic", `${path}.values`, "Keyword values must be sorted and unique.");
    if (typeof item === "string") previous = item;
  }
  if (values.length < 1) issue(diagnostics, "invalid-value", `${path}.values`, "Keyword requires at least one value.");
  if (typeof value.default !== "string" || !values.includes(value.default)) issue(diagnostics, "invalid-value", `${path}.default`, "Default must be one of the keyword values.");
}
const IDENTIFIER_VALUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function validateNode(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): void {
  if (!record(value)) { issue(diagnostics, "invalid-type", path, "Expected shader node."); return; }
  const idValid = validName(value.id, `${path}.id`, diagnostics);
  const typeValid = validValueType(value.type, `${path}.type`, diagnostics);
  if (typeof value.op !== "string") issue(diagnostics, "invalid-type", `${path}.op`, "Expected shader node operation.");
  if (!idValid || !typeValid || typeof value.op !== "string") return;
  const common = ["id", "type", "op"];
  if (value.op === "literal") {
    exactFields(value, [...common, "value"], path, diagnostics);
    if (!validTypedValue(value.type as ShaderValueType, value.value)) issue(diagnostics, "type-mismatch", `${path}.value`, "Literal does not match node type.");
  } else if (["property", "attribute", "varying"].includes(value.op)) {
    exactFields(value, [...common, "name"], path, diagnostics);
    validName(value.name, `${path}.name`, diagnostics);
  } else if (value.op === "pbr-frame-view") {
    exactFields(value, common, path, diagnostics);
  } else if ([
    "add", "subtract", "multiply", "divide", "min", "max", "pow", "dot", "cross", "scale",
    "transform-direction", "transform-position",
  ].includes(value.op)) validateInputs(value, path, common, 2, diagnostics);
  else if (["select", "clamp", "mix"].includes(value.op)) validateInputs(value, path, common, 3, diagnostics);
  else if (["normalize", "negate", "saturate"].includes(value.op)) validateInputs(value, path, common, 1, diagnostics);
  else if (value.op === "compose-vec4") validateInputs(value, path, common, 2, diagnostics);
  else if (value.op === "swizzle") {
    validateInputs(value, path, [...common, "mask"], 1, diagnostics);
    if (typeof value.mask !== "string" || !/^[xyzwrgba]{1,4}$/.test(value.mask)) issue(diagnostics, "invalid-value", `${path}.mask`, "Invalid swizzle mask.");
  } else if (value.op === "texture-sample") {
    validateInputs(value, path, [...common, "texture", "sampler"], 1, diagnostics);
    validName(value.texture, `${path}.texture`, diagnostics);
    validName(value.sampler, `${path}.sampler`, diagnostics);
  } else issue(diagnostics, "invalid-value", `${path}.op`, "Unknown shader node operation.");
}

function validateInputs(value: Record<string, unknown>, path: string, fields: string[], count: number, diagnostics: ShaderDiagnostic[]): void {
  exactFields(value, [...fields, "inputs"], path, diagnostics);
  if (!Array.isArray(value.inputs) || value.inputs.length !== count) { issue(diagnostics, "invalid-value", `${path}.inputs`, `Expected ${count} node inputs.`); return; }
  value.inputs.forEach((input, index) => validName(input, `${path}.inputs.${index}`, diagnostics));
}

function validateGraph(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): void {
  if (!record(value)) { issue(diagnostics, "invalid-type", path, "Expected stage graph."); return; }
  exactFields(value, ["nodes", "outputs"], path, diagnostics);
  arrayField(value.nodes, `${path}.nodes`, DEEP_SHADER_BUDGETS.maxNodesPerStage, diagnostics).forEach((node, index) => validateNode(node, `${path}.nodes.${index}`, diagnostics));
  arrayField(value.outputs, `${path}.outputs`, 32, diagnostics).forEach((output, index) => {
    const outputPath = `${path}.outputs.${index}`;
    if (!record(output)) { issue(diagnostics, "invalid-type", outputPath, "Expected stage output."); return; }
    if (output.semantic === "surface") {
      exactFields(output, ["semantic", "model", "context", "fields"], outputPath, diagnostics);
      if (output.model !== "standard-pbr") issue(diagnostics, "invalid-value", `${outputPath}.model`, "Unknown surface model.");
      if (output.context !== "deep-lighting-v1") issue(diagnostics, "invalid-value", `${outputPath}.context`, "Unknown lighting context.");
      const fields = output.fields;
      if (!record(fields)) issue(diagnostics, "invalid-type", `${outputPath}.fields`, "Expected standard surface fields.");
      else {
        exactFields(fields, DEEP_STANDARD_SURFACE_FIELD_NAMES, `${outputPath}.fields`, diagnostics);
        DEEP_STANDARD_SURFACE_FIELD_NAMES.forEach((field) => validName(fields[field], `${outputPath}.fields.${field}`, diagnostics));
      }
      return;
    }
    exactFields(output, ["semantic", "node", "name"], outputPath, diagnostics);
    if (!new Set(["position", "color", "varying"]).has(output.semantic as string)) issue(diagnostics, "invalid-value", `${outputPath}.semantic`, "Unknown stage output semantic.");
    validName(output.node, `${outputPath}.node`, diagnostics);
    if (output.semantic === "varying") validName(output.name, `${outputPath}.name`, diagnostics);
    else if (output.name !== undefined) issue(diagnostics, "invalid-value", `${outputPath}.name`, "Only varying outputs may have a name.");
  });
}

function validatePass(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): void {
  if (!record(value)) { issue(diagnostics, "invalid-type", path, "Expected shader pass."); return; }
  exactFields(value, ["id", "kind", "predicate", "requirements", "state", "vertex", "fragment"], path, diagnostics);
  validName(value.id, `${path}.id`, diagnostics);
  if (typeof value.kind !== "string" || !PASS_KINDS.has(value.kind)) issue(diagnostics, "invalid-value", `${path}.kind`, "Unknown pass kind.");
  if (value.predicate !== undefined) validatePredicate(value.predicate, `${path}.predicate`, diagnostics);
  if (value.requirements !== undefined) validateRequirements(value.requirements, `${path}.requirements`, diagnostics);
  validateRenderState(value.state, `${path}.state`, diagnostics);
  validateGraph(value.vertex, `${path}.vertex`, diagnostics);
  if (value.fragment !== undefined) validateGraph(value.fragment, `${path}.fragment`, diagnostics);
}

export function validateShaderSchema(input: unknown, diagnostics: ShaderDiagnostic[]): DeepShaderAsset | undefined {
  if (!inspectCanonicalShaderInput(input, diagnostics)) return undefined;
  if (!record(input)) { issue(diagnostics, "invalid-type", "$", "Expected shader asset record."); return undefined; }
  exactFields(input, ["schemaVersion", "id", "label", "properties", "resources", "attributes", "varyings", "keywords", "techniques"], "$", diagnostics);
  if (input.schemaVersion !== 1) issue(diagnostics, "invalid-value", "$.schemaVersion", "Unsupported shader schema version.");
  if (typeof input.id !== "string" || !ASSET_ID.test(input.id)) issue(diagnostics, "invalid-value", "$.id", "Expected canonical lowercase asset id.");
  if (input.label !== undefined && (typeof input.label !== "string" || input.label.length === 0)) issue(diagnostics, "invalid-value", "$.label", "Label must be non-empty.");
  const properties = arrayField(input.properties, "$.properties", DEEP_SHADER_BUDGETS.maxProperties, diagnostics);
  const resources = arrayField(input.resources, "$.resources", DEEP_SHADER_BUDGETS.maxResources, diagnostics);
  const attributes = arrayField(input.attributes, "$.attributes", DEEP_SHADER_BUDGETS.maxAttributes, diagnostics);
  const varyings = arrayField(input.varyings, "$.varyings", DEEP_SHADER_BUDGETS.maxVaryings, diagnostics);
  const keywords = arrayField(input.keywords, "$.keywords", DEEP_SHADER_BUDGETS.maxKeywords, diagnostics);
  properties.forEach((value, index) => validateProperty(value, `$.properties.${index}`, diagnostics));
  resources.forEach((value, index) => validateResource(value, `$.resources.${index}`, diagnostics));
  attributes.forEach((value, index) => validateAttribute(value, `$.attributes.${index}`, diagnostics));
  varyings.forEach((value, index) => validateVarying(value, `$.varyings.${index}`, diagnostics));
  keywords.forEach((value, index) => validateKeyword(value, `$.keywords.${index}`, diagnostics));
  let passCount = 0;
  arrayField(input.techniques, "$.techniques", DEEP_SHADER_BUDGETS.maxTechniques, diagnostics).forEach((technique, techniqueIndex) => {
    const path = `$.techniques.${techniqueIndex}`;
    if (!record(technique)) { issue(diagnostics, "invalid-type", path, "Expected technique."); return; }
    exactFields(technique, ["id", "predicate", "requirements", "passes"], path, diagnostics);
    validName(technique.id, `${path}.id`, diagnostics);
    if (technique.predicate !== undefined) validatePredicate(technique.predicate, `${path}.predicate`, diagnostics);
    validateRequirements(technique.requirements, `${path}.requirements`, diagnostics);
    const passes = arrayField(technique.passes, `${path}.passes`, DEEP_SHADER_BUDGETS.maxPasses, diagnostics);
    passCount += passes.length;
    passes.forEach((pass, passIndex) => validatePass(pass, `${path}.passes.${passIndex}`, diagnostics));
  });
  if (passCount > DEEP_SHADER_BUDGETS.maxPasses) issue(diagnostics, "budget-exceeded", "$.techniques", `Shader contains more than ${DEEP_SHADER_BUDGETS.maxPasses} total passes.`);
  if (passCount === 0) issue(diagnostics, "invalid-value", "$.techniques", "Shader requires at least one pass.");
  if (diagnostics.length > 0) return undefined;
  return input as unknown as DeepShaderAsset;
}

export function nodeInputs(node: ShaderNode): readonly string[] {
  return "inputs" in node ? node.inputs : [];
}

export function outputNodeIds(output: ShaderStageOutput): readonly string[] {
  return output.semantic === "surface"
    ? DEEP_STANDARD_SURFACE_FIELD_NAMES.map((field) => output.fields[field])
    : [output.node];
}

export function stageGraph(value: unknown): ShaderStageGraph { return value as ShaderStageGraph; }
