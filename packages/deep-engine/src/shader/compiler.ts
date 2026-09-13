import { sha256Hex } from "./canonical.js";
import { collectPassBindings, validatePassBindings } from "./compilerAnalysis.js";
import { emitShaderPass } from "./compilerWgsl.js";
import { SHADER_SCOPE_GROUP } from "./constants.js";
import { frozenDiagnostics, issue } from "./diagnostics.js";
import { validateShaderAsset } from "./validation.js";
import { requirementsMet, validateCompileCapabilities } from "./variants.js";
import type {
  CompiledShaderPass,
  ShaderCompileResult,
  ShaderDiagnostic,
} from "./types.js";

export function compileShaderPass(
  input: unknown,
  techniqueId: string,
  passId: string,
  capabilitiesInput: unknown,
): ShaderCompileResult {
  const validation = validateShaderAsset(input);
  if (!validation.valid || !validation.value) return Object.freeze({ success: false, diagnostics: validation.diagnostics });
  const asset = validation.value;
  const diagnostics: ShaderDiagnostic[] = [];
  if (!validateCompileCapabilities(capabilitiesInput, diagnostics)) return Object.freeze({ success: false, diagnostics: frozenDiagnostics(diagnostics) });
  const capabilities = capabilitiesInput;
  const technique = asset.techniques.find((entry) => entry.id === techniqueId);
  const pass = technique?.passes.find((entry) => entry.id === passId);
  if (!technique) issue(diagnostics, "missing-symbol", "techniqueId", `Unknown technique ${techniqueId}.`);
  else if (!requirementsMet(technique.requirements, capabilities)) issue(diagnostics, "unsupported-capability", "capabilities", `Technique ${techniqueId} is not supported by this target.`);
  if (!pass) issue(diagnostics, "missing-symbol", "passId", `Unknown pass ${passId} in technique ${techniqueId}.`);
  else if (pass.requirements && !requirementsMet(pass.requirements, capabilities)) issue(diagnostics, "unsupported-capability", "capabilities", `Pass ${passId} is not supported by this target.`);
  const bindings = pass ? collectPassBindings(asset, pass) : undefined;
  if (pass && bindings) validatePassBindings(asset, pass, bindings, capabilities, diagnostics);
  if (!technique || !pass || !bindings || diagnostics.length > 0) return Object.freeze({ success: false, diagnostics: frozenDiagnostics(diagnostics) });

  const { code, propertyLayout, sourceMap } = emitShaderPass(asset, pass, bindings);
  const cacheKey = sha256Hex({
    schema: 1, assetId: asset.id, techniqueId, passId, kind: pass.kind, code, state: pass.state,
    propertyLayout,
    ...(bindings.lightingContext ? { lightingContext: bindings.lightingContext } : {}),
    bindings: [...bindings.resources].sort((a, b) => SHADER_SCOPE_GROUP[a.scope] - SHADER_SCOPE_GROUP[b.scope] || a.binding - b.binding || a.name.localeCompare(b.name))
      .map(({ name, scope, binding, kind, visibility }) => ({ name, scope, binding, kind, visibility })),
    attributes: [...asset.attributes].sort((a, b) => a.location - b.location)
      .map(({ name, location, format, type }) => ({ name, location, format, type })),
  });
  const value: CompiledShaderPass = Object.freeze({
    techniqueId, passId, kind: pass.kind, cacheKey,
    module: Object.freeze({ label: `${asset.id}/${techniqueId}/${passId}`, code }),
    entryPoints: Object.freeze(pass.fragment ? { vertex: "deepVertex", fragment: "deepFragment" } : { vertex: "deepVertex" }),
    propertyLayout: Object.freeze(propertyLayout),
    ...(bindings.lightingContext ? { lightingContext: bindings.lightingContext } : {}),
    sourceMap: Object.freeze(sourceMap), renderState: pass.state,
  });
  return Object.freeze({ success: true, diagnostics: Object.freeze([]), value });
}
