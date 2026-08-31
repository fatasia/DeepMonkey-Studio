import type { AuditLogRecord } from "@bim-studio/contracts";
import type { MetadataStore } from "../metadataStore.js";
import type { AiReliabilityAuditEvent, AiReliabilityAuditSink } from "./aiReliabilityAudit.js";

type AuditStore = Pick<MetadataStore, "addAuditLog">;

/** 将 AI 专用证据写入现有持久化审计链，记录中不包含原始提示词、上下文或工具参数。 */
export function createMetadataAiAuditSink(store: AuditStore): AiReliabilityAuditSink {
  return async (event) => store.addAuditLog(toAuditLog(event));
}

function toAuditLog(event: AiReliabilityAuditEvent): AuditLogRecord {
  const denied = event.outcome === "denied";
  const failed = event.outcome === "failed" || event.outcome === "cancelled";
  const resource = event.tool?.id ?? event.providerId ?? "assistant";
  return {
    id: event.eventId,
    username: event.principal,
    action: `ai.${event.stage}.${event.outcome}`,
    resource: event.projectId ? `/projects/${encodeURIComponent(event.projectId)}/ai/${resource}` : `/ai/${resource}`,
    method: "AI",
    statusCode: denied ? 403 : failed ? 502 : 200,
    detail: JSON.stringify(event),
    createdAt: event.occurredAt,
  };
}
