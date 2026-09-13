import { SHADER_AUTHORING_BUDGETS } from "./types.js";
import { appendDeepSlDiagnostic, parseDeepSlStatement, setDeepSlFieldOnce } from "./deepSlStatementParser.js";
import { deepSlIssue, DEEP_SL_IDENTIFIER, lexDeepSlLines } from "./deepSlSyntax.js";
import type { DeepSlInspection, DeepSlParsedDocument, DeepSlParsedLine, DeepSlParseState,
  DeepSlSurfaceModel, DeepSlTextureTransform, DeepSlTextureTransformFieldName } from "./deepSlTypes.js";

const BUDGET_LINE = Object.freeze({ line: 1, firstColumn: 1, text: "" });

function identityTextureTransform(): DeepSlTextureTransform {
  return { texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 };
}

function createParseState(): DeepSlParseState {
  return {
    model: {
      shaderId: "", surface: "standard", baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1,
      alpha: "opaque", doubleSided: false, baseColorTexture: false, metallicRoughnessTexture: false,
      normalTexture: false, occlusionTexture: false, emissiveTexture: false,
      baseColorTextureTransform: identityTextureTransform(), metallicRoughnessTextureTransform: identityTextureTransform(),
      normalTextureTransform: identityTextureTransform(), occlusionTextureTransform: identityTextureTransform(),
      emissiveTextureTransform: identityTextureTransform(), normalScale: 1, occlusionStrength: 1,
      emissiveFactor: [0, 0, 0], emissiveStrength: 1,
    },
    diagnostics: [], fields: new Map(), opened: false, closed: false,
  };
}

function budgetFailure(source: string): DeepSlParsedDocument | undefined {
  if (source.length > SHADER_AUTHORING_BUDGETS.maxSourceLength) return {
    inspection: Object.freeze({ success: false, diagnostics: Object.freeze([
      deepSlIssue(BUDGET_LINE, "budget-exceeded", "DeepSL source exceeds the editor source-length budget."),
    ]) }), fields: new Map(),
  };
  let lineCount = 1;
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) === 10 && ++lineCount > SHADER_AUTHORING_BUDGETS.maxSourceLines) return {
      inspection: Object.freeze({ success: false, diagnostics: Object.freeze([
        deepSlIssue(BUDGET_LINE, "budget-exceeded", "DeepSL source exceeds the editor line budget."),
      ]) }), fields: new Map(),
    };
  }
  return undefined;
}

function parseDeclarationLine(line: DeepSlParsedLine, state: DeepSlParseState): void {
  const header = /^shader\s+([^\s{]+)\s*\{$/u.exec(line.text);
  if (!state.opened) {
    if (!header) appendDeepSlDiagnostic(state, deepSlIssue(line, "expected-header", "Expected 'shader <id> {' as the first declaration."));
    else {
      state.opened = true;
      const shaderId = header[1]!;
      if (!DEEP_SL_IDENTIFIER.test(shaderId)) appendDeepSlDiagnostic(state, deepSlIssue(line, "invalid-identifier", "Shader id must be a stable ASCII identifier."));
      else setDeepSlFieldOnce(state, "shader", line, () => { state.model.shaderId = shaderId; });
    }
    return;
  }
  if (state.closed) { appendDeepSlDiagnostic(state, deepSlIssue(line, "trailing-content", "Content after the shader closing brace is not allowed.")); return; }
  if (line.text === "}") { state.closed = true; return; }
  if (/^shader\b/u.test(line.text)) { appendDeepSlDiagnostic(state, deepSlIssue(line, "nested-shader", "Nested shader declarations are not allowed.")); return; }
  parseDeepSlStatement(line, state);
}

function immutableModel(state: DeepSlParseState): DeepSlSurfaceModel {
  return Object.freeze({
    ...state.model,
    baseColor: Object.freeze([...state.model.baseColor]) as unknown as DeepSlSurfaceModel["baseColor"],
    emissiveFactor: Object.freeze([...state.model.emissiveFactor]) as unknown as DeepSlSurfaceModel["emissiveFactor"],
    ...Object.fromEntries([
      "baseColorTextureTransform", "metallicRoughnessTextureTransform", "normalTextureTransform",
      "occlusionTextureTransform", "emissiveTextureTransform",
    ].map((field) => {
      const value = state.model[field as DeepSlTextureTransformFieldName];
      return [field, Object.freeze({ ...value, offset: Object.freeze([...value.offset]), scale: Object.freeze([...value.scale]) })];
    })),
  });
}

export function parseDeepSlDocument(source: string): DeepSlParsedDocument {
  const overBudget = budgetFailure(source);
  if (overBudget) return overBudget;
  const lines = lexDeepSlLines(source), state = createParseState();
  for (const line of lines) if (line.text) parseDeclarationLine(line, state);
  const eof: DeepSlParsedLine = Object.freeze({ line: Math.max(1, lines.length), firstColumn: 1, text: "" });
  if (!state.opened) appendDeepSlDiagnostic(state, deepSlIssue(eof, "missing-header", "DeepSL source requires a shader declaration."));
  else if (!state.closed) appendDeepSlDiagnostic(state, deepSlIssue(eof, "missing-brace", "DeepSL shader declaration requires a closing brace."));
  if (!state.fields.has("surface")) appendDeepSlDiagnostic(state, deepSlIssue(eof, "missing-field", "DeepSL shader requires a surface declaration."));
  const diagnostics = Object.freeze(state.diagnostics);
  const inspection: DeepSlInspection = diagnostics.some((entry) => entry.severity === "error")
    ? Object.freeze({ success: false, diagnostics })
    : Object.freeze({ success: true, diagnostics, model: immutableModel(state) });
  return { inspection, fields: state.fields };
}

export function inspectDeepSlSurface(source: unknown): DeepSlInspection {
  if (typeof source !== "string") return Object.freeze({ success: false, diagnostics: Object.freeze([
    deepSlIssue(BUDGET_LINE, "invalid-source", "DeepSL source must be text."),
  ]) });
  return parseDeepSlDocument(source).inspection;
}
