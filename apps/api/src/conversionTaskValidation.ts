import path from "node:path";
import { assertPathSafeResourceId, type ConverterPluginManifest, type SubmitConversionTaskRequest } from "@bim-studio/contracts";
import { ConversionTaskError } from "./conversionTaskError.js";

export function validateManifest(manifest: ConverterPluginManifest): void {
  if (manifest.contractVersion !== 1) throw new ConversionTaskError("不支持的转换器合同版本", "invalid_request");
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(manifest.id)) throw new ConversionTaskError("转换器 ID 无效", "invalid_request");
  if (!manifest.version.trim() || manifest.inputFormats.length === 0 || manifest.outputs.length === 0) throw new ConversionTaskError("转换器清单不完整", "invalid_request");
  if (manifest.inputFormats.some(format => format !== normalizeFormat(format))) throw new ConversionTaskError("转换器输入格式必须为小写扩展名", "invalid_request");
  for (const key of ["timeoutMs", "maxInputBytes", "maxOutputBytes", "maxMemoryMb", "maxCpuPercent"] as const) {
    if (!Number.isFinite(manifest.limits[key]) || manifest.limits[key] <= 0) throw new ConversionTaskError("转换器资源限制必须大于零", "invalid_request");
  }
  if (manifest.limits.timeoutMs > 2_147_483_647) throw new ConversionTaskError("转换器超时超出运行时计时范围", "invalid_request");
}

export function validateSubmitRequest(request: SubmitConversionTaskRequest): void {
  if (!request || typeof request !== "object") throw new ConversionTaskError("转换请求必须是对象", "invalid_request");
  try {
    assertPathSafeResourceId(request.projectId, "projectId");
    if (request.modelId !== undefined) assertPathSafeResourceId(request.modelId, "modelId");
    if (request.idempotencyKey !== undefined) assertPathSafeResourceId(request.idempotencyKey, "idempotencyKey");
  } catch (error) {
    throw new ConversionTaskError(error instanceof Error ? error.message : "请求身份无效", "invalid_request");
  }
  if (typeof request.pluginId !== "string" || !request.pluginId.trim()) throw new ConversionTaskError("pluginId 不能为空", "invalid_request");
  if (!request.input || typeof request.input.fileName !== "string" || path.basename(request.input.fileName) !== request.input.fileName || !request.input.fileName.trim() || /[\\/\u0000-\u001f]/.test(request.input.fileName)) throw new ConversionTaskError("输入文件名无效", "invalid_request");
  if (typeof request.input.objectKey !== "string" || !isKeyWithinPrefix(request.input.objectKey, `projects/${request.projectId}/`)) throw new ConversionTaskError("输入对象必须位于当前项目", "invalid_request");
  if (typeof request.input.format !== "string" || !/^[a-z0-9][a-z0-9._+-]{0,31}$/.test(normalizeFormat(request.input.format))) throw new ConversionTaskError("输入格式无效", "invalid_request");
  if (!Number.isSafeInteger(request.input.size) || request.input.size < 0) throw new ConversionTaskError("输入文件大小无效", "invalid_request");
  if (request.input.sha256 !== undefined && (typeof request.input.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(request.input.sha256))) throw new ConversionTaskError("输入 SHA-256 无效", "invalid_request");
  if (request.configuration !== undefined) {
    try {
      if (!isPlainObject(request.configuration) || JSON.stringify(request.configuration).length > 64_000) throw new Error();
    } catch { throw new ConversionTaskError("转换配置无效或过大", "invalid_request"); }
  }
}

export function isKeyWithinPrefix(key: string, prefix: string): boolean {
  const normalized = key.replaceAll("\\", "/");
  return !/[\u0000-\u001f\u007f]/.test(normalized)
    && normalized.split("/").every(segment => segment !== ".." && segment !== "." && segment !== "")
    && normalized.startsWith(prefix);
}
export function normalizeFormat(format: string): string { return format.trim().replace(/^\./, "").toLowerCase(); }
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
