import type { ConversionTaskRecord, SubmitConversionTaskRequest } from "@bim-studio/contracts";

/** 属性顺序不参与请求身份；格式扩展名使用任务的规范化形式。 */
export function sameConversionRequest(task: ConversionTaskRecord, request: SubmitConversionTaskRequest): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  const fields = (value: ConversionTaskRecord | SubmitConversionTaskRequest) => ({
    projectId: value.projectId, modelId: value.modelId, pluginId: value.pluginId,
    input: { ...value.input, format: value.input.format.trim().replace(/^\./, "").toLowerCase(),
      ...(value.input.sha256 ? { sha256: value.input.sha256.toLowerCase() } : {}) }, configuration: value.configuration ?? {},
  });
  return JSON.stringify(canonical(fields(task))) === JSON.stringify(canonical(fields(request)));
}
