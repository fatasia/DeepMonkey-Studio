import type { BatteryModelGateway } from "./batteryModelGateway.js";
import type { BatteryOnnxDeployment } from "./batteryOnnxDeployment.js";
import { BatteryProductionOnnxRuntime } from "./batteryProductionOnnxRuntime.js";
import type { BatteryOnnxRuntime } from "./batteryPredictionRouter.js";
import { physicsRiskReasons, selectLifeExpert } from "./batteryExpertRouting.js";
import { attachBatteryInferenceEvidence, createBatteryInferenceContext, outputDomainEvidence, runBatteryInferenceWithTimeout } from "./batteryInferenceGovernance.js";

export function createLocalBatteryGateway(
  deployment: BatteryOnnxDeployment,
  physicsRuntime?: BatteryOnnxRuntime,
): BatteryModelGateway {
  const runtime = new BatteryProductionOnnxRuntime(deployment);
  const unavailable = async (): Promise<Record<string, unknown>> => { throw new Error("此物理专家未包含在本项目模型包中"); };
  const standardPrediction = async (input: Parameters<BatteryModelGateway["predict"]>[0], signal?: AbortSignal) => {
    const { routingMode: _routingMode, ...baseInput } = input;
    const standardInput = { ...baseInput, variant: "standard" as const };
    const context = createBatteryInferenceContext(standardInput, "onnx", deployment.manifests);
    if (context.domain.status === "out-of-domain") throw new Error(`输入不满足本地模型合同：${context.domain.reasons.join("；")}`);
    const output = await runBatteryInferenceWithTimeout(runtimeSignal => runtime.predict(standardInput, runtimeSignal), 25_000, signal);
    const domain = outputDomainEvidence(output) ?? context.domain;
    const governed = attachBatteryInferenceEvidence(output, context, { actualRuntime: "onnx", fellBack: false, domain });
    return { ...governed,
      productionApproved: false, decisionAuthority: "advisory", executionMode: "local-validation",
      requestedRoutingMode: input.routingMode ?? "standard", executedRoutingMode: "standard",
      runtimeExecution: { requested: "onnx", actual: "onnx", modelId: context.modelId, fellBack: false },
      inferenceEvidence: { ...(governed.inferenceEvidence as Record<string, unknown>), authority: "advisory", routingPolicy: "local-validation-onnx" },
      warnings: [...(Array.isArray(governed.warnings) ? governed.warnings : []), "本地验证模型，未获生产批准。"],
    };
  };
  return {
    async predict(input, signal) {
      const mode = input.routingMode ?? input.variant ?? "standard";
      if (input.model !== "batterymformer" || mode === "standard") return standardPrediction(input, signal);
      if (!physicsRuntime) throw new Error("本地模型包未接入 Rust ONNX PINN 物理专家");
      if (mode === "physics") {
        const physics = await physicsRuntime.predict({ ...input, variant: "physics" }, signal);
        return withExpertRouting(selectLifeExpert(mode, physics, physics, ["用户明确选择物理专家"]));
      }
      const standard = await standardPrediction(input, signal);
      const reasons = physicsRiskReasons(standard);
      if (mode === "dynamic" && reasons.length === 0) return withExpertRouting(selectLifeExpert(mode, standard, undefined, reasons));
      try {
        const physics = await physicsRuntime.predict({ ...input, variant: "physics" }, signal);
        return withExpertRouting(selectLifeExpert(mode, standard, physics, reasons));
      } catch (error) {
        return withExpertRouting(selectLifeExpert(mode, standard, undefined, [
          ...reasons, `PINN 执行失败：${error instanceof Error ? error.message : "未知错误"}`,
        ]));
      }
    },
    health: async () => ({ ok: true, runtime: "onnx", mode: "local-validation", models: deployment.requestedModels }),
    releaseStatus: async () => ({ status: "local-validation", productionOutputEnabled: false, runtime: "onnx", models: deployment.requestedModels }),
    digitalTwinStatus: unavailable, initializeTwin: unavailable, simulateTwin: unavailable, assimilateTwin: unavailable, twinEvidence: unavailable,
  };
}

function withExpertRouting(decision: ReturnType<typeof selectLifeExpert>): Record<string, unknown> {
  return { ...decision.selected, expertRouting: decision.evidence, decisionAuthority: "production-route" };
}
