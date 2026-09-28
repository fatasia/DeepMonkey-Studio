import type { CapabilityJsonSchema, CapabilityProvider } from "@bim-studio/plugin-runtime";
import type { PluginRegistry } from "@bim-studio/plugin-runtime";
import {
  AI_HYPOTHESIS_COMPARATORS,
  AI_HYPOTHESIS_CONTRACT_VERSION,
  AI_HYPOTHESIS_METRICS,
  AI_HYPOTHESIS_TARGET_MODELS,
  AiHypothesisContractError,
  aiHypothesisMetricLocator,
  aiHypothesisProposalFingerprint,
  evaluateAiHypothesis,
  fingerprint64Labeled,
  validateAiHypothesisContract,
  validateAiVerificationEnvelope,
  type AiHypothesisContract,
  type AiHypothesisPrediction,
  type AiHypothesisVerdict,
  type AiHypothesisReasonCode,
  type AiVerificationEnvelope,
} from "@bim-studio/contracts";
import {
  CALIBRATION_GOLDEN_HASH,
  CALIBRATION_LIMITS,
  CALIBRATION_RUN,
  CALIBRATION_SEED,
  CALIBRATION_TRACE,
  calibrationGoldenHash,
  createConveyorSensorAgvCalibrationModel,
  runPlantLiteExperiment,
  type PlantLiteExperimentResult,
} from "@bim-studio/plant-lite-simulation";

/**
 * H-C1 统一 Harness 最小核心切片：假设登记 + golden 验证两个 Capability。
 *
 * 全部复用既有面（零新循环）：PluginRegistry 能力注册、MCP tools/list 自动暴露、
 * 网关 CURATED 白名单与四阶段指纹审计。提案者（Agent 出参）与裁决者
 * （contracts.evaluateAiHypothesis 确定性判定）在此分离；本文件不引入任何
 * 动态命令/文件/shell 面。诚实条款：verdict 只有三态，simulate 侧验证结果
 * 是 research-candidate 口径，不表述为实产预测。
 */

const HYPOTHESIS_INPUT_SCHEMA: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { hypothesis: hypothesisSchema() },
  required: ["hypothesis"],
};

function hypothesisSchema(): CapabilityJsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    description: "HypothesisContract：对已注册确定性校准场景的单一指标假设。",
    properties: {
      hypothesisVersion: { type: "string", enum: [AI_HYPOTHESIS_CONTRACT_VERSION] },
      id: { type: "string", minLength: 1, maxLength: 200, description: "提案者给出的稳定假设标识。" },
      statement: { type: "string", minLength: 1, maxLength: 2_000, description: "给人读的假设陈述；机器裁决只看 prediction 与 tolerance。" },
      targetModel: { type: "string", enum: [...AI_HYPOTHESIS_TARGET_MODELS], description: "目标校准场景（白名单）。" },
      prediction: {
        type: "object",
        additionalProperties: false,
        properties: {
          metric: { type: "string", enum: [...AI_HYPOTHESIS_METRICS], description: "可裁决指标（多重复均值口径）。" },
          resourceId: { type: "string", minLength: 1, maxLength: 200, description: "resource-utilization 指标的目标资源 ID。" },
          comparator: { type: "string", enum: [...AI_HYPOTHESIS_COMPARATORS] },
          expected: { type: "number", description: "预期阈值；比例指标限 0..1。" },
        },
        required: ["metric", "comparator", "expected"],
      },
      tolerance: {
        type: "object",
        additionalProperties: false,
        properties: { absolute: { type: "number", minimum: 0, description: "绝对容差；带内判 inconclusive。" } },
        required: ["absolute"],
      },
    },
    required: ["hypothesisVersion", "id", "statement", "targetModel", "prediction", "tolerance"],
  } satisfies CapabilityJsonSchema;
}

const OPEN_OBJECT_OUTPUT: CapabilityJsonSchema = {
  type: "object",
  description: "登记回执或 VerificationEnvelope；字段由合同版本管理。",
  additionalProperties: true,
};

/** 假设登记：只做合同校验与 proposalFingerprint 固化，不执行任何内核。 */
export function createHypothesisRegisterProvider(): CapabilityProvider<{ hypothesis: unknown }> {
  return {
    descriptor: {
      id: "simulation.hypothesis.register",
      version: "1.0.0",
      label: "假设登记（不执行）",
      kind: "analysis",
      execution: "in-process",
      permissions: ["simulation.read"],
      timeoutMs: 5_000,
      inputSchemaVersion: "1.0",
      outputSchemaVersion: "1.0",
      inputSchema: HYPOTHESIS_INPUT_SCHEMA,
      outputSchema: OPEN_OBJECT_OUTPUT,
    },
    async invoke(request) {
      try {
        const input = request.input as { hypothesis?: unknown };
        const contract = validateAiHypothesisContract(input.hypothesis);
        const proposalFingerprint = aiHypothesisProposalFingerprint(contract);
        return {
          status: "completed",
          decisionStatus: "research-candidate",
          output: {
            proposalFingerprint,
            hypothesis: contract,
            metricLocator: aiHypothesisMetricLocator(contract.prediction),
            execution: "not-performed",
            nextStep: "simulation.golden.verify",
          },
          evidence: [{
            id: proposalFingerprint,
            kind: "rule",
            label: "假设合同登记指纹",
            source: `hypothesis:${contract.id}`,
            fingerprint: proposalFingerprint,
          }],
        };
      } catch (error) {
        if (error instanceof AiHypothesisContractError) {
          // 语义预检拒绝：合同外形状不进入内核域，理由码回给提案者修正。
          return { status: "blocked", decisionStatus: "insufficient-data", warnings: [`${error.field}: ${error.message}`] };
        }
        throw error;
      }
    },
  };
}

