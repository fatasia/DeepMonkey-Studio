import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-node";
import type { BatteryOnnxRuntime } from "./batteryPredictionRouter.js";
import type { BatteryPredictionInput, FormalBatteryModel } from "./batteryModelGateway.js";
import type { BatteryOnnxDeployment, BatteryOnnxModelDeployment } from "./batteryOnnxDeployment.js";
import {
  completeBmsOnnxPrediction,
  prepareBmsOnnxInput,
  type BmsOnnxAdapterModel,
} from "./batteryBmsOnnxAdapter.js";
import {
  completeSocOnnxPrediction,
  prepareSocOnnxInput,
  type SocOnnxAdapterModel,
} from "./batterySocOnnxAdapter.js";

type WindowAdapterKind = "bmsformer-window-v1" | "socformer-window-v1";

interface WindowAdapterDocument {
  schemaVersion: 1;
  modelId: `battery.${"bmsformer" | "socformer"}`;
  modelVersion: string;
  kind: WindowAdapterKind;
  session: { inputs: ["input"]; output: "output" };
  model: BmsOnnxAdapterModel | SocOnnxAdapterModel;
}

interface SessionLike {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, { data: ArrayLike<number> }>>;
}

export interface BatteryWindowOnnxRuntimeOptions {
  createSession?: (artifactPath: string) => Promise<SessionLike>;
}

/**
 * 两个窗口模型共用一个轻量运行时。会话与适配器按模型懒加载并缓存，
 * 失败由上层路由回退 Python；这里不吞掉制品或输出合同错误。
 */
export class BatteryWindowOnnxRuntime implements BatteryOnnxRuntime {
  private readonly adapters = new Map<FormalBatteryModel, Promise<WindowAdapterDocument>>();
  private readonly sessions = new Map<FormalBatteryModel, Promise<SessionLike>>();
  private readonly createSession: (artifactPath: string) => Promise<SessionLike>;

  constructor(
    private readonly deployment: BatteryOnnxDeployment,
    options: BatteryWindowOnnxRuntimeOptions = {},
  ) {
    this.createSession = options.createSession ?? defaultSession;
  }

  async predict(input: BatteryPredictionInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (input.model === "batterymformer") throw new Error("BatteryMFormer 使用独立多模态 ONNX 适配器");
    assertNotAborted(signal);
    const deployment = this.modelDeployment(input.model);
    const [adapter, session] = await Promise.all([
      this.adapter(input.model, deployment),
      this.session(input.model, deployment),
    ]);
    assertNotAborted(signal);
    assertSessionContract(session, adapter);

    if (input.model === "bmsformer") {
      const prepared = prepareBmsOnnxInput(input, adapter.model as BmsOnnxAdapterModel);
      const output = await session.run({ input: new ort.Tensor("float32", prepared.data, prepared.dimensions) });
      assertNotAborted(signal);
      const values = numericOutput(output[adapter.session.output]);
      if (values.length !== 1) throw new Error(`BMSFormer ONNX 应返回 1 个 SOH，实际为 ${values.length}`);
      return completeBmsOnnxPrediction(values[0]!, prepared, adapter.model as BmsOnnxAdapterModel, adapter.modelVersion);
    }

    const prepared = prepareSocOnnxInput(input, adapter.model as SocOnnxAdapterModel);
    const output = await session.run({ input: new ort.Tensor("float32", prepared.data, prepared.dimensions) });
    assertNotAborted(signal);
    return completeSocOnnxPrediction(
      numericOutput(output[adapter.session.output]),
      prepared,
      adapter.model as SocOnnxAdapterModel,
      adapter.modelVersion,
    );
  }

  private modelDeployment(model: "bmsformer" | "socformer"): BatteryOnnxModelDeployment {
    const deployment = this.deployment.models[model];
    if (!deployment) throw new Error(`${model} 未配置经批准并校验的 ONNX 制品`);
    return deployment;
  }

  private adapter(model: "bmsformer" | "socformer", deployment: BatteryOnnxModelDeployment): Promise<WindowAdapterDocument> {
    let adapter = this.adapters.get(model);
    if (!adapter) {
      adapter = readAdapter(deployment, model).catch(error => { this.adapters.delete(model); throw error; });
      this.adapters.set(model, adapter);
    }
    return adapter;
  }

