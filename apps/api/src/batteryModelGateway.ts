import type { BatteryModelCatalogEntry, BatteryOnnxEquivalenceManifest } from "@bim-studio/contracts";
import { BATTERY_MODEL_CATALOG } from "@bim-studio/contracts";
import {
  createBatteryPredictionRouter,
  type BatteryOnnxRuntime,
  type BatteryPredictionRuntime
} from "./batteryPredictionRouter.js";
import {
  applyTwinProductionRoute,
  expertVariant,
  physicsRiskReasons,
  selectLifeExpert,
  twinCommitState,
  unwrapBatteryPrediction,
  type BatteryExpertRoutingMode,
} from "./batteryExpertRouting.js";

export type FormalBatteryModel = "bmsformer" | "socformer" | "batterymformer";
export type BatteryChemistry = "lfp" | "ncm" | "na-ion";
export type BatteryModelVariant = "standard" | "physics";

export interface BatteryPredictionInput {
  model: FormalBatteryModel;
  variant?: BatteryModelVariant;
  /** BatteryMFormer 的产品级专家路由；不传时保持单专家兼容行为。 */
  routingMode?: BatteryExpertRoutingMode;
  fileName: string;
  records: Array<Record<string, string | number>>;
  nominalCapacityAh?: number;
  chemistry?: BatteryChemistry;
  targetCapacityRetention?: number;
}

export interface BatteryTwinInitializeInput {
  chemistry?: BatteryChemistry;
  nominalCapacityAh?: number;
  soh?: number;
  soc?: number;
  temperatureC?: number;
  transferContext?: Record<string, unknown>;
}

export interface BatteryTwinSimulationInput {
  twinId: string;
  scenarioName?: string;
  resolutionMinutes?: number;
  segments: Array<{ durationMinutes: number; currentCRate: number; ambientTemperatureC?: number }>;
  executionMode?: "both" | "dynamic";
  commit?: boolean;
}

export interface BatteryTwinAssimilationInput {
  twinId: string;
  soc?: number;
  soh?: number;
  temperatureC?: number;
}

export interface BatteryModelGateway {
  predict(input: BatteryPredictionInput, signal?: AbortSignal): Promise<Record<string, unknown>>;
  health(signal?: AbortSignal): Promise<unknown>;
  digitalTwinStatus(signal?: AbortSignal): Promise<Record<string, unknown>>;
  releaseStatus(signal?: AbortSignal): Promise<Record<string, unknown>>;
  initializeTwin(input: BatteryTwinInitializeInput, signal?: AbortSignal): Promise<Record<string, unknown>>;
  simulateTwin(input: BatteryTwinSimulationInput, signal?: AbortSignal): Promise<Record<string, unknown>>;
  assimilateTwin(input: BatteryTwinAssimilationInput, signal?: AbortSignal): Promise<Record<string, unknown>>;
  twinEvidence(twinId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export interface BatteryTransport {
  request(path: string, init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal }): Promise<unknown>;
}

export interface BatteryModelGatewayOptions {
  baseUrl?: string;
  timeoutMs?: number;
  transport?: BatteryTransport;
  onnxRuntime?: BatteryOnnxRuntime;
  onnxManifests?: readonly BatteryOnnxEquivalenceManifest[];
  runtimeByModel?: Partial<Record<FormalBatteryModel, BatteryPredictionRuntime>>;
  onnxTimeoutMs?: number;
}

/**
 * 电池能力的唯一 API 边界。主工程复用原服务已经验证的专家和 TwinMoE 动态路由，
 * 在产品层统一最终采纳、回退、提交与证据；完成 ONNX 等价验证后只需替换 transport。
 */
export function createBatteryModelGateway(options: BatteryModelGatewayOptions = {}): BatteryModelGateway {
  const serviceUrl = options.baseUrl ?? process.env.BATTERY_MODEL_SERVICE_URL?.trim();
  const transport = options.transport ?? (serviceUrl ? new HttpBatteryTransport(serviceUrl, options.timeoutMs ?? 30_000) : {
    async request(): Promise<never> { throw new Error("未配置外置电池服务；默认 SOC/SOH/RUL 使用项目内置 ONNX 模型"); },
  });
  const objectResponse = async (path: string, init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal }) => {
    const response = await transport.request(path, init);
    if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("电池模型服务返回格式无效");
    return response as Record<string, unknown>;
  };

