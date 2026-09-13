import {
  compileDeepSlSurface,
  createShaderAuthoringSession,
  DEEP_SL_SURFACE_EXAMPLE,
  type ShaderAuthoringCompileRequest,
  type ShaderAuthoringCompilerResult,
  type ShaderAuthoringDiagnostic,
  type ShaderAuthoringSourceMapEntry,
  type ShaderTextAuthoringDocument,
} from "@bim-studio/deep-engine/shader-authoring";
import type { ShaderCompileCapabilities } from "@bim-studio/deep-engine/shader";
import { element } from "./fixture.js";

const FEATURES = new Set([
  "depth-clip-control", "float32-filterable", "indirect-first-instance", "shader-f16",
  "texture-compression-bc", "texture-compression-etc2", "texture-compression-astc",
]);

type TextSourceMapEntry = Extract<ShaderAuthoringSourceMapEntry, { readonly sourceKind: "text-range" }>;
function isTextSourceMapEntry(entry: ShaderAuthoringSourceMapEntry): entry is TextSourceMapEntry {
  return entry.sourceKind === "text-range";
}

function sourceDocument(source: string): ShaderTextAuthoringDocument {
  return { schemaVersion: 1, id: "lab.shader-editor", mode: "text", language: "deepsl", source };
}

function capabilities(device: GPUDevice): ShaderCompileCapabilities {
  return Object.freeze({
    features: Object.freeze([...device.features].filter((name) => FEATURES.has(name))),
    limits: Object.freeze({
      maxBindGroups: device.limits.maxBindGroups,
      maxBindingsPerBindGroup: device.limits.maxBindingsPerBindGroup,
      maxInterStageShaderVariables: device.limits.maxInterStageShaderVariables,
    }),
  }) as ShaderCompileCapabilities;
}

function gpuDiagnostic(
  message: GPUCompilationMessage,
  sourceMap: readonly ShaderAuthoringSourceMapEntry[],
  sourceLineCount: number,
): ShaderAuthoringDiagnostic {
  const mapped = sourceMap.filter(isTextSourceMapEntry).find((entry) => entry.generatedLine === message.lineNum);
  const range = mapped?.range ?? Object.freeze({
    start: Object.freeze({ line: 1, column: 1 }),
    end: Object.freeze({ line: Math.max(1, sourceLineCount), column: 1 }),
  });
  return Object.freeze({
    severity: message.type === "error" ? "error" : "warning",
    source: "text-compiler",
    code: `wgsl-${message.type}`,
    path: "$.source",
    message: `WGSL ${Math.max(1, message.lineNum)}:${Math.max(1, message.linePos)} · ${message.message}`,
    range,
  });
}

async function compileOnDevice(
  request: ShaderAuthoringCompileRequest,
  getDevice: () => GPUDevice | undefined,
): Promise<ShaderAuthoringCompilerResult> {
  const device = getDevice();
  if (!device) return Object.freeze({ success: false, diagnostics: Object.freeze([{
    severity: "error" as const, source: "text-compiler" as const, code: "device-unavailable", path: "$.source",
    message: "WebGPU device is not ready.",
  }]) });
  const compiled = compileDeepSlSurface(request, { capabilities: capabilities(device) });
  if (!compiled.success || !compiled.artifact) return compiled;
  const module = device.createShaderModule({ label: `DeepSL ${request.document.id} ${request.revision.slice(0, 8)}`, code: compiled.artifact.pass.module.code });
  const sourceLineCount = request.document.source.split(/\r?\n/u).length;
  const messages = (await module.getCompilationInfo()).messages.map((message) => gpuDiagnostic(message, compiled.artifact!.sourceMap, sourceLineCount));
  const diagnostics = Object.freeze([...compiled.diagnostics, ...messages]);
  if (messages.some((entry) => entry.severity === "error")) return Object.freeze({ success: false, diagnostics });
  return Object.freeze({ success: true, diagnostics, artifact: compiled.artifact });
}

export interface ShaderWorkbench {
  compile(): Promise<void>;
}

