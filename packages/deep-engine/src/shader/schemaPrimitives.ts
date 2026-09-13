import { IDENTIFIER } from "./constants.js";
import { issue } from "./diagnostics.js";
import { exactFields, record } from "./safeInput.js";
import type {
  ShaderDiagnostic, ShaderFeaturePredicate, ShaderRenderState,
  ShaderTargetRequirements, ShaderValueType,
} from "./types.js";

const VALUE_TYPES = new Set(["f32", "i32", "u32", "bool", "vec2f", "vec3f", "vec4f", "color", "mat3x3f", "mat4x4f"]);
const CAPABILITIES = new Set(["depth-clip-control", "float32-filterable", "indirect-first-instance", "shader-f16", "texture-compression-bc", "texture-compression-etc2", "texture-compression-astc"]);
const TOPOLOGIES = new Set(["triangle-list", "triangle-strip", "line-list", "line-strip", "point-list"]);
const CULL_MODES = new Set(["none", "front", "back"]);
const FRONT_FACES = new Set(["ccw", "cw"]);
const DEPTH_COMPARE = new Set(["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"]);
const BLEND_FACTORS = new Set(["zero", "one", "src", "one-minus-src", "src-alpha", "one-minus-src-alpha", "dst", "one-minus-dst", "dst-alpha", "one-minus-dst-alpha"]);
const BLEND_OPERATIONS = new Set(["add", "subtract", "reverse-subtract", "min", "max"]);
const WGSL_RESERVED = new Set([
  "alias", "break", "case", "const", "const_assert", "continue", "continuing", "default",
  "diagnostic", "discard", "else", "enable", "false", "fn", "for", "if", "let", "loop",
  "override", "requires", "return", "struct", "switch", "true", "var", "while",
]);

export function validName(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || WGSL_RESERVED.has(value) || ["__proto__", "constructor", "prototype"].includes(value)) {
    issue(diagnostics, "invalid-value", path, "Expected a safe shader identifier.");
    return false;
  }
  return true;
}

export function validValueType(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): value is ShaderValueType {
  if (typeof value !== "string" || !VALUE_TYPES.has(value)) {
    issue(diagnostics, "invalid-value", path, "Unknown shader value type.");
    return false;
  }
  return true;
}

