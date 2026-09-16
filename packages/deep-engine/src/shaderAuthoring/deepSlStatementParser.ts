import { MAX_EMISSIVE_STRENGTH } from "../renderPacket.js";
import { SHADER_AUTHORING_BUDGETS } from "./types.js";
import type { ShaderAuthoringDiagnostic } from "./types.js";
import { deepSlIssue, deepSlLineRange, DEEP_SL_FINITE_NUMBER, DEEP_SL_UNIT_NUMBER,
  finiteFloat32Values } from "./deepSlSyntax.js";
import type { DeepSlFieldName, DeepSlMutableModel, DeepSlParsedLine, DeepSlParseState,
  DeepSlTextureFieldName, DeepSlTextureTransformFieldName } from "./deepSlTypes.js";

export function appendDeepSlDiagnostic(state: DeepSlParseState, diagnostic: ShaderAuthoringDiagnostic): void {
  if (state.diagnostics.length < SHADER_AUTHORING_BUDGETS.maxIssues) state.diagnostics.push(diagnostic);
}

export function setDeepSlFieldOnce(
  state: DeepSlParseState,
  field: DeepSlFieldName,
  line: DeepSlParsedLine,
  apply: () => void,
): void {
  if (state.fields.has(field)) {
    appendDeepSlDiagnostic(state, deepSlIssue(line, "duplicate-field", `DeepSL field '${field}' may only be declared once.`));
    return;
  }
  state.fields.set(field, deepSlLineRange(line));
  apply();
}

function parseCoreStatement(statement: string, line: DeepSlParsedLine, state: DeepSlParseState): boolean {
  let match: RegExpExecArray | null;
  if ((match = /^surface\s+(standard|unlit)$/u.exec(statement))) {
    setDeepSlFieldOnce(state, "surface", line, () => { state.model.surface = match![1] as DeepSlMutableModel["surface"]; }); return true;
  }
  if ((match = new RegExp(`^baseColor\\s+\\[(${DEEP_SL_UNIT_NUMBER})\\s*,\\s*(${DEEP_SL_UNIT_NUMBER})\\s*,\\s*(${DEEP_SL_UNIT_NUMBER})\\s*,\\s*(${DEEP_SL_UNIT_NUMBER})\\]$`, "u").exec(statement))) {
    setDeepSlFieldOnce(state, "baseColor", line, () => { state.model.baseColor = [Number(match![1]), Number(match![2]), Number(match![3]), Number(match![4])]; }); return true;
  }
  if ((match = new RegExp(`^(metallic|roughness)\\s+(${DEEP_SL_UNIT_NUMBER})$`, "u").exec(statement))) {
    const field = match[1] as "metallic" | "roughness";
    setDeepSlFieldOnce(state, field, line, () => { state.model[field] = Number(match![2]); }); return true;
  }
  if ((match = /^alpha\s+(opaque|blend|mask)$/u.exec(statement))) {
    setDeepSlFieldOnce(state, "alpha", line, () => { state.model.alpha = match![1] as DeepSlMutableModel["alpha"]; }); return true;
  }
  if ((match = /^doubleSided\s+(true|false)$/u.exec(statement))) {
    setDeepSlFieldOnce(state, "doubleSided", line, () => { state.model.doubleSided = match![1] === "true"; }); return true;
  }
  if ((match = /^(baseColorTexture|metallicRoughnessTexture|normalTexture|occlusionTexture|emissiveTexture)\s+(on|off)$/u.exec(statement))) {
    const field = match[1] as DeepSlTextureFieldName;
    setDeepSlFieldOnce(state, field, line, () => { state.model[field] = match![2] === "on"; }); return true;
  }
  return false;
}

function parseTextureTransform(statement: string, line: DeepSlParsedLine, state: DeepSlParseState): boolean {
  const match = new RegExp(`^(baseColor|metallicRoughness|normal|occlusion|emissive)TextureTransform\\s+texCoord\\s+([01])\\s+offset\\s+\\[(${DEEP_SL_FINITE_NUMBER})\\s*,\\s*(${DEEP_SL_FINITE_NUMBER})\\]\\s+scale\\s+\\[(${DEEP_SL_FINITE_NUMBER})\\s*,\\s*(${DEEP_SL_FINITE_NUMBER})\\]\\s+rotation\\s+(${DEEP_SL_FINITE_NUMBER})$`, "u").exec(statement);
  if (!match) return false;
  const field = `${match[1]}TextureTransform` as DeepSlTextureTransformFieldName;
  const values = match.slice(3, 8).map(Number);
  if (!finiteFloat32Values(values)) {
    appendDeepSlDiagnostic(state, deepSlIssue(line, "invalid-number", "Texture transform values must be finite float32 numbers.")); return true;
  }
  setDeepSlFieldOnce(state, field, line, () => { state.model[field] = {
    texCoord: Number(match[2]) as 0 | 1,
    offset: [values[0]!, values[1]!], scale: [values[2]!, values[3]!], rotation: values[4]!,
  }; });
  return true;
}