export function initShaderWorkbench(getDevice: () => GPUDevice | undefined, record?: (value: unknown) => void): ShaderWorkbench {
  const source = element<HTMLTextAreaElement>("shader-source");
  const compileButton = element<HTMLButtonElement>("shader-compile");
  const resetButton = element<HTMLButtonElement>("shader-reset");
  const stateNode = element("shader-state");
  const diagnosticsNode = element<HTMLUListElement>("shader-diagnostics");
  const output = element("shader-output");
  source.value = DEEP_SL_SURFACE_EXAMPLE;
  const created = createShaderAuthoringSession(sourceDocument(source.value), { textCompiler: (request) => compileOnDevice(request, getDevice) });
  if (!created.session) throw new Error("DeepSL editor session could not be created.");
  const session = created.session;
  let uiGeneration = 0;
  let rejectedDocumentDiagnostics: readonly ShaderAuthoringDiagnostic[] | undefined;

  function showDiagnostics(diagnostics: readonly ShaderAuthoringDiagnostic[]): void {
    diagnosticsNode.replaceChildren();
    if (diagnostics.length === 0) {
      const item = document.createElement("li"); item.dataset.severity = "success"; item.textContent = "语法、材质参数、IR 与设备 WGSL 校验均通过。"; diagnosticsNode.append(item); return;
    }
    for (const entry of diagnostics) {
      const item = document.createElement("li");
      item.dataset.severity = entry.severity;
      const location = entry.range ? `${entry.range.start.line}:${entry.range.start.column} · ` : "";
      item.textContent = `${location}${entry.message}`;
      diagnosticsNode.append(item);
    }
  }

  function showPending(): void {
    diagnosticsNode.replaceChildren();
    const item = document.createElement("li"); item.textContent = "等待编译当前修改。"; diagnosticsNode.append(item);
  }

  async function compile(): Promise<void> {
    if (rejectedDocumentDiagnostics) {
      showDiagnostics(rejectedDocumentDiagnostics);
      stateNode.dataset.state = "error"; stateNode.textContent = "源代码未通过编辑器输入边界";
      return;
    }
    const generation = ++uiGeneration;
    compileButton.disabled = true; stateNode.dataset.state = "compiling"; stateNode.textContent = "编译与设备校验中…";
    const commit = await session.compileCandidate();
    const view = commit.view;
    record?.({
      action: "shader-compile", revision: commit.revision, candidateId: commit.candidateId,
      success: commit.result.success, stale: commit.stale,
      retainedLastKnownGood: Boolean(view.lastKnownGood), cacheKey: view.lastKnownGood?.artifact.pass.cacheKey ?? null,
      diagnostics: commit.result.diagnostics.map((entry) => ({ severity: entry.severity, code: entry.code, line: entry.range?.start.line ?? null })),
    });
    if (generation !== uiGeneration) return;
    showDiagnostics(commit.result.diagnostics);
    if (commit.stale) stateNode.textContent = "源代码已变化，已丢弃过期结果。";
    else if (commit.result.success && view.lastKnownGood) {
      stateNode.dataset.state = "ready";
      const warnings = commit.result.diagnostics.filter((entry) => entry.severity === "warning").length;
      stateNode.textContent = `WGSL 已通过${warnings ? ` · ${warnings} 项能力提示` : ""} · ${view.lastKnownGood.artifact.pass.cacheKey.slice(0, 12)}`;
      output.textContent = view.lastKnownGood.artifact.pass.module.code;
    } else {
      stateNode.dataset.state = "error";
      stateNode.textContent = view.lastKnownGood ? "编译失败 · 继续使用上次正确版本" : "编译失败 · 尚无可预览版本";
    }
    compileButton.disabled = false;
  }

  source.addEventListener("input", () => {
    uiGeneration += 1;
    compileButton.disabled = false;
    const mutation = session.replaceDocument(sourceDocument(source.value));
    if (!mutation.accepted) {
      rejectedDocumentDiagnostics = mutation.diagnostics;
      showDiagnostics(mutation.diagnostics);
      stateNode.dataset.state = "error"; stateNode.textContent = "源代码未通过编辑器输入边界";
    } else {
      rejectedDocumentDiagnostics = undefined;
      showPending();
      stateNode.dataset.state = "dirty"; stateNode.textContent = "有未编译更改";
    }
  });
  source.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void compile(); }
  });
  compileButton.onclick = () => void compile();
  resetButton.onclick = () => {
    uiGeneration += 1;
    source.value = DEEP_SL_SURFACE_EXAMPLE;
    const mutation = session.replaceDocument(sourceDocument(source.value));
    rejectedDocumentDiagnostics = mutation.accepted ? undefined : mutation.diagnostics;
    void compile();
  };
  return Object.freeze({ compile });
}
