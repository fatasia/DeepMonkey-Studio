import type { CapabilityJsonSchema, CapabilityProvider, PluginRegistry } from "@bim-studio/plugin-runtime";
import { AlarmRcaInputError, analyzeAlarmRca } from "./alarmRcaEngine.js";
import type { AlarmRcaInput, AlarmRcaResult } from "./alarmRcaTypes.js";

const inputSchema: CapabilityJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "asset", "alarm", "window", "events", "anomalies", "maintenanceHistory"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    asset: objectSchema(["id", "name"], {
      id: shortText(), name: shortText(), type: shortText(), criticality: { type: "string", enum: ["low", "medium", "high"] },
    }),
    alarm: objectSchema(["id", "code", "label", "severity", "triggeredAt", "source"], {
      id: shortText(), code: shortText(), label: shortText(), severity: { type: "string", enum: ["info", "warning", "critical"] },
      triggeredAt: shortText(), source: shortText(),
    }),
    window: objectSchema(["startAt", "endAt"], { startAt: shortText(), endAt: shortText() }),
    events: {
      type: "array", maxItems: 5_000, items: objectSchema(["id", "kind", "code", "label", "occurredAt", "source"], {
        id: shortText(), assetId: shortText(), kind: { type: "string", enum: ["state-change", "interlock", "operator-action", "communication", "process", "alarm"] },
        code: shortText(), label: shortText(), occurredAt: shortText(), source: shortText(), qualityScore: scoreSchema(),
      }),
    },
    anomalies: {
      type: "array", maxItems: 2_000, items: objectSchema(["id", "signal", "label", "observedAt", "direction", "deviationScore", "quality", "qualityScore", "source"], {
        id: shortText(), assetId: shortText(), signal: shortText(), label: shortText(), observedAt: shortText(),
        direction: { type: "string", enum: ["high", "low", "change", "flatline", "missing"] },
        deviationScore: { type: "number", minimum: -100, maximum: 100 }, quality: { type: "string", enum: ["valid", "suspect", "invalid"] },
        qualityScore: scoreSchema(), source: shortText(), observedValue: { type: "number" }, baselineValue: { type: "number" }, unit: shortText(),
      }),
    },
    maintenanceHistory: {
      type: "array", maxItems: 2_000, items: objectSchema(["id", "assetId", "category", "summary", "status", "startedAt"], {
        id: shortText(), assetId: shortText(), category: { type: "string", enum: ["inspection", "repair", "replacement", "lubrication", "calibration", "configuration"] },
        summary: shortText(2_000), status: { type: "string", enum: ["planned", "in-progress", "completed", "cancelled"] },
        startedAt: shortText(), completedAt: shortText(), affectedSignals: { type: "array", maxItems: 100, items: shortText() },
      }),
    },
  },
};

const outputSchema: CapabilityJsonSchema = {
  type: "object", additionalProperties: true,
  required: ["schemaVersion", "generatedBy", "decisionStatus", "confidence", "confidenceBand", "candidates", "missingEvidence", "validationSteps", "workOrderDraft", "limitations", "evidenceFingerprint"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] }, generatedBy: { type: "string", enum: ["deterministic-alarm-rca"] },
    decisionStatus: { type: "string", enum: ["investigation-required", "monitor", "insufficient-data"] }, confidence: scoreSchema(),
    confidenceBand: { type: "string", enum: ["insufficient", "low", "medium", "high"] }, candidates: { type: "array" },
    missingEvidence: { type: "array" }, validationSteps: { type: "array" }, workOrderDraft: { type: "object", additionalProperties: true },
    excludedRecordIds: { type: "array" }, limitations: { type: "array" }, evidenceFingerprint: { type: "string", minLength: 64, maxLength: 64 },
  },
};

export function createAlarmRcaProvider(): CapabilityProvider<AlarmRcaInput, AlarmRcaResult> {
  return {
    descriptor: {
      id: "industrial.ai.alarm-rca.compose", version: "1.0.0", label: "告警 RCA 与维护闭环", kind: "analysis", execution: "in-process",
      permissions: ["operations.read"], timeoutMs: 5_000, inputSchemaVersion: "1.0", outputSchemaVersion: "1.0", inputSchema, outputSchema,
    },
    async invoke(request) {
      let output: AlarmRcaResult;
      try { output = analyzeAlarmRca(request.input); }
      catch (error) {
        if (!(error instanceof AlarmRcaInputError)) throw error;
        return { status: "needs-input", decisionStatus: "insufficient-data", warnings: [error.message] };
      }
      return {
        status: output.decisionStatus === "insufficient-data" ? "needs-input" : "completed",
        decisionStatus: output.decisionStatus === "insufficient-data" ? "insufficient-data" : "research-candidate",
        confidence: output.confidence,
        output,
        evidence: [{ id: output.evidenceFingerprint, kind: "trace", label: "告警 RCA 证据链", source: `alarm:${request.input.alarm.id}`, fingerprint: output.evidenceFingerprint }],
        warnings: output.limitations,
        suggestedActions: output.decisionStatus === "insufficient-data" ? [] : [{
          id: output.workOrderDraft.id, label: "确认并创建维护工单草稿", commandType: "maintenance.work-order.create-draft",
          input: { alarmId: request.input.alarm.id, assetId: request.input.asset.id, evidenceFingerprint: output.evidenceFingerprint },
          risk: "medium", requiresConfirmation: true,
        }],
      };
    },
  };
}

export async function registerAlarmRcaPlugin(registry: PluginRegistry): Promise<void> {
  const manifest = {
    schemaVersion: 1 as const, id: "bim.ai.alarm-rca", name: "Deterministic alarm RCA", version: "1.0.0", apiVersion: "1.0",
    hosts: ["cloud"] as const, capabilities: ["industrial.ai.alarm-rca"], permissions: ["operations.read"],
    extensionPoints: [{ kind: "capability.provider" as const, id: "bim.alarm-rca-provider", capabilityIds: ["industrial.ai.alarm-rca.compose"], execution: "in-process" as const, limits: { timeoutMs: 5_000, maxInputBytes: 2 * 1024 * 1024, memoryMb: 128 } }],
  };
  const registered = registry.register(manifest, ({ registerCapability }) => {
    const result = registerCapability(createAlarmRcaProvider());
    if (!result.ok) throw new Error(`告警 RCA 能力注册失败：${result.message}`);
  });
  if (!registered.ok) throw new Error(`告警 RCA 插件不兼容：${registered.message}`);
  const enabled = await registry.enable(manifest.id);
  if (!enabled.ok) throw new Error(`告警 RCA 插件启用失败：${enabled.message}`);
}

function shortText(maxLength = 500): CapabilityJsonSchema { return { type: "string", minLength: 1, maxLength }; }
function scoreSchema(): CapabilityJsonSchema { return { type: "number", minimum: 0, maximum: 1 }; }
function objectSchema(required: string[], properties: Record<string, CapabilityJsonSchema>): CapabilityJsonSchema {
  return { type: "object", additionalProperties: false, required, properties };
}