  private session(model: "bmsformer" | "socformer", deployment: BatteryOnnxModelDeployment): Promise<SessionLike> {
    let session = this.sessions.get(model);
    if (!session) {
      session = this.createSession(deployment.artifactPath).catch(error => { this.sessions.delete(model); throw error; });
      this.sessions.set(model, session);
    }
    return session;
  }
}

async function readAdapter(
  deployment: BatteryOnnxModelDeployment,
  model: "bmsformer" | "socformer",
): Promise<WindowAdapterDocument> {
  const parsed: unknown = JSON.parse(await readFile(deployment.runtimeAdapterPath, "utf8"));
  if (!isWindowAdapter(parsed)) throw new Error(`${model} ONNX 运行适配器结构无效`);
  if (parsed.modelId !== deployment.manifest.modelId || parsed.modelVersion !== deployment.manifest.source.modelVersion) {
    throw new Error(`${model} ONNX 运行适配器与批准清单版本不一致`);
  }
  const expectedKind: WindowAdapterKind = model === "bmsformer" ? "bmsformer-window-v1" : "socformer-window-v1";
  if (parsed.kind !== expectedKind) throw new Error(`${model} ONNX 运行适配器类型错误`);
  validateModelMetadata(parsed.model, model);
  return parsed;
}

function isWindowAdapter(value: unknown): value is WindowAdapterDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const session = object(item.session);
  return item.schemaVersion === 1
    && ["battery.bmsformer", "battery.socformer"].includes(String(item.modelId))
    && typeof item.modelVersion === "string" && item.modelVersion.length > 0
    && ["bmsformer-window-v1", "socformer-window-v1"].includes(String(item.kind))
    && Array.isArray(session.inputs) && session.inputs.length === 1 && session.inputs[0] === "input"
    && session.output === "output"
    && Boolean(item.model) && typeof item.model === "object" && !Array.isArray(item.model);
}

function validateModelMetadata(value: BmsOnnxAdapterModel | SocOnnxAdapterModel, model: "bmsformer" | "socformer"): void {
  const item = value as unknown as Record<string, unknown>;
  const features = Number(item.inputFeatures);
  const windowSize = Number(item.windowSize);
  for (const field of ["featureNames", "featureMean", "featureStd", "chemistryScope"] as const) {
    if (!Array.isArray(item[field])) throw new Error(`${model} 运行适配器缺少 ${field}`);
  }
  if (!Number.isSafeInteger(features) || features <= 0 || !Number.isSafeInteger(windowSize) || windowSize <= 0) {
    throw new Error(`${model} 运行适配器模型维度无效`);
  }
  if ((item.featureNames as unknown[]).length !== features || (item.featureMean as unknown[]).length !== features || (item.featureStd as unknown[]).length !== features) {
    throw new Error(`${model} 运行适配器特征维度不一致`);
  }
  if (![...(item.featureMean as unknown[]), ...(item.featureStd as unknown[])].every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error(`${model} 运行适配器包含非有限特征统计`);
  }
  const chemistryScope = item.chemistryScope as unknown[];
  if (chemistryScope.length === 0 || !chemistryScope.every((entry) => ["lfp", "ncm"].includes(String(entry)))) {
    throw new Error(`${model} 运行适配器化学体系范围无效`);
  }
  if (model === "socformer" && (typeof item.deepCorrectionWeight !== "number"
    || !Number.isFinite(item.deepCorrectionWeight) || item.deepCorrectionWeight < 0 || item.deepCorrectionWeight > 1)) {
    throw new Error("SOCFormer 运行适配器深度校正权重必须在 0–1 范围内");
  }
}

function assertSessionContract(session: SessionLike, adapter: WindowAdapterDocument): void {
  if (!session.inputNames.includes(adapter.session.inputs[0]) || !session.outputNames.includes(adapter.session.output)) {
    throw new Error(`ONNX 会话输入输出与运行适配器不一致：${session.inputNames.join(",")} -> ${session.outputNames.join(",")}`);
  }
}

function numericOutput(value: { data: ArrayLike<number> } | undefined): number[] {
  if (!value) throw new Error("ONNX 会话缺少约定输出");
  const values = Array.from(value.data);
  if (values.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) throw new Error("ONNX 会话返回非有限数值");
  return values;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("电池 ONNX 推理已取消");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function defaultSession(artifactPath: string): Promise<SessionLike> {
  return ort.InferenceSession.create(artifactPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  }) as unknown as SessionLike;
}