  const pythonPredict = async (input: BatteryPredictionInput, signal?: AbortSignal) => {
      validatePredictionInput(input);
      return objectResponse("/predict", {
        method: "POST",
        ...optionalSignal(signal),
        body: {
          model: input.model,
          file_name: input.fileName,
          records: input.records,
          ...(input.nominalCapacityAh !== undefined ? { nominal_capacity_ah: input.nominalCapacityAh } : {}),
          ...(input.chemistry ? { chemistry: input.chemistry } : {}),
          ...(input.targetCapacityRetention !== undefined ? { target_capacity_retention: input.targetCapacityRetention } : {}),
          variant: input.variant ?? "standard"
        }
      });
  };
  const predictRuntime = createBatteryPredictionRouter({
    pythonPredict,
    ...(options.onnxRuntime ? { onnxRuntime: options.onnxRuntime } : {}),
    ...(options.onnxManifests ? { onnxManifests: options.onnxManifests } : {}),
    ...(options.runtimeByModel ? { runtimeByModel: options.runtimeByModel } : {}),
    ...(options.onnxTimeoutMs !== undefined ? { onnxTimeoutMs: options.onnxTimeoutMs } : {})
  });

  return {
    predict: async (input, signal) => {
      validatePredictionInput(input);
      const mode = input.routingMode ?? input.variant ?? "standard";
      if (input.model !== "batterymformer" || mode === "standard") {
        return unwrapBatteryPrediction(await predictRuntime(input, signal));
      }
      if (mode === "physics") {
        const physics = unwrapBatteryPrediction(await predictRuntime({ ...input, variant: expertVariant(mode) }, signal));
        return withExpertRouting(selectLifeExpert(mode, physics, physics, ["用户明确选择物理专家"]));
      }

      const standard = unwrapBatteryPrediction(await predictRuntime({ ...input, variant: "standard" }, signal));
      const reasons = physicsRiskReasons(standard);
      if (mode === "dynamic" && reasons.length === 0) {
        return withExpertRouting(selectLifeExpert(mode, standard, undefined, reasons));
      }
      try {
        const physics = unwrapBatteryPrediction(await predictRuntime({ ...input, variant: "physics" }, signal));
        return withExpertRouting(selectLifeExpert(mode, standard, physics, reasons));
      } catch (error) {
        return withExpertRouting(selectLifeExpert(mode, standard, undefined, [
          ...reasons,
          `PINN 执行失败：${errorMessage(error)}`,
        ]));
      }
    },
    health: (signal) => transport.request("/health", { method: "GET", ...optionalSignal(signal) }),
    digitalTwinStatus: async (signal) => platformTwinStatus(
      await objectResponse("/research/digital-twin/status", { method: "GET", ...optionalSignal(signal) }),
    ),
    releaseStatus: async (signal) => platformReleaseStatus(
      await objectResponse("/research/release/status", { method: "GET", ...optionalSignal(signal) }),
    ),
    initializeTwin: (input, signal) => {
      validateTwinInitializeInput(input);
      return objectResponse("/research/digital-twin/initialize", {
        method: "POST",
        ...optionalSignal(signal),
        body: {
          ...(input.chemistry ? { chemistry: input.chemistry } : {}),
          ...(input.nominalCapacityAh !== undefined ? { nominal_capacity_ah: input.nominalCapacityAh } : {}),
          ...(input.soh !== undefined ? { soh: input.soh } : {}),
          ...(input.soc !== undefined ? { soc: input.soc } : {}),
          ...(input.temperatureC !== undefined ? { temperature_c: input.temperatureC } : {}),
          ...(input.transferContext ? { transfer_context: input.transferContext } : {})
        }
      });
    },
    simulateTwin: async (input, signal) => {
      validateTwinSimulationInput(input);
      const executionMode = input.executionMode ?? "dynamic";
      // 源服务只负责计算候选轨迹；最终采用和提交由平台正式路由统一完成。
      const raw = await objectResponse("/research/digital-twin/simulate-short-horizon", {
        method: "POST",
        ...optionalSignal(signal),
        body: {
          twin_id: input.twinId,
          scenario_name: input.scenarioName ?? "未来工况",
          resolution_minutes: input.resolutionMinutes ?? 1,
          segments: input.segments.map((segment) => ({
            duration_minutes: segment.durationMinutes,
            current_c_rate: segment.currentCRate,
            ...(segment.ambientTemperatureC !== undefined ? { ambient_temperature_c: segment.ambientTemperatureC } : {})
          })),
          execution_mode: executionMode,
          commit: false
        }
      });
      const routed = applyTwinProductionRoute(raw, executionMode);
      if (!input.commit) return routed;
      const state = twinCommitState(routed);
      if (!state) throw new Error("正式路由未返回可提交的孪生状态");
      const committedState = await objectResponse("/research/digital-twin/assimilate-cycle", {
        method: "POST",
        ...optionalSignal(signal),
        body: { twin_id: input.twinId, soc: state.soc, ...(state.temperatureC !== undefined ? { temperature_c: state.temperatureC } : {}) }
      });
      return { ...routed, committedState, commitSource: "selected-production-route" };
    },
    assimilateTwin: (input, signal) => {
      assertTwinId(input.twinId, "数字孪生同化");
      assertOptionalRange(input.soc, "soc", 0, 1);
      assertOptionalRange(input.soh, "soh", 0.5, 1.05);
      assertOptionalRange(input.temperatureC, "temperatureC", -30, 80);
      return objectResponse("/research/digital-twin/assimilate-cycle", {
        method: "POST",
        ...optionalSignal(signal),
        body: {
          twin_id: input.twinId,
          ...(input.soc !== undefined ? { soc: input.soc } : {}),
          ...(input.soh !== undefined ? { soh: input.soh } : {}),
          ...(input.temperatureC !== undefined ? { temperature_c: input.temperatureC } : {})
        }
      });
    },
    twinEvidence: (twinId, signal) => {
      assertTwinId(twinId, "查询孪生证据");
      return objectResponse(`/research/digital-twin/${encodeURIComponent(twinId)}/evidence`, { method: "GET", ...optionalSignal(signal) });
    }
  };
}