/** golden 验证：按目标场景 golden 锚跑确定性 DES，产出 VerificationEnvelope。 */
export function createGoldenVerifyProvider(): CapabilityProvider<{ hypothesis: unknown }> {
  return {
    descriptor: {
      id: "simulation.golden.verify",
      version: "1.0.0",
      label: "校准基准假设验证",
      kind: "analysis",
      execution: "in-process",
      permissions: ["simulation.read"],
      timeoutMs: 30_000,
      inputSchemaVersion: "1.0",
      outputSchemaVersion: "1.0",
      inputSchema: HYPOTHESIS_INPUT_SCHEMA,
      outputSchema: OPEN_OBJECT_OUTPUT,
    },
    async invoke(request) {
      try {
        const input = request.input as { hypothesis?: unknown };
        const contract = validateAiHypothesisContract(input.hypothesis);
        const model = createConveyorSensorAgvCalibrationModel();
        const admission = semanticAdmission(contract, model.resources?.map((resource) => resource.id) ?? []);
        if (admission) return { status: "blocked", decisionStatus: "insufficient-data", warnings: [admission] };

        // 验证配置由 golden 锚决定（同种子同窗口才可比），不接受提案者自选。
        const result = runPlantLiteExperiment({
          model,
          seed: CALIBRATION_SEED,
          replications: CALIBRATION_RUN.replications,
          limits: { ...CALIBRATION_LIMITS },
          trace: { ...CALIBRATION_TRACE },
        });
        const envelope = buildVerificationEnvelope(contract, result);
        return {
          status: "completed",
          decisionStatus: "research-candidate",
          output: envelope,
          ...(goldenBaselineDrifted(envelope) ? { warnings: ["校准 golden 基准哈希漂移，结论已降级为 inconclusive"] } : {}),
          evidence: envelope.evidence.map((item) => ({
            id: item.id,
            kind: item.kind as "simulation" | "trace" | "rule",
            label: item.label,
            source: item.source,
            ...(item.fingerprint ? { fingerprint: item.fingerprint } : {}),
          })),
        };
      } catch (error) {
        if (error instanceof AiHypothesisContractError) {
          return { status: "blocked", decisionStatus: "insufficient-data", warnings: [`${error.field}: ${error.message}`] };
        }
        throw error;
      }
    },
  };
}

/** 语义预检（G5 的最小版）：资源引用必须存在于目标场景，白名单外即拒。 */
function semanticAdmission(contract: AiHypothesisContract, resourceIds: readonly string[]): string | undefined {
  if (contract.prediction.metric !== "resource-utilization") return undefined;
  const resourceId = contract.prediction.resourceId ?? "";
  if (!resourceIds.includes(resourceId)) return `semantic-admission：资源 ${resourceId} 不在目标场景 ${contract.targetModel} 中`;
  return undefined;
}