function parseMaterialParameter(statement: string, line: DeepSlParsedLine, state: DeepSlParseState): boolean {
  let match: RegExpExecArray | null;
  if ((match = new RegExp(`^normalScale\\s+(${DEEP_SL_FINITE_NUMBER})$`, "u").exec(statement))) {
    const value = Number(match[1]);
    if (!finiteFloat32Values([value])) appendDeepSlDiagnostic(state, deepSlIssue(line, "invalid-number", "normalScale must be a finite float32 number."));
    else setDeepSlFieldOnce(state, "normalScale", line, () => { state.model.normalScale = value; });
    return true;
  }
  if ((match = new RegExp(`^occlusionStrength\\s+(${DEEP_SL_FINITE_NUMBER})$`, "u").exec(statement))) {
    const value = Number(match[1]);
    if (!finiteFloat32Values([value])) appendDeepSlDiagnostic(state, deepSlIssue(line, "invalid-number", "occlusionStrength must be a finite float32 number."));
    else if (value < 0 || value > 1) appendDeepSlDiagnostic(state, deepSlIssue(line, "out-of-range", "occlusionStrength must be between 0 and 1."));
    else setDeepSlFieldOnce(state, "occlusionStrength", line, () => { state.model.occlusionStrength = value; });
    return true;
  }
  if ((match = new RegExp(`^emissiveFactor\\s+\\[(${DEEP_SL_FINITE_NUMBER})\\s*,\\s*(${DEEP_SL_FINITE_NUMBER})\\s*,\\s*(${DEEP_SL_FINITE_NUMBER})\\]$`, "u").exec(statement))) {
    const values = match.slice(1, 4).map(Number);
    if (!finiteFloat32Values(values)) appendDeepSlDiagnostic(state, deepSlIssue(line, "invalid-number", "emissiveFactor values must be finite float32 numbers."));
    else if (values.some((value) => value < 0 || value > 1)) appendDeepSlDiagnostic(state, deepSlIssue(line, "out-of-range", "emissiveFactor values must be between 0 and 1."));
    else setDeepSlFieldOnce(state, "emissiveFactor", line, () => { state.model.emissiveFactor = [values[0]!, values[1]!, values[2]!]; });
    return true;
  }
  if ((match = new RegExp(`^emissiveStrength\\s+(${DEEP_SL_FINITE_NUMBER})$`, "u").exec(statement))) {
    const value = Number(match[1]);
    if (!finiteFloat32Values([value])) appendDeepSlDiagnostic(state, deepSlIssue(line, "invalid-number", "emissiveStrength must be a finite float32 number."));
    else if (value < 0 || value > MAX_EMISSIVE_STRENGTH) appendDeepSlDiagnostic(state, deepSlIssue(line, "out-of-range", `emissiveStrength must be between 0 and ${MAX_EMISSIVE_STRENGTH}.`));
    else setDeepSlFieldOnce(state, "emissiveStrength", line, () => { state.model.emissiveStrength = value; });
    return true;
  }
  if ((match = new RegExp(`^(clearcoatFactor|clearcoatRoughness)\\s+(${DEEP_SL_FINITE_NUMBER})$`, "u").exec(statement))) {
    const field = match[1] as "clearcoatFactor" | "clearcoatRoughness";
    const value = Number(match[2]);
    if (!finiteFloat32Values([value])) appendDeepSlDiagnostic(state, deepSlIssue(line, "invalid-number", `${field} must be a finite float32 number.`));
    else if (value < 0 || value > 1) appendDeepSlDiagnostic(state, deepSlIssue(line, "out-of-range", `${field} must be between 0 and 1.`));
    else setDeepSlFieldOnce(state, field, line, () => { state.model[field] = value; });
    return true;
  }
  return false;
}

function appendKnownSyntaxError(statement: string, line: DeepSlParsedLine, state: DeepSlParseState): boolean {
  const known = [
    [/^(baseColor|metallicRoughness|normal|occlusion|emissive)TextureTransform\b/u, "invalid-texture-transform", "Texture transform must use texCoord 0 or 1, finite float32 offset/scale values, and a finite float32 rotation."],
    [/^normalScale\b/u, "invalid-number", "normalScale must be a finite float32 number."],
    [/^occlusionStrength\b/u, "invalid-number", "occlusionStrength must be a finite float32 number between 0 and 1."],
    [/^emissiveFactor\b/u, "invalid-number", "emissiveFactor must contain three finite float32 numbers between 0 and 1."],
    [/^emissiveStrength\b/u, "invalid-number", `emissiveStrength must be a finite float32 number between 0 and ${MAX_EMISSIVE_STRENGTH}.`],
    [/^(clearcoatFactor|clearcoatRoughness)\b/u, "invalid-number", "clearcoatFactor and clearcoatRoughness must be finite float32 numbers between 0 and 1."],
  ] as const;
  const match = known.find(([pattern]) => pattern.test(statement));
  if (!match) return false;
  appendDeepSlDiagnostic(state, deepSlIssue(line, match[1], match[2])); return true;
}

export function parseDeepSlStatement(line: DeepSlParsedLine, state: DeepSlParseState): void {
  const statement = line.text.endsWith(";") ? line.text.slice(0, -1).trimEnd() : line.text;
  if (parseCoreStatement(statement, line, state) || parseTextureTransform(statement, line, state)
    || parseMaterialParameter(statement, line, state) || appendKnownSyntaxError(statement, line, state)) return;
  appendDeepSlDiagnostic(state, deepSlIssue(line, "unknown-statement", "Unknown DeepSL surface statement."));
}
