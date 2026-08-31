import {
  assessBatteryOnnxMigration,
  type BatteryOnnxEquivalenceManifest,
  type FormalBatteryPrimaryModelId
} from "@bim-studio/contracts";
import type { BatteryPredictionInput, FormalBatteryModel } from "./batteryModelGateway.js";
import {
  attachBatteryInferenceEvidence,
  createBatteryInferenceContext,
  outputDomainEvidence,
  runBatteryInferenceWithTimeout,
  type BatteryInferenceContext,
} from "./batteryInferenceGovernance.js";

export type BatteryPredictionRuntime = "python-service" | "onnx";

export interface BatteryOnnxRuntime {
  /** Runtime 必须包含与清单一致的预处理和后处理，不接受直接把原始记录喂给裸模型。 */
  predict(input: BatteryPredictionInput, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export interface BatteryPredictionRouterOptions {
  pythonPredict(input: BatteryPredictionInput, signal?: AbortSignal): Promise<Record<string, unknown>>;
  onnxRuntime?: BatteryOnnxRuntime;
  onnxManifests?: readonly BatteryOnnxEquivalenceManifest[];
  runtimeByModel?: Partial<Record<FormalBatteryModel, BatteryPredictionRuntime>>;
  /** 必须短于上游请求总超时，为 Python 主链回退保留时间。 */
  onnxTimeoutMs?: number;
}

interface RuntimeExecution {
  requested: BatteryPredictionRuntime;
  actual: BatteryPredictionRuntime;
  modelId: FormalBatteryPrimaryModelId;
  fellBack: boolean;
  reason?: string;
}

/**
 * 分模型选择运行时。Python 永远是默认主链；只有正式批准的清单才能开启 ONNX，
 * 且 ONNX 加载、推理或输出校验失败时会自动回到 Python 服务。
 */
export function createBatteryPredictionRouter(options: BatteryPredictionRouterOptions) {
  const eligibleModels = new Set(
    assessBatteryOnnxMigration(options.onnxManifests ?? []).eligibleModelIds
  );

  return async (input: BatteryPredictionInput, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const modelId = toCatalogModelId(input.model);
    const requested = options.runtimeByModel?.[input.model] ?? "python-service";
    const context = createBatteryInferenceContext(input, requested, options.onnxManifests ?? []);
    const python = (reason?: string, domain = context.domain) => runPython(
      options, input, modelId, requested, reason, domain, context, signal,
    );

    if (requested !== "onnx") return python();
    if ((input.variant ?? "standard") !== "standard") return python("路由专家保持由现有 Python 模型服务执行");
    if (context.domain.status === "out-of-domain") return python(`ONNX 输入域预检未通过：${context.domain.reasons.join("；")}`);
    if (!eligibleModels.has(modelId)) return python("缺少经独立数据与生产审批通过的 ONNX 等价清单");
    if (!options.onnxRuntime) return python("未配置包含正式预处理与后处理的 ONNX 运行时");

    try {
      const output = objectOutput(await runBatteryInferenceWithTimeout(
        (runtimeSignal) => options.onnxRuntime!.predict(input, runtimeSignal),
        options.onnxTimeoutMs ?? 20_000,
        signal,
      ));
      const runtimeDomain = outputDomainEvidence(output) ?? context.domain;
      if (runtimeDomain.status === "out-of-domain") {
        return python(`ONNX 适配器判定输入域外：${runtimeDomain.reasons.join("；")}`, runtimeDomain);
      }
      const executed = withExecution(output, { requested, actual: "onnx", modelId, fellBack: false });
      return attachBatteryInferenceEvidence(executed, context, {
        actualRuntime: "onnx", fellBack: false, domain: runtimeDomain,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      return python(`ONNX 执行失败：${errorMessage(error)}`);
    }
  };
}

async function runPython(
  options: BatteryPredictionRouterOptions,
  input: BatteryPredictionInput,
  modelId: FormalBatteryPrimaryModelId,
  requested: BatteryPredictionRuntime,
  reason: string | undefined,
  domain: BatteryInferenceContext["domain"],
  context: BatteryInferenceContext,
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>> {
  const output = await options.pythonPredict(input, signal);
  const executed = withExecution(output, {
    requested,
    actual: "python-service",
    modelId,
    fellBack: requested === "onnx",
    ...(reason ? { reason } : {})
  });
  return attachBatteryInferenceEvidence(executed, context, {
    actualRuntime: "python-service",
    fellBack: requested === "onnx",
    ...(reason ? { fallbackReason: reason } : {}),
    domain,
  });
}

function withExecution(output: Record<string, unknown>, execution: RuntimeExecution): Record<string, unknown> {
  return { ...output, runtimeExecution: execution };
}

function toCatalogModelId(model: FormalBatteryModel): FormalBatteryPrimaryModelId {
  return `battery.${model}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "未知错误";
}

function objectOutput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ONNX 运行时返回格式无效");
  return value as Record<string, unknown>;
}
