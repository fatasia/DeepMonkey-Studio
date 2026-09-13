import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import * as ort from "onnxruntime-node";
import type { BatteryOnnxRuntime } from "./batteryPredictionRouter.js";
import type { BatteryPredictionInput } from "./batteryModelGateway.js";
import type { BatteryOnnxDeployment, BatteryOnnxModelDeployment } from "./batteryOnnxDeployment.js";
import { prepareBatteryMformerInput, type BatteryMformerModelMetadata } from "./batteryMformerPreprocessing.js";
import { completeBatteryMformerPrediction, type BatteryMformerConditionMode } from "./batteryMformerPostprocessing.js";

export interface EmbeddingDescriptor {
  fileName: string;
  sha256: string;
  sizeBytes: number;
  rows: number;
  columns: number;
  keys: string[];
  fallbackPrefix: string;
}

interface BatteryMformerAdapterDocument {
  schemaVersion: 1;
  modelId: "battery.batterymformer";
  modelVersion: string;
  kind: "batterymformer-multimodal-v1";
  session: {
    inputs: ["curves", "curve_mask", "condition_embedding", "soh_input", "cycle_features"];
    output: "soh_trajectory";
  };
  model: BatteryMformerModelMetadata;
  conditionEmbeddings: EmbeddingDescriptor;
}

interface SessionLike {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, { data: ArrayLike<number> }>>;
}

export interface EmbeddingBundle {
  data: Float32Array;
  byKey: Map<string, number>;
  descriptor: EmbeddingDescriptor;
}

export interface BatteryMformerOnnxRuntimeOptions {
  createSession?: (artifactPath: string) => Promise<SessionLike>;
}

/** BatteryMFormer 单独懒加载 34MiB 模型及工况包，不进入 API 启动热路径和 Web 产物。 */
export class BatteryMformerOnnxRuntime implements BatteryOnnxRuntime {
  private adapterPromise?: Promise<BatteryMformerAdapterDocument>;
  private sessionPromise?: Promise<SessionLike>;
  private bundlePromise?: Promise<EmbeddingBundle>;
  private readonly createSession: (artifactPath: string) => Promise<SessionLike>;

  constructor(
    private readonly deployment: BatteryOnnxDeployment,
    options: BatteryMformerOnnxRuntimeOptions = {},
  ) {
    this.createSession = options.createSession ?? defaultSession;
  }

  async predict(input: BatteryPredictionInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (input.model !== "batterymformer") throw new Error("BatteryMFormer 运行时只接受 batterymformer");
    assertNotAborted(signal);
    const deployment = this.modelDeployment();
    const [adapter, session] = await Promise.all([this.adapter(deployment), this.session(deployment)]);
    assertSessionContract(session, adapter);
    const [prepared, bundle] = await Promise.all([
      Promise.resolve(prepareBatteryMformerInput(input, adapter.model)),
      this.bundle(deployment, adapter),
    ]);
    const condition = resolveConditionEmbedding(input, bundle);
    assertNotAborted(signal);
    const feeds = {
      curves: new ort.Tensor("float32", prepared.curves, [1, adapter.model.earlyCycles, 4, adapter.model.curveLength]),
      curve_mask: new ort.Tensor("float32", prepared.curveMask, [1, adapter.model.earlyCycles]),
      condition_embedding: new ort.Tensor("float32", condition.embedding, [1, 1, adapter.model.conditionEmbeddingSize]),
      soh_input: new ort.Tensor("float32", prepared.sohInput, [1, adapter.model.earlyCycles, 1]),
      cycle_features: new ort.Tensor("float32", prepared.cycleFeatures, [1, adapter.model.earlyCycles, 2]),
    };
    const output = await session.run(feeds);
    assertNotAborted(signal);
    const normalized = numericOutput(output[adapter.session.output]);
    return completeBatteryMformerPrediction(normalized, input, prepared, adapter.model, condition.mode, adapter.modelVersion);
  }

  private modelDeployment(): BatteryOnnxModelDeployment {
    const deployment = this.deployment.models.batterymformer;
    if (!deployment) throw new Error("BatteryMFormer 未配置经批准并校验的 ONNX 制品");
    return deployment;
  }

  private adapter(deployment: BatteryOnnxModelDeployment): Promise<BatteryMformerAdapterDocument> {
    this.adapterPromise ??= readAdapter(deployment).catch(error => { delete this.adapterPromise; throw error; });
    return this.adapterPromise;
  }

  private session(deployment: BatteryOnnxModelDeployment): Promise<SessionLike> {
    this.sessionPromise ??= this.createSession(deployment.artifactPath).catch(error => { delete this.sessionPromise; throw error; });
    return this.sessionPromise;
  }

  private bundle(deployment: BatteryOnnxModelDeployment, adapter: BatteryMformerAdapterDocument): Promise<EmbeddingBundle> {
    this.bundlePromise ??= readEmbeddingBundle(deployment.runtimeAdapterPath, adapter.conditionEmbeddings).catch(error => { delete this.bundlePromise; throw error; });
    return this.bundlePromise;
  }
}

async function readAdapter(deployment: BatteryOnnxModelDeployment): Promise<BatteryMformerAdapterDocument> {
  const parsed: unknown = JSON.parse(await readFile(deployment.runtimeAdapterPath, "utf8"));
  if (!isAdapter(parsed)) throw new Error("BatteryMFormer ONNX 运行适配器结构无效");
  if (parsed.modelId !== deployment.manifest.modelId || parsed.modelVersion !== deployment.manifest.source.modelVersion) {
    throw new Error("BatteryMFormer ONNX 运行适配器与批准清单版本不一致");
  }
  validateModel(parsed.model);
  validateEmbeddingDescriptor(parsed.conditionEmbeddings, parsed.model.conditionEmbeddingSize);
  return parsed;
}

