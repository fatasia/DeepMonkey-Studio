/**
 * T32 非 battery 最小消费链示例:T24 数据面同构的时间序列点 → 网关 ONNX 推理 →
 * DataMessage/DataEvent(与 packages/contracts/src/data.ts 的 data.ts 契约同构)。
 * 模型由调用方注入(测试用 fixtures/minimalOnnxLinearModel 的合成线性模型;
 * 真实工业预测模型应经批准清单制品提供,合同不变)。
 * 本模块不依赖 mqttIngest(T24 归属),只消费其产出形态的数据点。
 */
import { randomUUID } from "node:crypto";
import type { DataEvent, DataMessage } from "@bim-studio/contracts";
import type { OnnxInferenceGateway, OnnxInferenceResult } from "./onnxInferenceGateway.js";

export const TREND_FORECAST_MODEL_ID = "t32.trend-forecast";

export interface TrendForecastPoint {
  timestamp: string;
  value: number;
}

export interface TrendForecastOutcome {
  forecast: number;
  alarm: boolean;
  model: { modelId: string; version: string; executionProvider: string };
  /** 数据面同构消息;注入 projectId 时升级为 DataEvent(id 自动生成)。 */
  message: DataMessage;
}

export interface OnnxTrendForecasterOptions {
  gateway: OnnxInferenceGateway;
  modelBytes: Uint8Array;
  /** 预测越过该阈值即置 action:"alarm"。 */
  threshold: number;
  featureCount?: number;
  weights?: number[];
  source?: string;
  key?: string;
  modelVersion?: string;
}

export class OnnxTrendForecaster {
  private readonly featureCount: number;

  constructor(private readonly options: OnnxTrendForecasterOptions) {
    this.featureCount = options.featureCount ?? 3;
    if (!Number.isFinite(options.threshold)) throw new Error("趋势预测阈值必须为有限数值");
    options.gateway.register({
      modelId: TREND_FORECAST_MODEL_ID,
      version: options.modelVersion ?? "synthetic-linear-v1",
      contract: {
        inputs: [{ name: "x", elementType: "float32", dims: [this.featureCount] }],
        outputs: [{ name: "y", elementType: "float32", dims: [1] }],
      },
      modelBytes: options.modelBytes,
      timeoutMs: 10_000,
    });
  }

  /**
   * 特征 = [最新值, 一阶差分, 窗口均值];缺 2 个点或含非有限值即报错(fail-closed),
   * 不产出"看似正常"的预测。
   */
  async evaluate(points: TrendForecastPoint[], context?: { projectId?: string }): Promise<TrendForecastOutcome> {
    if (points.length < 2) throw new Error(`趋势预测至少需要 2 个数据点,收到 ${points.length}`);
    const values = points.map((point) => {
      if (!Number.isFinite(point.value)) throw new Error("趋势预测输入含非有限数值");
      if (Number.isNaN(Date.parse(point.timestamp))) throw new Error("趋势预测输入时间戳无效");
      return point.value;
    });
    const last = values[values.length - 1]!;
    const previous = values[values.length - 2]!;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const result = await this.options.gateway.infer({
      modelId: TREND_FORECAST_MODEL_ID,
      inputs: { x: { data: Float32Array.of(last, last - previous, mean), dims: [this.featureCount] } },
    });
    const forecast = (result.outputs.y?.data as Float32Array)[0]!;
    const alarm = forecast > this.options.threshold;
    return {
      forecast,
      alarm,
      model: { modelId: result.modelId, version: result.version, executionProvider: result.executionProvider },
      message: buildMessage(this.options, result, forecast, alarm, points, context),
    };
  }
}

function buildMessage(
  options: OnnxTrendForecasterOptions,
  result: OnnxInferenceResult,
  forecast: number,
  alarm: boolean,
  points: TrendForecastPoint[],
  context?: { projectId?: string },
): DataMessage {
  const base: DataMessage = {
    source: options.source ?? "onnx-inference-gateway",
    key: options.key ?? "trend.forecast",
    value: {
      forecast,
      threshold: options.threshold,
      window: { size: points.length, lastTimestamp: points[points.length - 1]?.timestamp },
      model: { modelId: result.modelId, version: result.version, executionProvider: result.executionProvider },
    },
    timestamp: new Date().toISOString(),
    ...(alarm ? { action: "alarm" as const } : {}),
  };
  if (context?.projectId === undefined) return base;
  const event: DataEvent = { ...base, id: randomUUID(), projectId: context.projectId };
  return event;
}
