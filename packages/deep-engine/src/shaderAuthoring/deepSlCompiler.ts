import { compileShaderPass } from "../shader/index.js";
import {
  buildStandardSurfaceShader,
  buildUnlitShader,
  type ShaderPresetIssue,
  type StandardSurfaceShaderOptions,
  type UnlitShaderOptions,
} from "../shaderPresets/index.js";
import type {
  ShaderAuthoringCompileRequest,
  ShaderAuthoringCompilerResult,
  ShaderAuthoringDiagnostic,
  ShaderAuthoringSourceMapEntry,
  ShaderTextCompiler,
  ShaderTextRange,
} from "./types.js";
import { parseDeepSlDocument } from "./deepSlParser.js";
import { deepSlIssue } from "./deepSlSyntax.js";
import type { DeepSlCompilerOptions } from "./deepSlTypes.js";

function presetDiagnostic(
  entry: ShaderPresetIssue,
  fields: ReadonlyMap<string, ShaderTextRange>,
  sourceRange: ShaderTextRange,
): ShaderAuthoringDiagnostic {
  const rawField = entry.path.startsWith("$.") ? entry.path.slice(2) : "";
  const field = rawField === "alphaMode" ? "alpha" : rawField;
  return Object.freeze({
    severity: entry.severity,
    source: "text-compiler",
    code: entry.code,
    path: entry.path,
    message: entry.message,
    range: fields.get(field) ?? sourceRange,
  });
}

function mappedSourceRange(
  nodeId: string,
  fields: ReadonlyMap<string, ShaderTextRange>,
  fallback: ShaderTextRange,
): ShaderTextRange {
  if (nodeId === "surfaceUv" || nodeId === "baseColorSample") return fields.get("baseColorTexture") ?? fallback;
  if (["baseColor", "tintedBaseColor", "surfaceBaseColor", "alpha"].includes(nodeId)) return fields.get("baseColor") ?? fallback;
  if (nodeId.includes("metal")) return fields.get("metallic") ?? fallback;
  if (nodeId.includes("rough")) return fields.get("roughness") ?? fallback;
  return fields.get("shader") ?? fallback;
}

export function compileDeepSlSurface(
  request: ShaderAuthoringCompileRequest,
  options: DeepSlCompilerOptions,
): ShaderAuthoringCompilerResult {
  const parsed = parseDeepSlDocument(request.document.source);
  if (!parsed.inspection.success || !parsed.inspection.model) {
    return Object.freeze({ success: false, diagnostics: parsed.inspection.diagnostics });
  }
  const model = parsed.inspection.model;
  const common = {
    id: model.shaderId,
    baseColor: model.baseColor,
    baseColorTexture: model.baseColorTexture,
    alphaMode: model.alpha,
    doubleSided: model.doubleSided,
  } as const;
  const built = model.surface === "standard"
    ? buildStandardSurfaceShader({ ...common, metallic: model.metallic, roughness: model.roughness } satisfies StandardSurfaceShaderOptions)
    : buildUnlitShader(common satisfies UnlitShaderOptions);
  const wholeSource = Object.freeze({
    start: Object.freeze({ line: 1, column: 1 }),
    end: Object.freeze({ line: Math.max(1, request.document.source.split(/\r?\n/u).length), column: 1 }),
  });
  const presetDiagnostics = built.issues.map((entry) => presetDiagnostic(entry, parsed.fields, wholeSource));
  if (!built.ok) return Object.freeze({ success: false, diagnostics: Object.freeze(presetDiagnostics) });
  const forward = built.asset.techniques[0]?.passes.find((pass) => pass.kind === "forward");
  if (!forward) {
    return Object.freeze({
      success: false,
      diagnostics: Object.freeze([
        deepSlIssue({ line: 1, firstColumn: 1, text: "shader" }, "missing-pass", "DeepSL did not produce a forward pass."),
      ]),
    });
  }
  const compiled = compileShaderPass(built.asset, "webgpu", forward.id, options.capabilities);
  const compileDiagnostics: ShaderAuthoringDiagnostic[] = compiled.diagnostics.map((entry) => Object.freeze({
    severity: "error" as const,
    source: "text-compiler" as const,
    code: entry.code,
    path: entry.path,
    message: entry.message,
    range: wholeSource,
  }));
  const diagnostics = Object.freeze([...presetDiagnostics, ...compileDiagnostics]);
  if (!compiled.success || !compiled.value) return Object.freeze({ success: false, diagnostics });
  const sourceMap: readonly ShaderAuthoringSourceMapEntry[] = Object.freeze(compiled.value.sourceMap.map((entry) => Object.freeze({
    sourceKind: "text-range" as const,
    range: mappedSourceRange(entry.nodeId, parsed.fields, wholeSource),
    generatedLine: entry.generatedLine,
  })));
  return Object.freeze({
    success: true,
    diagnostics,
    artifact: Object.freeze({ target: "webgpu", pass: compiled.value, sourceMap }),
  });
}

export function createDeepSlCompiler(options: DeepSlCompilerOptions): ShaderTextCompiler {
  return (request) => compileDeepSlSurface(request, options);
}
