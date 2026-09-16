import {
  createShaderAuthoringSession,
  DEEP_SL_SURFACE_EXAMPLE,
  type ShaderAuthoringDiagnostic,
  type ShaderTextAuthoringDocument,
} from "@bim-studio/deep-engine/shader-authoring";
import { createWebGpuDeepSlCompiler } from "@bim-studio/deep-engine/webgpu";
import { element } from "./fixture.js";

function sourceDocument(source: string): ShaderTextAuthoringDocument {
  return { schemaVersion: 1, id: "lab.shader-editor", mode: "text", language: "deepsl", source };
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
  let compilerDevice: GPUDevice | undefined;
  let compiler: ReturnType<typeof createWebGpuDeepSlCompiler> | undefined;
  const created = createShaderAuthoringSession(sourceDocument(source.value), { textCompiler: (request) => {
    const device = getDevice();
    if (!device) return Object.freeze({ success: false, diagnostics: Object.freeze([{
      severity: "error" as const, source: "text-compiler" as const, code: "device-unavailable",
      path: "$.source", message: "WebGPU device is not ready.",
    }]) });
    if (device !== compilerDevice) { compilerDevice = device; compiler = createWebGpuDeepSlCompiler(device); }
    return compiler!(request);
  } });
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