function numberArray(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

export function validTypedValue(type: ShaderValueType, value: unknown): boolean {
  switch (type) {
    case "bool": return typeof value === "boolean";
    case "f32": return typeof value === "number" && Number.isFinite(value);
    case "i32": return typeof value === "number" && Number.isSafeInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647;
    case "u32": return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 4_294_967_295;
    case "vec2f": return numberArray(value, 2);
    case "vec3f": return numberArray(value, 3);
    case "vec4f": case "color": return numberArray(value, 4);
    case "mat3x3f": return numberArray(value, 9);
    case "mat4x4f": return numberArray(value, 16);
  }
}

export function validateRequirements(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): value is ShaderTargetRequirements {
  if (!record(value)) { issue(diagnostics, "invalid-type", path, "Expected target requirements record."); return false; }
  exactFields(value, ["webgpu", "features", "minLimits"], path, diagnostics);
  if (value.webgpu !== true) issue(diagnostics, "invalid-value", `${path}.webgpu`, "WebGPU is the only supported shader target.");
  if (value.features !== undefined) {
    if (!Array.isArray(value.features)) issue(diagnostics, "invalid-type", `${path}.features`, "Expected feature array.");
    else {
      let previous = "";
      for (let index = 0; index < value.features.length; index += 1) {
        const feature = value.features[index];
        if (typeof feature !== "string" || !CAPABILITIES.has(feature)) issue(diagnostics, "invalid-value", `${path}.features.${index}`, "Unknown capability.");
        if (typeof feature === "string" && feature <= previous) issue(diagnostics, "non-deterministic", `${path}.features`, "Capabilities must be sorted and unique.");
        if (typeof feature === "string") previous = feature;
      }
    }
  }
  if (value.minLimits !== undefined) {
    if (!record(value.minLimits)) issue(diagnostics, "invalid-type", `${path}.minLimits`, "Expected limits record.");
    else {
      exactFields(value.minLimits, ["maxBindGroups", "maxBindingsPerBindGroup", "maxInterStageShaderVariables"], `${path}.minLimits`, diagnostics);
      for (const [key, limit] of Object.entries(value.minLimits)) {
        if (!Number.isSafeInteger(limit) || (limit as number) < 1) issue(diagnostics, "invalid-value", `${path}.minLimits.${key}`, "Limit must be a positive integer.");
      }
    }
  }
  return true;
}

export function validatePredicate(value: unknown, path: string, diagnostics: ShaderDiagnostic[], depth = 0): value is ShaderFeaturePredicate {
  if (depth > 16) { issue(diagnostics, "budget-exceeded", path, "Predicate nesting exceeds 16 levels."); return false; }
  if (!record(value) || typeof value.op !== "string") { issue(diagnostics, "invalid-type", path, "Expected feature predicate."); return false; }
  if (value.op === "keyword") {
    exactFields(value, ["op", "name", "equals"], path, diagnostics);
    validName(value.name, `${path}.name`, diagnostics);
    if (typeof value.equals !== "string" || value.equals.length === 0) issue(diagnostics, "invalid-value", `${path}.equals`, "Expected keyword value.");
  } else if (value.op === "capability") {
    exactFields(value, ["op", "name"], path, diagnostics);
    if (typeof value.name !== "string" || !CAPABILITIES.has(value.name)) issue(diagnostics, "invalid-value", `${path}.name`, "Unknown capability.");
  } else if (value.op === "all" || value.op === "any") {
    exactFields(value, ["op", "terms"], path, diagnostics);
    if (!Array.isArray(value.terms) || value.terms.length === 0 || value.terms.length > 32) issue(diagnostics, "invalid-value", `${path}.terms`, "Predicate terms must contain 1 to 32 entries.");
    else value.terms.forEach((term, index) => validatePredicate(term, `${path}.terms.${index}`, diagnostics, depth + 1));
  } else if (value.op === "not") {
    exactFields(value, ["op", "term"], path, diagnostics);
    validatePredicate(value.term, `${path}.term`, diagnostics, depth + 1);
  } else issue(diagnostics, "invalid-value", `${path}.op`, "Unknown predicate operation.");
  return true;
}

function validateBlendComponent(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): void {
  if (!record(value)) { issue(diagnostics, "invalid-type", path, "Expected blend component."); return; }
  exactFields(value, ["srcFactor", "dstFactor", "operation"], path, diagnostics);
  if (typeof value.srcFactor !== "string" || !BLEND_FACTORS.has(value.srcFactor)) issue(diagnostics, "invalid-state", `${path}.srcFactor`, "Unknown blend factor.");
  if (typeof value.dstFactor !== "string" || !BLEND_FACTORS.has(value.dstFactor)) issue(diagnostics, "invalid-state", `${path}.dstFactor`, "Unknown blend factor.");
  if (typeof value.operation !== "string" || !BLEND_OPERATIONS.has(value.operation)) issue(diagnostics, "invalid-state", `${path}.operation`, "Unknown blend operation.");
}

export function validateRenderState(value: unknown, path: string, diagnostics: ShaderDiagnostic[]): value is ShaderRenderState {
  if (!record(value)) { issue(diagnostics, "invalid-type", path, "Expected render state."); return false; }
  exactFields(value, ["topology", "cullMode", "frontFace", "depthCompare", "depthWrite", "colorWriteMask", "blend"], path, diagnostics);
  if (typeof value.topology !== "string" || !TOPOLOGIES.has(value.topology)) issue(diagnostics, "invalid-state", `${path}.topology`, "Unknown primitive topology.");
  if (typeof value.cullMode !== "string" || !CULL_MODES.has(value.cullMode)) issue(diagnostics, "invalid-state", `${path}.cullMode`, "Unknown cull mode.");
  if (typeof value.frontFace !== "string" || !FRONT_FACES.has(value.frontFace)) issue(diagnostics, "invalid-state", `${path}.frontFace`, "Unknown front face.");
  if (typeof value.depthCompare !== "string" || !DEPTH_COMPARE.has(value.depthCompare)) issue(diagnostics, "invalid-state", `${path}.depthCompare`, "Unknown depth compare function.");
  if (typeof value.depthWrite !== "boolean") issue(diagnostics, "invalid-type", `${path}.depthWrite`, "Expected boolean.");
  if (!Number.isSafeInteger(value.colorWriteMask) || (value.colorWriteMask as number) < 0 || (value.colorWriteMask as number) > 15) issue(diagnostics, "invalid-state", `${path}.colorWriteMask`, "Color write mask must be an integer from 0 to 15.");
  if (value.blend !== undefined) {
    if (!record(value.blend)) issue(diagnostics, "invalid-type", `${path}.blend`, "Expected blend state.");
    else {
      exactFields(value.blend, ["color", "alpha"], `${path}.blend`, diagnostics);
      validateBlendComponent(value.blend.color, `${path}.blend.color`, diagnostics);
      validateBlendComponent(value.blend.alpha, `${path}.blend.alpha`, diagnostics);
    }
  }
  return true;
}