export function formalBatteryModel(model: string): BatteryModelCatalogEntry | undefined {
  return BATTERY_MODEL_CATALOG.find((entry) => entry.family === model && entry.role === "primary-model");
}

function validatePredictionInput(input: BatteryPredictionInput): void {
  const catalog = formalBatteryModel(input.model);
  if (!catalog) throw new Error(`不支持的电池正式模型：${input.model}`);
  if ((input.variant ?? "standard") === "physics" && input.model !== "batterymformer") throw new Error("physics 变体仅适用于 BatteryMFormer PINN 专家");
  if (input.routingMode && input.model !== "batterymformer") throw new Error("专家路由仅适用于 BatteryMFormer");
  if (!input.fileName.trim()) throw new Error("电池预测必须包含 fileName");
  if (!Array.isArray(input.records) || input.records.length === 0) throw new Error("电池预测至少需要一条记录");
  if (input.chemistry && !catalog.chemistryScope.includes(input.chemistry)) throw new Error(`${catalog.label} 不支持 ${input.chemistry.toUpperCase()} 化学体系`);
  if (input.nominalCapacityAh !== undefined && (!Number.isFinite(input.nominalCapacityAh) || input.nominalCapacityAh <= 0)) throw new Error("nominalCapacityAh 必须为有限正数");
  assertOptionalRange(input.targetCapacityRetention, "targetCapacityRetention", 50, 100);
}

