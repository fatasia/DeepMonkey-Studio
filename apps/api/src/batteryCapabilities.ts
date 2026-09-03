import type { CapabilityProvider } from "@bim-studio/plugin-runtime";
import {
  assessBatteryDataContract,
  batteryContractFailureMessage,
  normalizeBatteryRecords,
} from "@bim-studio/contracts";
import type {
  BatteryModelGateway,
  BatteryPredictionInput,
  BatteryTwinAssimilationInput,
  BatteryTwinInitializeInput,
  BatteryTwinSimulationInput
} from "./batteryModelGateway.js";
import { BATTERY_CAPABILITY_SCHEMAS } from "./batteryCapabilitySchemas.js";

/** 将既有电池服务挂入通用能力合同，保持页面、REST 与 MCP 使用同一执行路径。 */
export function createBatteryCapabilityProviders(gateway: BatteryModelGateway): CapabilityProvider[] {
  return [
    provider("battery.model.predict", "电池 SOC/SOH/RUL 预测", "model", "battery.execute", async (input, signal) => {
      const request = preparePredictionRequest(input as unknown as BatteryPredictionInput);
      const output = await gateway.predict(request, signal);
      return batteryResult(output, "production", request.routingMode
        ? `正式专家路由 ${request.routingMode}`
        : `正式模型 ${request.model}`);
    }),
    provider("battery.twin.status", "电池孪生运行状态", "query", "battery.read", async (_input, signal) => {
      const [runtime, release] = await Promise.all([gateway.digitalTwinStatus(signal), gateway.releaseStatus(signal)]);
      return batteryResult({ runtime, release }, "production", "PINO/PINN/TwinMoE 正式路由状态");
    }),
    provider("battery.twin.initialize", "初始化电池数字孪生", "action", "battery.execute", async (input, signal) => {
      const output = await gateway.initializeTwin(input as unknown as BatteryTwinInitializeInput, signal);
      return batteryResult(output, "production", "电池孪生会话初始化");
    }),
    provider("battery.twin.simulate", "电池多物理短时仿真", "simulation", "battery.execute", async (input, signal) => {
      const output = await gateway.simulateTwin(input as unknown as BatteryTwinSimulationInput, signal);
      return batteryResult(output, "production", "电热基线、PINO、TwinMoE 正式路由");
    }),
    provider("battery.twin.assimilate", "同化电池观测状态", "action", "battery.execute", async (input, signal) => {
      const output = await gateway.assimilateTwin(input as unknown as BatteryTwinAssimilationInput, signal);
      return batteryResult(output, "production", "电池孪生观测同化");
    }),
    provider("battery.twin.evidence", "查询电池孪生证据", "query", "battery.read", async (input, signal) => {
      const twinId = requiredString(input.twinId, "twinId");
      const output = await gateway.twinEvidence(twinId, signal);
      return batteryResult(output, "production", "电池孪生运行证据");
    }),
    provider("battery.release.status", "查询电池模型发布门禁", "query", "battery.read", async (_input, signal) => {
      const output = await gateway.releaseStatus(signal);
      return batteryResult(output, "production", "电池模型路由与发布状态");
    })
  ];
}

function preparePredictionRequest(request: BatteryPredictionInput): BatteryPredictionInput {
  if (!isFormalModel(request.model) || !Array.isArray(request.records) || request.records.length === 0) return request;
  const fields = [...new Set(request.records.flatMap((record) => Object.keys(record)))].map((key) => ({ key }));
  const assessment = assessBatteryDataContract(request.model, fields, {
    nominalCapacityProvided: request.nominalCapacityAh !== undefined,
  });
  if (!assessment.compatible) throw new Error(batteryContractFailureMessage(assessment));
  return { ...request, records: normalizeBatteryRecords(request.records, assessment) };
}

function isFormalModel(value: string): value is BatteryPredictionInput["model"] {
  return value === "socformer" || value === "bmsformer" || value === "batterymformer";
}

type ProviderKind = "query" | "model" | "simulation" | "action";

function provider(
  id: keyof typeof BATTERY_CAPABILITY_SCHEMAS,
  label: string,
  kind: ProviderKind,
  permission: "battery.read" | "battery.execute",
  invoke: (input: Record<string, unknown>, signal: AbortSignal) => Promise<ReturnType<typeof batteryResult>>
): CapabilityProvider {
  return {
    descriptor: {
      id,
      version: "1.1.0",
      label,
      kind,
      // Provider 在 API 进程内执行；底层模型服务仍由可替换的 Gateway transport 隔离。
      execution: "in-process",
      permissions: [permission],
      timeoutMs: kind === "simulation" || kind === "model" ? 30_000 : 10_000,
      inputSchemaVersion: "1.0",
      outputSchemaVersion: "1.0",
      inputSchema: BATTERY_CAPABILITY_SCHEMAS[id].input,
      outputSchema: BATTERY_CAPABILITY_SCHEMAS[id].output
    },
    invoke(request, context) {
      return invoke(asRecord(request.input), context.signal);
    }
  };
}

function batteryResult(output: Record<string, unknown>, decisionStatus: "production" | "shadow", label: string) {
  return {
    status: "completed" as const,
    decisionStatus,
    output,
    evidence: [{ id: `battery:${label}`, kind: "model" as const, label, source: "battery-model-service" }],
    warnings: decisionStatus === "shadow" ? ["该能力当前仅用于观察与审计。"] : []
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("电池能力输入必须是对象");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 ${field}`);
  return value.trim();
}
