import { randomUUID } from "node:crypto";
import type { AiRequestTelemetryRecord, AiTelemetrySummary } from "@bim-studio/contracts";

export type AiTelemetrySink = (record: AiRequestTelemetryRecord) => void;

export interface AiTelemetryRing {
  readonly sink: AiTelemetrySink;
  summary(now?: () => Date): AiTelemetrySummary;
}

/**
 * 最近 N 条 AI 请求环形观测：provider、模型、延迟、token 用量、结果状态。
 * 只记录元数据与聚合用量，绝不记录提示词、回答原文或 API Key。
 */
export function createAiTelemetryRing(limit = 50): AiTelemetryRing {
  const records: AiRequestTelemetryRecord[] = [];
  return {
    sink: (record) => {
      // 纵深防御：调用方已脱敏的前提下，再次擦除可能混入错误消息的密钥片段。
      records.push({
        ...record,
        ...(record.errorMessage ? { errorMessage: redactSecrets(record.errorMessage).slice(0, 300) } : {}),
      });
      if (records.length > limit) records.splice(0, records.length - limit);
    },
    summary(now = () => new Date()) {
      const totals = { completed: 0, failed: 0, cancelled: 0, fallbackServed: 0 };
      let lastFailover: AiRequestTelemetryRecord | undefined;
      for (const record of records) {
        totals[record.status] += 1;
        if (record.servedBy === "fallback") {
          totals.fallbackServed += 1;
          lastFailover = record;
        }
      }
      return {
        generatedAt: now().toISOString(),
        limit,
        records: structuredClone(records),
        ...(lastFailover ? { lastFailover: structuredClone(lastFailover) } : {}),
        totals,
      };
    },
  };
}

export function emptyTelemetrySummary(generatedAt: string, limit = 50): AiTelemetrySummary {
  return { generatedAt, limit, records: [], totals: { completed: 0, failed: 0, cancelled: 0, fallbackServed: 0 } };
}

export function newTelemetryRecord(base: Omit<AiRequestTelemetryRecord, "id">): AiRequestTelemetryRecord {
  return { id: randomUUID(), ...base };
}

function redactSecrets(message: string): string {
  return message.replace(/(?:bearer\s+|api[_ -]?key[=:]\s*|token[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
