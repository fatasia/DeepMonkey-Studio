import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { BatteryOnnxRuntime } from "./batteryPredictionRouter.js";
import type { BatteryPredictionInput } from "./batteryModelGateway.js";
import {
  prepareBatteryMformerInput,
  type BatteryMformerModelMetadata,
  type PreparedBatteryMformerInput,
} from "./batteryMformerPreprocessing.js";
import {
  readEmbeddingBundle,
  resolveConditionEmbedding,
  type EmbeddingDescriptor,
} from "./batteryMformerOnnxRuntime.js";
import { completeBatteryMformerPrediction } from "./batteryMformerPostprocessing.js";

interface PinnAdapter {
  schemaVersion: 1;
  modelId: "battery.batterymformer-pinn";
  modelVersion: string;
  kind: "batterymformer-spm-pinn-v1";
  runtime: "rust-ort";
  model: BatteryMformerModelMetadata & { physicsConditionSize: 11 };
  conditionEmbeddings: EmbeddingDescriptor;
}

interface PinnInferenceOutput {
  sohTrajectory: number[];
  physicalSoh: number[];
  physicsGate: number;
  identifiabilityScore: number;
  physicalObservationRmse: number;
  physicalFitScore: number;
  nominalCapacityAh: number;
  equivalentResistanceOhm: number;
  effectiveDiffusionTimeHours: number[];
  normalizedFadeRatePerCycle: number;
  chemistryFadeScale: number;
  ocvMinimumV: number;
  ocvSpanV: number;
  exchangeCRate: number;
  overpotentialScaleV: number;
}

const DEFAULT_ADAPTER = fileURLToPath(new URL(
  "../../battery-native-runtime/models/batterymformer-spm-pinn.adapter.json",
  import.meta.url,
));

/** 仅在 Node 侧执行确定性预/后处理；神经网络推理由 Rust ONNX Runtime 完成。 */
export class BatteryPinnRustRuntime implements BatteryOnnxRuntime {
  private resourcesPromise?: Promise<{ adapter: PinnAdapter; bundle: Awaited<ReturnType<typeof readEmbeddingBundle>> }>;

  constructor(
    private readonly baseUrl: string,
    private readonly adapterPath = DEFAULT_ADAPTER,
  ) {}

