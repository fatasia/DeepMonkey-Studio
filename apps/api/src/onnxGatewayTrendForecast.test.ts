import { describe, expect, it } from "vitest";
import { minimalOnnxLinearModel } from "./fixtures/minimalOnnxLinearModel.js";
import { OnnxInferenceGateway } from "./onnxInferenceGateway.js";
import { OnnxTrendForecaster, TREND_FORECAST_MODEL_ID } from "./onnxGatewayTrendForecast.js";

function makeForecaster(options: { threshold: number; weights?: number[] }): { gateway: OnnxInferenceGateway; forecaster: OnnxTrendForecaster } {
  const gateway = new OnnxInferenceGateway();
  const forecaster = new OnnxTrendForecaster({
    gateway,
    modelBytes: minimalOnnxLinearModel({ weights: options.weights ?? [0.7, 0.2, 0.1] }),
    threshold: options.threshold,
  });
  return { gateway, forecaster };
}

function points(...values: number[]) {
  return values.map((value, index) => ({ timestamp: new Date(Date.UTC(2026, 8, 27, 0, index)).toISOString(), value }));
}

describe("onnx gateway trend forecast — non-battery consumer chain", () => {
  it("registers the model in the gateway and produces a data-plane message", async () => {
    const { gateway, forecaster } = makeForecaster({ threshold: 100 });
    expect(gateway.has(TREND_FORECAST_MODEL_ID)).toBe(true);
    const outcome = await forecaster.evaluate(points(10, 12, 14, 16));
    expect(outcome.model.modelId).toBe(TREND_FORECAST_MODEL_ID);
    expect(outcome.model.executionProvider).toBe("cpu");
    expect(outcome.message.source).toBe("onnx-inference-gateway");
    expect(outcome.message.key).toBe("trend.forecast");
    expect(outcome.message.timestamp).toBeTruthy();
    expect(outcome.message.action).toBeUndefined();
  });

  it("matches the hand-computed linear forecast for the injected weights", async () => {
    const { forecaster } = makeForecaster({ threshold: 1e6, weights: [1, 0, 0] });
    const outcome = await forecaster.evaluate(points(21.5, 23.25));
    // 特征 [23.25, 1.75, 22.375],权重 [1,0,0] → y = 23.25
    expect(outcome.forecast).toBeCloseTo(23.25, 5);
    expect(outcome.alarm).toBe(false);
  });

  it("raises an alarm data event when the forecast crosses the threshold", async () => {
    const { forecaster } = makeForecaster({ threshold: 90 });
    // last=120, delta=30, mean=82.5 → 0.7·120+0.2·30+0.1·82.5 = 98.25 > 90
    const outcome = await forecaster.evaluate(points(50, 70, 90, 120));
    expect(outcome.alarm).toBe(true);
    expect(outcome.message.action).toBe("alarm");
    const value = outcome.message.value as Record<string, unknown>;
    expect(value.threshold).toBe(90);
    expect((value.model as Record<string, unknown>).executionProvider).toBe("cpu");
  });

  it("upgrades the message to a DataEvent when a projectId is supplied", async () => {
    const { forecaster } = makeForecaster({ threshold: 90 });
    const outcome = await forecaster.evaluate(points(1, 2), { projectId: "proj-t32" });
    const event = outcome.message as typeof outcome.message & { id: string; projectId: string };
    expect(event.id).toBeTruthy();
    expect(event.projectId).toBe("proj-t32");
  });

  it("fails closed on insufficient, non-finite or ill-timestamped points", async () => {
    const { forecaster } = makeForecaster({ threshold: 90 });
    await expect(forecaster.evaluate(points(1))).rejects.toThrow("至少需要 2 个数据点");
    await expect(forecaster.evaluate(points(1, Number.NaN))).rejects.toThrow("非有限数值");
    await expect(forecaster.evaluate([{ timestamp: "not-a-date", value: 1 }, { timestamp: "2026-09-27T00:00:00Z", value: 2 }]))
      .rejects.toThrow("时间戳无效");
  });

  it("rejects an invalid threshold before any inference", () => {
    const gateway = new OnnxInferenceGateway();
    expect(() => new OnnxTrendForecaster({ gateway, modelBytes: minimalOnnxLinearModel(), threshold: Number.NaN }))
      .toThrow("阈值必须为有限数值");
    expect(gateway.has(TREND_FORECAST_MODEL_ID)).toBe(false);
  });
});
