import type { CapabilityProvider } from "@bim-studio/plugin-runtime";
import type { OperationsService } from "./operations.js";
import {
  createVirtualDebugProvider,
  createVirtualDebugSuiteProvider,
} from "@bim-studio/virtual-commissioning-plugin";
import { createParametricValidationProvider } from "@bim-studio/parametric-modeling-plugin";
import {
  type EnergyObservation,
  type MaintenanceAssessmentRecord,
  type MaintenanceShadowEvaluation,
} from "@bim-studio/contracts";
import { INDUSTRIAL_CAPABILITY_SCHEMAS } from "./industrialCapabilitySchemas.js";
import { createBatteryCapabilityProviders } from "./batteryCapabilities.js";
import type { BatteryModelGateway } from "./batteryModelGateway.js";

export function providers(
  operations: OperationsService,
  batteryGateway: BatteryModelGateway,
): CapabilityProvider[] {
  return [
    {
      descriptor: {
        id: "operations.maintenance.assess",
        version: "1.0.0",
        label: "预测维护评估",
        kind: "analysis",
        execution: "in-process",
        permissions: ["operations.read", "operations.write"],
        timeoutMs: 30_000,
        inputSchemaVersion: "1.0",
        outputSchemaVersion: "1.0",
        inputSchema: INDUSTRIAL_CAPABILITY_SCHEMAS.maintenanceAssess.input,
        outputSchema: INDUSTRIAL_CAPABILITY_SCHEMAS.maintenanceAssess.output,
      },
      async invoke(request) {
        const input = asRecord(request.input);
        const deploymentId = requiredString(input.deploymentId, "deploymentId");
        const rows = numericRows(input.rows);
        const assessment = await operations.assess(
          request.projectId,
          deploymentId,
          rows,
        );
        return maintenanceResult(assessment, "预测维护评估已完成");
      },
    },
    {
      descriptor: {
        id: "operations.maintenance.shadow-evaluate",
        version: "1.0.0",
        label: "预测维护影子评测",
        kind: "analysis",
        execution: "in-process",
        permissions: ["operations.read", "operations.write"],
        timeoutMs: 30_000,
        inputSchemaVersion: "1.0",
        outputSchemaVersion: "1.0",
        inputSchema:
          INDUSTRIAL_CAPABILITY_SCHEMAS.maintenanceShadowEvaluate.input,
        outputSchema:
          INDUSTRIAL_CAPABILITY_SCHEMAS.maintenanceShadowEvaluate.output,
      },
      async invoke(request) {
        const input = asRecord(request.input);
        const modelId = requiredString(input.modelId, "modelId");
        const labelColumn = requiredString(input.labelColumn, "labelColumn");
        const result = await operations.shadowEvaluate(
          request.projectId,
          modelId,
          numericRows(input.rows),
          labelColumn,
          optionalNumber(input.threshold),
          optionalString(input.timeColumn),
        );
        return shadowResult(result);
      },
    },
    {
      descriptor: {
        id: "operations.energy.analyze",
        version: "1.0.0",
        label: "能源分析",
        kind: "analysis",
        execution: "in-process",
        permissions: ["operations.read", "operations.write"],
        timeoutMs: 15_000,
        inputSchemaVersion: "1.0",
        outputSchemaVersion: "1.0",
        inputSchema: INDUSTRIAL_CAPABILITY_SCHEMAS.energyAnalyze.input,
        outputSchema: INDUSTRIAL_CAPABILITY_SCHEMAS.energyAnalyze.output,
      },
      async invoke(request) {
        const input = asRecord(request.input);
        const result = await operations.analyzeEnergy(
          request.projectId,
          (Array.isArray(input.observations)
            ? input.observations
            : []) as EnergyObservation[],
        );
        return {
          status: "completed",
          decisionStatus: "production",
          output: result,
          evidence: [
            {
              id: result.id,
              kind: "data",
              label: "能源观测分析",
              source: `project:${request.projectId}`,
              fingerprint: result.evidenceFingerprint,
            },
          ],
        };
      },
    },
    createVirtualDebugProvider(),
    createVirtualDebugSuiteProvider(),
    createParametricValidationProvider(),
    ...createBatteryCapabilityProviders(batteryGateway),
  ];
}

function maintenanceResult(
  assessment: MaintenanceAssessmentRecord,
  label: string,
) {
  return {
    status: "completed" as const,
    decisionStatus:
      assessment.decisionStatus === "validated"
        ? ("production" as const)
        : ("shadow" as const),
    output: assessment,
    confidence: assessment.dataQuality,
    evidence: [
      {
        id: assessment.evidenceFingerprint,
        kind: "trace" as const,
        label,
        source: `deployment:${assessment.deploymentId}`,
        fingerprint: assessment.evidenceFingerprint,
      },
    ],
  };
}

function shadowResult(result: MaintenanceShadowEvaluation) {
  return {
    status: "completed" as const,
    decisionStatus: "shadow" as const,
    output: result,
    confidence: result.f1,
    evidence: [
      {
        id: result.fingerprint,
        kind: "model" as const,
        label: "固定数据集影子评测",
        source: `model:${result.modelId}`,
        fingerprint: result.fingerprint,
      },
    ],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("能力输入必须是对象");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`缺少 ${field}`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function numericRows(value: unknown): Array<Record<string, number>> {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const record = asRecord(row);
    return Object.fromEntries(
      Object.entries(record).flatMap(([key, item]) => {
        const number = Number(item);
        return Number.isFinite(number)
          ? [[key, number] as [string, number]]
          : [];
      }),
    );
  });
}