  async predict(input: BatteryPredictionInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (input.model !== "batterymformer" || input.variant !== "physics") {
      throw new Error("Rust PINN 运行时只接受 BatteryMFormer physics 变体");
    }
    const { adapter, bundle } = await this.resources();
    const prepared = prepareBatteryMformerInput(input, adapter.model);
    const condition = resolveConditionEmbedding(input, bundle);
    const physicsCondition = createPhysicsCondition(input, prepared);
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/inference/batterymformer-pinn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        curves: [...prepared.curves],
        curve_mask: [...prepared.curveMask],
        condition_embedding: [...condition.embedding],
        soh_input: [...prepared.sohInput],
        cycle_features: [...prepared.cycleFeatures],
        physics_condition: physicsCondition,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Rust PINN HTTP ${response.status}：${await response.text()}`);
    const envelope = await response.json() as { runtime?: unknown; modelVersion?: unknown; output?: unknown };
    const output = parseOutput(envelope.output);
    const base = completeBatteryMformerPrediction(
      output.sohTrajectory, input, prepared, adapter.model, condition.mode, adapter.modelVersion,
    );
    const threshold = (input.targetCapacityRetention ?? 80) / 100;
    const normalizedThreshold = (threshold - adapter.model.eolThreshold) / (1 - adapter.model.eolThreshold);
    const physicalCrossing = output.physicalSoh.findIndex(value => value <= normalizedThreshold);
    const warnings = Array.isArray(base.warnings) ? [...base.warnings] as string[] : [];
    if (output.identifiabilityScore < 0.55) {
      warnings.push("当前电流、SOC 或温度激励不足，物理参数可辨识度偏低；参数仅作为带先验的等效估计。");
    }
    return {
      ...base,
      serviceVariant: "physics",
      physicsArchitecture: "learnable-spm-pinn",
      rationale: [
        "BatteryMFormer PINN 由 Rust ONNX Runtime 执行。",
        "输入包含早期循环电压、电流、容量、SOC以及库仑/能量效率。",
        "物理专家联合约束颗粒扩散、边界、锂守恒、SOC、电压、能量与容量衰减动力学。",
        "未来 SOH 轨迹以最后已观测 SOH 锚定，并执行统一的单调工程校正。",
      ],
      warnings,
      identifiedPhysicsParameters: {
        identifiabilityScore: round(output.identifiabilityScore, 4),
        physicsBlendGate: round(output.physicsGate, 6),
        physicalObservationRmse: round(output.physicalObservationRmse, 6),
        physicalFitScore: round(output.physicalFitScore, 6),
        chemistryFamily: chemistryFamily(input),
        nominalCapacityAh: round(output.nominalCapacityAh, 6),
        equivalentResistanceOhm: round(output.equivalentResistanceOhm, 8),
        effectiveDiffusionTimeHours: output.effectiveDiffusionTimeHours.map(value => round(value, 6)),
        ocvMinimumV: round(output.ocvMinimumV, 6),
        ocvSpanV: round(output.ocvSpanV, 6),
        exchangeCRate: round(output.exchangeCRate, 6),
        overpotentialScaleV: round(output.overpotentialScaleV, 6),
        normalizedFadeRatePerCycle: round(output.normalizedFadeRatePerCycle, 9),
        chemistryFadeScale: round(output.chemistryFadeScale, 6),
        physicalTrajectoryCycleLife: physicalCrossing < 0 ? output.physicalSoh.length : physicalCrossing + 1,
        interpretation: "等效内阻、OCV 与极化量具有工程单位；扩散时间是归一化颗粒半径下的有效时间常数。",
      },
      runtimeExecution: {
        requested: "onnx", actual: "onnx", modelId: "battery.batterymformer-pinn",
        runtime: "rust-ort", fellBack: false,
      },
    };
  }

  private resources() {
    this.resourcesPromise ??= loadResources(this.adapterPath).catch(error => {
      delete this.resourcesPromise;
      throw error;
    });
    return this.resourcesPromise;
  }
}

async function loadResources(adapterPath: string) {
  const adapter = JSON.parse(await readFile(adapterPath, "utf8")) as PinnAdapter;
  if (adapter.schemaVersion !== 1 || adapter.modelId !== "battery.batterymformer-pinn"
    || adapter.kind !== "batterymformer-spm-pinn-v1" || adapter.runtime !== "rust-ort") {
    throw new Error("BatteryMFormer PINN 原生适配器结构无效");
  }
  return { adapter, bundle: await readEmbeddingBundle(adapterPath, adapter.conditionEmbeddings) };
}

function createPhysicsCondition(input: BatteryPredictionInput, prepared: PreparedBatteryMformerInput): number[] {
  const families = ["lfp", "nmc", "nca", "lco", "nmc_lco_blend", "li_ion_other"];
  const family = chemistryFamily(input);
  const temperature = firstNumber(input, ["temperatureC", "temperature", "ambientTemperatureC"]);
  const rates: number[] = [];
  for (let cycle = 0; cycle < 100; cycle += 1) {
    const offset = (cycle * 4 + 1) * 300;
    for (let point = 0; point < 300; point += 1) {
      const value = Math.abs(prepared.curves[offset + point] ?? 0);
      if (value > 0.01) rates.push(value);
    }
  }
  rates.sort((left, right) => left - right);
  const medianRate = rates.length ? rates[Math.floor(rates.length / 2)]! : 0;
  return [
    ...families.map(value => value === family ? 1 : 0),
    clamp(prepared.nominalCapacityAh / 100, 0, 2),
    temperature === undefined ? 0 : clamp((temperature - 25) / 20, -1.5, 2),
    clamp(medianRate, -5, 5) / 5,
    family === "li_ion_other" ? 0 : 1,
    temperature === undefined ? 0 : 1,
  ];
}

function chemistryFamily(input: BatteryPredictionInput): string {
  const text = [input.chemistry, input.fileName, ...input.records.slice(0, 10).flatMap(row => [row.chemistry, row.sourceDataset])]
    .join(" ").toUpperCase().replaceAll("-", "_");
  if (/NMC_LCO|NCM_LCO/.test(text)) return "nmc_lco_blend";
  if (/LFP|LIFEPO4/.test(text)) return "lfp";
  if (/NCA/.test(text)) return "nca";
  if (/NMC|NCM/.test(text)) return "nmc";
  if (/LCO/.test(text)) return "lco";
  return "li_ion_other";
}

function firstNumber(input: BatteryPredictionInput, keys: string[]): number | undefined {
  for (const row of input.records) for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) return value;
  }
  const match = input.fileName.match(/(?:^|_)(-?\d+(?:\.\d+)?)C(?:_|$)/i);
  return match ? Number(match[1]) : undefined;
}

function parseOutput(value: unknown): PinnInferenceOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rust PINN 输出格式无效");
  const output = value as PinnInferenceOutput;
  const arrays = [output.sohTrajectory, output.physicalSoh, output.effectiveDiffusionTimeHours];
  if (!arrays.every(item => Array.isArray(item) && item.every(Number.isFinite))) throw new Error("Rust PINN 输出数组无效");
  if (output.sohTrajectory.length !== 5000 || output.physicalSoh.length !== 5000) throw new Error("Rust PINN 输出轨迹长度无效");
  return output;
}

function clamp(value: number, minimum: number, maximum: number) { return Math.min(maximum, Math.max(minimum, value)); }
function round(value: number, digits: number) { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