function withExpertRouting(decision: ReturnType<typeof selectLifeExpert>): Record<string, unknown> {
  return {
    ...decision.selected,
    expertRouting: decision.evidence,
    decisionAuthority: "production-route",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : "未知错误";
}

function platformTwinStatus(source: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "production-routed",
    routingPolicy: "standard-to-pinn + electrothermal-to-pino-to-spm",
    productionOutputEnabled: true,
    sourceRuntime: source,
  };
}

function platformReleaseStatus(source: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "production-routed",
    productionOutputEnabled: true,
    productionTrafficPolicy: "dynamic-risk-route",
    routedModels: ["battery.batterymformer-pinn", "battery.spm-pino", "battery.twin-moe"],
    fallbackModel: "battery.spm-fallback",
    // 保留源工程旧门禁，便于追溯历史证据；平台最终采用权由当前正式路由合同管理。
    sourceReleaseGate: source,
  };
}

function validateTwinInitializeInput(input: BatteryTwinInitializeInput): void {
  assertOptionalRange(input.nominalCapacityAh, "nominalCapacityAh", Number.EPSILON, 2000);
  assertOptionalRange(input.soh, "soh", 0.5, 1.05);
  assertOptionalRange(input.soc, "soc", 0, 1);
  assertOptionalRange(input.temperatureC, "temperatureC", -30, 80);
}

function validateTwinSimulationInput(input: BatteryTwinSimulationInput): void {
  assertTwinId(input.twinId, "数字孪生模拟");
  if (input.scenarioName !== undefined) {
    if (!input.scenarioName.trim()) throw new Error("数字孪生场景名称不能为空");
    if ([...input.scenarioName].length > 80) throw new Error("数字孪生场景名称不能超过 80 个字符");
  }
  if (!Array.isArray(input.segments) || input.segments.length === 0) throw new Error("数字孪生模拟至少需要一个工况片段");
  if (input.segments.length > 12) throw new Error("数字孪生模拟最多支持 12 个工况片段");
  assertOptionalRange(input.resolutionMinutes, "resolutionMinutes", 0.25, 10);
  input.segments.forEach((segment, index) => {
    assertRange(segment.durationMinutes, `segments[${index}].durationMinutes`, Number.EPSILON, 120);
    assertRange(segment.currentCRate, `segments[${index}].currentCRate`, -3, 3);
    assertOptionalRange(segment.ambientTemperatureC, `segments[${index}].ambientTemperatureC`, -30, 80);
  });
  const totalDurationMinutes = input.segments.reduce((total, segment) => total + segment.durationMinutes, 0);
  if (totalDurationMinutes > 120) throw new Error("数字孪生短时模拟总时长不能超过 120 分钟");
}

function assertTwinId(twinId: string, action: string): void {
  if (twinId.trim().length < 8) throw new Error(`${action}必须包含至少 8 个字符的 twinId`);
}

function assertOptionalRange(value: number | undefined, field: string, minimum: number, maximum: number): void {
  if (value !== undefined) assertRange(value, field, minimum, maximum);
}

function assertRange(value: number, field: string, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${field} 必须在 ${minimum}–${maximum} 范围内`);
}

function optionalSignal(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}

class HttpBatteryTransport implements BatteryTransport {
  constructor(private readonly baseUrl: string, private readonly timeoutMs: number) {}

  async request(path: string, init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal }): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortFromCaller = () => controller.abort();
    init.signal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method: init.method,
        signal: controller.signal,
        headers: init.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(`电池模型服务 HTTP ${response.status}${payload && typeof payload === "object" && "detail" in payload ? `：${JSON.stringify(payload.detail)}` : ""}`);
      return payload;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(init.signal?.aborted ? "电池模型调用已取消" : `电池模型服务超时（${this.timeoutMs}ms）`);
      throw error;
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