function buildVerificationEnvelope(contract: AiHypothesisContract, result: PlantLiteExperimentResult): AiVerificationEnvelope {
  const proposalFingerprint = aiHypothesisProposalFingerprint(contract);
  const inputFingerprint = fingerprint64Labeled([
    ["verify-input", {
      targetModel: contract.targetModel,
      seed: CALIBRATION_SEED,
      replications: CALIBRATION_RUN.replications,
      limits: CALIBRATION_LIMITS,
      trace: CALIBRATION_TRACE,
    }],
  ]);
  const resultFingerprint = fingerprint64Labeled([["verify-result", {
    seed: CALIBRATION_SEED,
    replication0: result.replications[0],
    confidence95: result.confidence95,
    resourceUtilization95: result.resourceUtilization95,
    quality95: result.quality95 ?? null,
  }]]);
  const goldenHash = calibrationGoldenHash(result);
  const goldenMatch = goldenHash === CALIBRATION_GOLDEN_HASH;
  const observed = readObservedMetric(result, contract.prediction);
  const judged = observed === undefined
    ? { verdict: "inconclusive" as const, reasonCode: "metric-unavailable" as const }
    : evaluateAiHypothesis({ prediction: contract.prediction, tolerance: contract.tolerance, observed });
  // golden 基准漂移时基准不可信，任何方向性结论都降级为 inconclusive。
  const verdict: AiHypothesisVerdict = goldenMatch ? judged.verdict : "inconclusive";
  const reasonCode: AiHypothesisReasonCode = goldenMatch ? judged.reasonCode : "golden-baseline-mismatch";
  const envelope = {
    proposalFingerprint,
    inputFingerprint,
    resultFingerprint,
    verdict,
    tolerance: contract.tolerance,
    reasonCode,
    rationale: rationale(contract, observed, verdict, reasonCode, goldenMatch),
    ...(observed === undefined ? {} : {
      observed: {
        metric: contract.prediction.metric,
        ...(contract.prediction.resourceId ? { resourceId: contract.prediction.resourceId } : {}),
        value: observed,
      },
    }),
    engineId: result.engineId,
    goldenHash,
    goldenMatch,
    generatedAt: new Date().toISOString(),
    evidence: [
      {
        id: resultFingerprint,
        kind: "simulation",
        label: "校准基准 DES 运行指标指纹",
        source: `model:${contract.targetModel}`,
        fingerprint: resultFingerprint,
      },
      {
        id: goldenHash,
        kind: "trace",
        label: goldenMatch ? "校准 golden 基准对照一致" : "校准 golden 基准对照漂移",
        source: "golden:t23-conveyor-sensor-agv",
        fingerprint: goldenHash,
      },
      {
        id: proposalFingerprint,
        kind: "rule",
        label: "假设合同指纹",
        source: `hypothesis:${contract.id}`,
        fingerprint: proposalFingerprint,
      },
    ],
  };
  // 出边界前用同一合同自检（fail-closed 双保险：不变量破坏即失败，不带病出域）。
  return validateAiVerificationEnvelope(envelope);
}

function readObservedMetric(result: PlantLiteExperimentResult, prediction: AiHypothesisPrediction): number | undefined {
  switch (prediction.metric) {
    case "resource-utilization": return result.resourceUtilization95[prediction.resourceId ?? ""]?.mean;
    case "throughput-per-hour": return result.confidence95.throughputPerHour.mean;
    case "average-wip": return result.confidence95.averageWip.mean;
    case "average-lead-time-minutes": return result.confidence95.averageLeadTimeMinutes.mean;
    case "first-pass-yield": return result.quality95?.firstPassYield.mean;
  }
}

function goldenBaselineDrifted(envelope: AiVerificationEnvelope): boolean {
  return envelope.reasonCode === "golden-baseline-mismatch";
}

function rationale(
  contract: AiHypothesisContract,
  observed: number | undefined,
  verdict: AiHypothesisVerdict,
  reasonCode: AiHypothesisReasonCode,
  goldenMatch: boolean,
): string {
  const locator = aiHypothesisMetricLocator(contract.prediction);
  const comparatorText = contract.prediction.comparator === "less-than" ? "低于" : "高于";
  if (reasonCode === "metric-unavailable") return `目标场景未提供可观测指标 ${locator}，无法裁决。`;
  if (reasonCode === "golden-baseline-mismatch") return `校准 golden 基准哈希漂移，基准不可信，结论降级为 inconclusive。`;
  const band = verdict === "inconclusive" ? "落在容差带内，证据不足以双向裁决" : `明确${contract.prediction.comparator === "less-than" ? "低于" : "高于"}阈值且越过容差带`;
  return `假设「${contract.statement}」：实测 ${locator}=${formatNumber(observed)}，${comparatorText}阈值 ${formatNumber(contract.prediction.expected)}，${band}${goldenMatch ? "；golden 基准对照一致" : ""}。`;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "N/A" : String(Number(value.toFixed(6)));
}

/**
 * 独立插件注册：页面、API、MCP 与工业 Agent 共用同一能力
 * （对齐 registerWorkcellValidationPlugin 的注册模式）。
 */
export async function registerAiHypothesisPlugin(registry: PluginRegistry): Promise<void> {
  const manifest = {
    schemaVersion: 1 as const,
    id: "bim.ai.simulation-hypothesis",
    name: "Simulation hypothesis harness",
    version: "1.0.0",
    apiVersion: "1.0",
    hosts: ["cloud"] as const,
    capabilities: ["simulation.hypothesis"],
    permissions: ["simulation.read"],
    extensionPoints: [{
      kind: "capability.provider" as const,
      id: "bim.simulation-hypothesis",
      capabilityIds: ["simulation.hypothesis.register", "simulation.golden.verify"],
      execution: "in-process" as const,
      limits: { timeoutMs: 30_000, maxInputBytes: 1024 * 1024, memoryMb: 128 },
    }],
  };
  const registered = registry.register(manifest, ({ registerCapability }) => {
    for (const provider of [createHypothesisRegisterProvider(), createGoldenVerifyProvider()]) {
      const result = registerCapability(provider);
      if (!result.ok) throw new Error(`假设 harness 能力注册失败：${result.message}`);
    }
  });
  if (!registered.ok) throw new Error(`假设 harness 插件不兼容：${registered.message}`);
  const enabled = await registry.enable(manifest.id);
  if (!enabled.ok) throw new Error(`假设 harness 插件启用失败：${enabled.message}`);
}
