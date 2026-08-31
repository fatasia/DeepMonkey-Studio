import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { MaintenanceModelPackage } from "@bim-studio/contracts";

interface IotNbMaintenanceModel {
  version?: string;
  name?: string;
  algorithm?: string;
  sourceId?: string;
  status?: "candidate" | "validated" | "retired";
  benchmarkOnly?: boolean;
  productionEligible?: boolean;
  evaluationProtocol?: string;
  dataFingerprint?: string;
  trainRows?: number;
  validationRows?: number;
  metrics?: Record<string, unknown>;
  artifact?: Record<string, unknown>;
  createdAt?: string;
}

export interface IotNbProjectDocument {
  name?: string;
  updatedAt?: string;
  payload?: {
    projectId?: string;
    projectName?: string;
    maintenanceModels?: IotNbMaintenanceModel[];
    trainingDatasets?: Array<{
      id?: string;
      name?: string;
      benchmarkOnly?: boolean;
      rows?: Array<Record<string, unknown>>;
    }>;
  };
}

export const DEFAULT_MAINTENANCE_GATES: MaintenanceModelPackage["gates"] = {
  minimumSamples: 30,
  minimumDataQuality: 0.9,
  maximumDriftSigma: 5,
  warningThreshold: 0.45,
  criticalThreshold: 0.7,
  scoreDirection: "high-risk"
};

export async function resolveIotNbProjectPath(configuredPath?: string): Promise<string> {
  const explicit = configuredPath?.trim() || process.env.IOT_NB_PROJECT_PATH?.trim();
  if (explicit) return explicit.toLowerCase().endsWith(".json") ? explicit : path.join(explicit, "project.json");
  const appData = process.env.APPDATA?.trim() || path.join(homedir(), "AppData", "Roaming");
  const root = path.join(appData, "com.iotnb.studio");
  let activeProjectId: string;
  try { activeProjectId = (await readFile(path.join(root, "active-project.txt"), "utf8")).trim(); }
  catch { throw new Error("未找到 Iot-nb 当前工程；请先在 Iot-nb 中打开并保存工程"); }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(activeProjectId)) throw new Error("Iot-nb 当前工程 ID 无效");
  try {
    const locations = JSON.parse(await readFile(path.join(root, "project-locations.json"), "utf8")) as Record<string, unknown>;
    const external = locations[activeProjectId];
    if (typeof external === "string" && external.trim()) return path.join(external, "project.json");
  } catch { /* 未配置外部工程位置时使用默认目录。 */ }
  return path.join(root, "projects", activeProjectId, "project.json");
}

