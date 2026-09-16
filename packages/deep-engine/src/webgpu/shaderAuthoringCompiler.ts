/// <reference types="@webgpu/types" />
import type { ShaderCompileCapabilities, ShaderCapability } from "../shader/index.js";
import { compileDeepSlSurface } from "../shaderAuthoring/deepSlCompiler.js";
import {
  type ShaderAuthoringCompileRequest,
  type ShaderAuthoringCompilerResult,
  type ShaderAuthoringDiagnostic,
  type ShaderAuthoringSourceMapEntry,
  type ShaderTextCompiler,
  type ShaderTextRange,
} from "../shaderAuthoring/types.js";

const SUPPORTED_FEATURES = new Set<ShaderCapability>([
  "depth-clip-control", "float32-filterable", "indirect-first-instance", "shader-f16",
  "texture-compression-astc", "texture-compression-bc", "texture-compression-etc2",
]);

type TextSourceMapEntry = Extract<ShaderAuthoringSourceMapEntry,
  { readonly sourceKind: "text-range" }>;

/** Converts the active WebGPU device into the deterministic capability contract used by DeepSL. */
export function shaderCapabilitiesForDevice(device: GPUDevice): ShaderCompileCapabilities {
  const features = [...device.features]
    .filter((feature): feature is ShaderCapability => SUPPORTED_FEATURES.has(feature as ShaderCapability))
    .sort();
  return Object.freeze({ features: Object.freeze(features), limits: Object.freeze({
    maxBindGroups: device.limits.maxBindGroups,
    maxBindingsPerBindGroup: device.limits.maxBindingsPerBindGroup,
    maxInterStageShaderVariables: device.limits.maxInterStageShaderVariables,
  }) });
}

/**
 * Builds the editor-facing DeepSL compiler for one device epoch. The returned artifact is
 * accepted only after the browser driver has compiled its WGSL; errors map back to source.
 */
export function createWebGpuDeepSlCompiler(device: GPUDevice): ShaderTextCompiler {
  const capabilities = shaderCapabilitiesForDevice(device);
  return async (request) => compileOnDevice(device, capabilities, request);
}

async function compileOnDevice(device: GPUDevice, capabilities: ShaderCompileCapabilities,
  request: ShaderAuthoringCompileRequest): Promise<ShaderAuthoringCompilerResult> {
  const compiled = compileDeepSlSurface(request, { capabilities });
  if (!compiled.success || !compiled.artifact) return compiled;
  try {
    const runtimeModules = compiled.artifact.runtimePackage?.modules;
    const modules = runtimeModules?.length ? runtimeModules : [{ id: "preview", source: compiled.artifact.pass.module.code }];
    const messages: ShaderAuthoringDiagnostic[] = [];
    for (const value of modules) {
      const module = device.createShaderModule({
        label: `DeepSL ${request.document.id} ${value.id} ${request.revision.slice(0, 8)}`,
        code: value.source,
      });
      const sourceMap = runtimeModules?.length ? [] : compiled.artifact.sourceMap;
      messages.push(...(await module.getCompilationInfo()).messages
        .filter(message => message.type !== "info")
        .map(message => gpuDiagnostic(message, sourceMap,
          request.document.source.split(/\r?\n/u).length)));
    }
    const diagnostics = Object.freeze([...compiled.diagnostics, ...messages]);
    if (messages.some(entry => entry.severity === "error")) {
      return Object.freeze({ success: false, diagnostics });
    }
    return Object.freeze({ success: true, diagnostics, artifact: compiled.artifact });
  } catch (error) {
    return Object.freeze({ success: false, diagnostics: Object.freeze([...compiled.diagnostics,
      diagnostic("gpu-compilation-unavailable", errorMessage(error), wholeSource(request))]) });
  }
}

function gpuDiagnostic(message: GPUCompilationMessage,
  sourceMap: readonly ShaderAuthoringSourceMapEntry[], sourceLineCount: number): ShaderAuthoringDiagnostic {
  const mapped = sourceMap.find((entry): entry is TextSourceMapEntry =>
    entry.sourceKind === "text-range" && entry.generatedLine === message.lineNum);
  const range = mapped?.range ?? Object.freeze({ start: Object.freeze({ line: 1, column: 1 }),
    end: Object.freeze({ line: Math.max(1, sourceLineCount), column: 1 }) });
  return diagnostic(`wgsl-${message.type}`, `WGSL ${Math.max(1, message.lineNum)}:${Math.max(1,
    message.linePos)} · ${message.message}`, range, message.type === "error" ? "error" : "warning");
}

function wholeSource(request: ShaderAuthoringCompileRequest): ShaderTextRange {
  return Object.freeze({ start: Object.freeze({ line: 1, column: 1 }), end: Object.freeze({
    line: Math.max(1, request.document.source.split(/\r?\n/u).length), column: 1,
  }) });
}

function diagnostic(code: string, message: string, range: ShaderTextRange,
  severity: ShaderAuthoringDiagnostic["severity"] = "error"): ShaderAuthoringDiagnostic {
  return Object.freeze({ severity, source: "text-compiler", code, path: "$.source", message, range });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
