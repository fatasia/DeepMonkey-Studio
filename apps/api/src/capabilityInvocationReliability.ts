import { randomUUID } from "node:crypto";
import type { AuditLogRecord } from "@bim-studio/contracts";
import type {
  CapabilityInvocationResult,
  CapabilityRequest,
} from "@bim-studio/plugin-runtime";

interface ClientAbortSource {
  readonly aborted?: boolean;
  once(event: "aborted", listener: () => void): unknown;
  removeListener(event: "aborted", listener: () => void): unknown;
}

export interface ReliableCapabilityInvocationOptions {
  capabilityId: string;
  request: CapabilityRequest;
  client: ClientAbortSource;
  invoke(
    capabilityId: string,
    request: CapabilityRequest,
  ): Promise<CapabilityInvocationResult>;
  addAuditLog?(record: AuditLogRecord): Promise<void>;
}

/**
 * 把 HTTP 客户端断开传入插件运行时，并持久化不含原始输入的执行证据。
 * 审计存储失败不会伪装成能力失败，但会在结果警告中明确暴露证据缺口。
 */
export async function invokeReliableHttpCapability(
  options: ReliableCapabilityInvocationOptions,
): Promise<CapabilityInvocationResult> {
  const controller = new AbortController();
  const abortFromClient = () => controller.abort("HTTP 客户端已断开");
  if (options.client.aborted) abortFromClient();
  else options.client.once("aborted", abortFromClient);

  let result: CapabilityInvocationResult;
  try {
    result = await options.invoke(options.capabilityId, {
      ...options.request,
      signal: controller.signal,
    });
  } finally {
    options.client.removeListener("aborted", abortFromClient);
  }

  if (!options.addAuditLog) return result;
  try {
    await options.addAuditLog(toAuditRecord(options, result));
    return result;
  } catch {
    return {
      ...result,
      warnings: [...result.warnings, "能力执行审计未能持久化，请勿将本次结果视为完整审计证据"],
    };
  }
}

/** HTTP 状态区分输入问题、取消、超时与提供方失败，便于调用方决定是否重试。 */
export function capabilityInvocationHttpStatus(
  result: CapabilityInvocationResult,
): number {
  if (result.status !== "failed" && result.status !== "blocked") return 200;
  switch (result.error?.code) {
    case "not-found":
      return 404;
    case "permission-denied":
      return 403;
    case "aborted":
      return 499;
    case "timeout":
      return 504;
    case "provider-failed":
      return 502;
    default:
      return 422;
  }
}

function toAuditRecord(
  options: ReliableCapabilityInvocationOptions,
  result: CapabilityInvocationResult,
): AuditLogRecord {
  const evidence = result.evidence.map((item) => ({
    id: item.id,
    kind: item.kind,
    ...(item.fingerprint ? { fingerprint: item.fingerprint } : {}),
  }));
  return {
    id: randomUUID(),
    username: options.request.principal,
    action: `capability.invoke.${result.status}`,
    resource: `/projects/${encodeURIComponent(options.request.projectId)}/capabilities/${encodeURIComponent(options.capabilityId)}`,
    method: "CAPABILITY",
    statusCode: capabilityInvocationHttpStatus(result),
    detail: JSON.stringify({
      traceId: result.traceId,
      requestId: result.requestId,
      capabilityId: result.capabilityId,
      pluginId: result.pluginId,
      capabilityVersion: result.capabilityVersion,
      status: result.status,
      decisionStatus: result.decisionStatus,
      durationMs: result.durationMs,
      evidenceCount: evidence.length,
      evidence,
      // Provider 错误文本可能夹带输入或供应商响应，只记录可稳定聚合的错误分类。
      ...(result.error ? { error: { code: result.error.code, retryable: result.error.retryable } } : {}),
    }),
    createdAt: result.generatedAt,
  };
}