/** 只同步具备可执行制品和完整特征定义的正式模型，不携带 Iot-NB 示例数据。 */
export function adaptIotNbModel(projectId: string, source: IotNbMaintenanceModel): MaintenanceModelPackage {
  const artifactSource = source.artifact ?? {};
  const features = stringArray(artifactSource.features);
  const weights = numberArray(artifactSource.weights);
  if (!source.version?.trim() || !source.name?.trim() || !features.length) throw new Error("Iot-nb 模型缺少版本、名称或特征定义");
  const onnxPath = typeof artifactSource.onnxPath === "string" && artifactSource.onnxPath.trim() ? artifactSource.onnxPath.trim() : undefined;
  const engine = artifactSource.onnxExported === true && onnxPath ? "onnx" : "native-json";
  if (engine === "native-json" && weights.length !== features.length) throw new Error(`Iot-nb 模型 ${source.version} 缺少可执行权重`);
  const modelKind = normalizeIotNbModelKind(artifactSource.modelKind, source.algorithm);
  const means = numberArray(artifactSource.means ?? artifactSource.featureMeans);
  const stds = numberArray(artifactSource.stds ?? artifactSource.featureStds);
  const outputMean = finiteNumber(artifactSource.outputMean);
  const outputStd = finiteNumber(artifactSource.outputStd);
  const bias = finiteNumber(artifactSource.bias);
  const residualP90 = finiteNumber(artifactSource.residualP90);
  const targetColumn = textValue(artifactSource.targetColumn) ?? (modelKind === "rul" || modelKind === "regression" ? textValue(artifactSource.labelColumn) : undefined);
  const gates = iotNbGates(modelKind, source.name, targetColumn, outputMean, outputStd, bias, finiteNumber(artifactSource.decisionThreshold));
  const now = new Date().toISOString();
  return {
    id: randomUUID(), projectId, name: source.name.trim(), version: source.version.trim(), algorithm: source.algorithm?.trim() || "Iot-nb trained model",
    source: "iot-nb", status: source.status === "retired" ? "retired" : source.status === "validated" ? "validated" : "candidate",
    benchmarkOnly: source.benchmarkOnly === true, productionEligible: source.productionEligible === true,
    evaluationProtocol: source.evaluationProtocol?.trim() || "从 Iot-nb 当前工程同步；进入生产前需完成影子评测",
    dataFingerprint: source.dataFingerprint?.trim() || `iot-nb:${source.version.trim()}`,
    trainRows: Math.max(0, Math.floor(Number(source.trainRows ?? 0))), validationRows: Math.max(0, Math.floor(Number(source.validationRows ?? 0))),
    metrics: Object.fromEntries(Object.entries(source.metrics ?? {}).filter((entry): entry is [string, number] => Number.isFinite(entry[1])).map(([key, value]) => [key, Number(value)])),
    artifact: {
      engine, modelKind, features,
      ...(means.length === features.length ? { means } : {}), ...(stds.length === features.length ? { stds } : {}),
      ...(engine === "native-json" ? { weights } : {}), ...(bias !== undefined ? { bias } : {}),
      ...(outputMean !== undefined ? { outputMean } : {}), ...(outputStd !== undefined ? { outputStd } : {}),
      ...(residualP90 !== undefined ? { residualP90 } : {}), ...(finiteNumber(artifactSource.decisionThreshold) !== undefined ? { decisionThreshold: finiteNumber(artifactSource.decisionThreshold)! } : {}),
      ...(textValue(artifactSource.labelColumn) ? { labelColumn: textValue(artifactSource.labelColumn)! } : {}), ...(targetColumn ? { targetColumn } : {}),
      ...(textValue(artifactSource.targetUnit) ? { targetUnit: textValue(artifactSource.targetUnit)! } : {}),
      ...(finiteNumber(artifactSource.window) !== undefined ? { window: Math.max(1, Math.floor(finiteNumber(artifactSource.window)!)) } : {}),
      ...(textValue(artifactSource.inputName) ? { inputName: textValue(artifactSource.inputName)! } : {}), ...(textValue(artifactSource.outputName) ? { outputName: textValue(artifactSource.outputName)! } : {}),
      ...(finiteNumber(artifactSource.outputIndex) !== undefined ? { outputIndex: Math.max(0, Math.floor(finiteNumber(artifactSource.outputIndex)!)) } : {}),
      ...(artifactSource.inputNormalization === true ? { inputNormalization: true } : {}),
      ...(normalizeOutputTransform(artifactSource.outputTransform) ? { outputTransform: normalizeOutputTransform(artifactSource.outputTransform)! } : {})
    },
    ...(onnxPath ? { artifactPath: onnxPath } : {}), gates, createdAt: source.createdAt?.trim() || now, updatedAt: now
  };
}

function normalizeIotNbModelKind(value: unknown, algorithm?: string): MaintenanceModelPackage["artifact"]["modelKind"] {
  if (value === "rul" || value === "regression" || value === "anomaly" || value === "failure-probability") return value;
  const name = algorithm?.toLowerCase() ?? "";
  if (name.includes("rul") || name.includes("寿命")) return "rul";
  if (name.includes("regression") || name.includes("回归")) return "regression";
  if (name.includes("isolation") || name.includes("异常")) return "anomaly";
  return "failure-probability";
}

function normalizeOutputTransform(value: unknown): MaintenanceModelPackage["artifact"]["outputTransform"] | undefined {
  if (value === "identity" || value === "sigmoid" || value === "class1" || value === "anomaly-score") return value;
  return value === "anomaly_score" ? "anomaly-score" : undefined;
}

function iotNbGates(kind: MaintenanceModelPackage["artifact"]["modelKind"], name: string, targetColumn: string | undefined, outputMean: number | undefined, outputStd: number | undefined, bias: number | undefined, decisionThreshold: number | undefined): MaintenanceModelPackage["gates"] {
  if (kind === "failure-probability" || kind === "anomaly") return { ...DEFAULT_MAINTENANCE_GATES, warningThreshold: Math.max(0, (decisionThreshold ?? .5) * .9), criticalThreshold: Math.min(1, Math.max(decisionThreshold ?? .5, .7)) };
  const center = outputMean ?? bias ?? 1;
  const spread = Math.max(Math.abs(outputStd ?? 0), Math.abs(center) * .1, 1e-6);
  const lowRisk = kind === "rul" || /capacity|容量/i.test(`${name} ${targetColumn ?? ""}`);
  return lowRisk
    ? { ...DEFAULT_MAINTENANCE_GATES, warningThreshold: center - spread * 1.5, criticalThreshold: center - spread * 3, scoreDirection: "low-risk" }
    : { ...DEFAULT_MAINTENANCE_GATES, warningThreshold: center + spread * 1.5, criticalThreshold: center + spread * 3, scoreDirection: "high-risk" };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
