import type { ShaderCompileCapabilities, CompiledShaderPass } from "../shader/types.js";
import type { ShaderGraphAssetV1 } from "./graphTypes.js";
import { lowerShaderGraphAsset } from "./lowering.js";
import { ShaderGraphMessageStore, type ShaderGraphEditorDiagnostic } from "./messageStore.js";

export interface ShaderGraphPreviewRequest {
  readonly graph: ShaderGraphAssetV1;
  readonly capabilities: ShaderCompileCapabilities;
  readonly nodeId?: string;
  readonly variant?: Readonly<Record<string, string>>;
}
export interface ShaderGraphPreviewResult {
  readonly success: boolean;
  readonly diagnostics: readonly ShaderGraphEditorDiagnostic[];
  readonly stages?: ReturnType<typeof lowerShaderGraphAsset>["stages"];
  readonly compiled?: CompiledShaderPass;
}

/**
 * 预览合同：降级过程同步且确定性；实际 WebGPU 管线创建由宿主负责，
 * 宿主可以对请求做防抖和取消。这能避免预览逻辑变成第二套编译器，
 * 并允许错误时保留最近一次可用管线。
 */
export function prepareShaderGraphPreview(request: ShaderGraphPreviewRequest,
  messages = new ShaderGraphMessageStore()): ShaderGraphPreviewResult {
  const lowered = lowerShaderGraphAsset(request.graph);
  const diagnostics = lowered.diagnostics.map(diagnostic => ({ ...diagnostic,
    severity: "error" as const, provider: "lowering" as const }));
  messages.replace("lowering", diagnostics);
  return Object.freeze({ success: lowered.success, diagnostics: Object.freeze(diagnostics),
    ...(lowered.stages ? { stages: lowered.stages } : {}) });
}
