import type { BatteryOnnxRuntime } from "./batteryPredictionRouter.js";
import type { BatteryPredictionInput } from "./batteryModelGateway.js";
import type { BatteryOnnxDeployment } from "./batteryOnnxDeployment.js";
import { BatteryWindowOnnxRuntime } from "./batteryWindowOnnxRuntime.js";
import { BatteryMformerOnnxRuntime } from "./batteryMformerOnnxRuntime.js";

/** 三个正式主模型的统一 ONNX 入口；PINN/PINO/TwinMoE 不经过该运行时。 */
export class BatteryProductionOnnxRuntime implements BatteryOnnxRuntime {
  private readonly windowRuntime: BatteryWindowOnnxRuntime;
  private readonly mformerRuntime: BatteryMformerOnnxRuntime;

  constructor(deployment: BatteryOnnxDeployment) {
    this.windowRuntime = new BatteryWindowOnnxRuntime(deployment);
    this.mformerRuntime = new BatteryMformerOnnxRuntime(deployment);
  }

  predict(input: BatteryPredictionInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return input.model === "batterymformer"
      ? this.mformerRuntime.predict(input, signal)
      : this.windowRuntime.predict(input, signal);
  }
}