export async function readEmbeddingBundle(adapterPath: string, descriptor: EmbeddingDescriptor): Promise<EmbeddingBundle> {
  if (descriptor.fileName !== basename(descriptor.fileName)) throw new Error("BatteryMFormer 工况嵌入文件名越界");
  const path = resolve(dirname(adapterPath), descriptor.fileName);
  const info = await stat(path);
  const expectedBytes = descriptor.rows * descriptor.columns * Float32Array.BYTES_PER_ELEMENT;
  if (!info.isFile() || info.size !== descriptor.sizeBytes || info.size !== expectedBytes) throw new Error("BatteryMFormer 工况嵌入体积与适配器不一致");
  const bytes = await readFile(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== descriptor.sha256.toLowerCase()) throw new Error("BatteryMFormer 工况嵌入哈希与适配器不一致");
  const data = new Float32Array(descriptor.rows * descriptor.columns);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < data.length; index += 1) data[index] = view.getFloat32(index * 4, true);
  return { data, byKey: new Map(descriptor.keys.map((key, index) => [key, index])), descriptor };
}

export function resolveConditionEmbedding(input: BatteryPredictionInput, bundle: EmbeddingBundle): { embedding: Float32Array; mode: BatteryMformerConditionMode } {
  const suppliedNames = [input.fileName, ...input.records.map((record) => String(record.sourceFile ?? "")).filter(Boolean)]
    .map(fileBaseName);
  const candidates = [...new Set([
    ...suppliedNames,
    ...suppliedNames.filter((name) => name.toLowerCase().endsWith(".csv")).map((name) => `${name.slice(0, -4)}.pkl`),
  ])];
  const exact = candidates.map((candidate) => bundle.byKey.get(candidate)).find((index) => index !== undefined);
  if (exact !== undefined) return { embedding: embeddingRow(bundle, exact), mode: "exact-batterylife" };
  const fallbackRows = bundle.descriptor.keys.flatMap((key, index) => key.startsWith(bundle.descriptor.fallbackPrefix) ? [index] : []);
  if (fallbackRows.length === 0) throw new Error("BatteryMFormer 工况包缺少受控 CALB 质心回退");
  const embedding = new Float32Array(bundle.descriptor.columns);
  for (const row of fallbackRows) {
    const source = embeddingRow(bundle, row);
    for (let column = 0; column < embedding.length; column += 1) {
      embedding[column] = embedding[column]! + source[column]! / fallbackRows.length;
    }
  }
  return { embedding, mode: "centroid" };
}

function embeddingRow(bundle: EmbeddingBundle, row: number): Float32Array {
  const start = row * bundle.descriptor.columns;
  return bundle.data.slice(start, start + bundle.descriptor.columns);
}

function isAdapter(value: unknown): value is BatteryMformerAdapterDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const session = object(item.session);
  return item.schemaVersion === 1 && item.modelId === "battery.batterymformer"
    && typeof item.modelVersion === "string" && item.modelVersion.length > 0
    && item.kind === "batterymformer-multimodal-v1"
    && Array.isArray(session.inputs) && session.inputs.join(",") === "curves,curve_mask,condition_embedding,soh_input,cycle_features"
    && session.output === "soh_trajectory"
    && Boolean(item.model) && typeof item.model === "object" && !Array.isArray(item.model)
    && Boolean(item.conditionEmbeddings) && typeof item.conditionEmbeddings === "object" && !Array.isArray(item.conditionEmbeddings);
}

function validateModel(model: BatteryMformerModelMetadata): void {
  for (const [field, value] of Object.entries(model).filter(([field]) => ["earlyCycles", "curveLength", "conditionEmbeddingSize", "predictionLength"].includes(field))) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`BatteryMFormer 运行适配器 ${field} 无效`);
  }
  if (!Number.isFinite(model.eolThreshold) || model.eolThreshold <= 0 || model.eolThreshold >= 1) throw new Error("BatteryMFormer 运行适配器 EOL 阈值无效");
}

function validateEmbeddingDescriptor(descriptor: EmbeddingDescriptor, columns: number): void {
  if (descriptor.fileName !== basename(descriptor.fileName) || !/^[a-f\d]{64}$/i.test(descriptor.sha256)
    || !Number.isSafeInteger(descriptor.sizeBytes) || descriptor.sizeBytes <= 0
    || !Number.isSafeInteger(descriptor.rows) || descriptor.rows <= 0
    || descriptor.columns !== columns || descriptor.keys.length !== descriptor.rows
    || new Set(descriptor.keys).size !== descriptor.keys.length || !descriptor.fallbackPrefix) {
    throw new Error("BatteryMFormer 工况嵌入描述无效");
  }
}

function assertSessionContract(session: SessionLike, adapter: BatteryMformerAdapterDocument): void {
  if (!adapter.session.inputs.every((name) => session.inputNames.includes(name)) || !session.outputNames.includes(adapter.session.output)) {
    throw new Error("BatteryMFormer ONNX 会话输入输出与运行适配器不一致");
  }
}

function numericOutput(value: { data: ArrayLike<number> } | undefined): number[] {
  if (!value) throw new Error("BatteryMFormer ONNX 会话缺少约定输出");
  const result = Array.from(value.data);
  if (result.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) throw new Error("BatteryMFormer ONNX 返回非有限轨迹");
  return result;
}

function fileBaseName(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1) ?? "";
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("电池 ONNX 推理已取消");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function defaultSession(artifactPath: string): Promise<SessionLike> {
  return ort.InferenceSession.create(artifactPath, { executionProviders: ["cpu"], graphOptimizationLevel: "all" }) as unknown as SessionLike;
}
