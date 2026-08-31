import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  assessBatteryOnnxMigration,
  type BatteryOnnxEquivalenceManifest,
  type FormalBatteryPrimaryModelId,
} from "@bim-studio/contracts";
import type { FormalBatteryModel } from "./batteryModelGateway.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MODEL_BYTES = 256 * 1024 * 1024;
const MAX_ADAPTER_BYTES = 16 * 1024 * 1024;
const MAX_EMBEDDING_BYTES = 64 * 1024 * 1024;

export interface BatteryOnnxModelDeployment {
  manifest: BatteryOnnxEquivalenceManifest;
  artifactPath: string;
  runtimeAdapterPath: string;
}

export interface BatteryOnnxDeployment {
  enabled: boolean;
  manifestFile?: string;
  artifactRoot?: string;
  requestedModels: FormalBatteryModel[];
  manifests: BatteryOnnxEquivalenceManifest[];
  models: Partial<Record<FormalBatteryModel, BatteryOnnxModelDeployment>>;
  diagnostics: string[];
}

/**
 * 从显式生产配置加载 ONNX 制品。候选报告不会被识别为批准清单；
 * 目录边界、大小与 SHA-256 均通过后，调用方才可构造运行时。
 */
export async function loadBatteryOnnxDeployment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BatteryOnnxDeployment> {
  const configuredManifest = environment.BATTERY_ONNX_MANIFEST_FILE?.trim();
  if (!configuredManifest) return disabledDeployment();

  const manifestFile = resolve(configuredManifest);
  const artifactRoot = resolve(environment.BATTERY_ONNX_ARTIFACT_ROOT?.trim() || dirname(manifestFile));
  const manifests = await readManifestFile(manifestFile);
  const assessment = assessBatteryOnnxMigration(manifests);
  const requestedModels = parseRequestedModels(environment.BATTERY_ONNX_MODELS, assessment.eligibleModelIds);
  const requestedIds = new Set(requestedModels.map((model) => `battery.${model}`));
  const relevantBlockers = assessment.blockers.filter((blocker) => {
    const modelId = blocker.match(/^battery\.[a-z-]+/)?.[0];
    return !blocker.includes("缺少 ONNX 等价清单") || (modelId ? requestedIds.has(modelId) : true);
  });
  if (relevantBlockers.length > 0) {
    throw new Error(`电池 ONNX 发布清单未通过：${relevantBlockers.join("；")}`);
  }
  const models: Partial<Record<FormalBatteryModel, BatteryOnnxModelDeployment>> = {};
  for (const model of requestedModels) {
    const modelId = `battery.${model}` as FormalBatteryPrimaryModelId;
    const manifest = manifests.find((candidate) => candidate.modelId === modelId);
    if (!manifest) throw new Error(`电池 ONNX 配置缺少 ${modelId} 正式清单`);
    const artifactPath = resolveArtifactPath(artifactRoot, manifest.artifact.fileName);
    const runtimeAdapterPath = resolveArtifactPath(artifactRoot, manifest.runtimeAdapter.fileName);
    await verifyFile(artifactPath, manifest.artifact.sizeBytes, manifest.artifact.sha256, "ONNX 模型", MAX_MODEL_BYTES);
    await verifyFile(runtimeAdapterPath, manifest.runtimeAdapter.sizeBytes, manifest.runtimeAdapter.sha256, "运行适配器", MAX_ADAPTER_BYTES);
    await verifyRuntimeAdapterResources(runtimeAdapterPath, artifactRoot, manifest);
    models[model] = { manifest, artifactPath, runtimeAdapterPath };
  }

  return {
    enabled: requestedModels.length > 0,
    manifestFile,
    artifactRoot,
    requestedModels,
    manifests,
    models,
    diagnostics: requestedModels.length > 0
      ? [`已校验 ${requestedModels.length} 个正式 ONNX 模型及运行适配器`]
      : ["清单有效，但未请求启用任何 ONNX 模型"],
  };
}

async function verifyRuntimeAdapterResources(
  adapterPath: string,
  artifactRoot: string,
  manifest: BatteryOnnxEquivalenceManifest,
): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(adapterPath, "utf8"));
  const adapter = record(parsed);
  const expectedKinds: Record<FormalBatteryPrimaryModelId, string> = {
    "battery.bmsformer": "bmsformer-window-v1",
    "battery.socformer": "socformer-window-v1",
    "battery.batterymformer": "batterymformer-multimodal-v1",
  };
  if (adapter.schemaVersion !== 1 || adapter.modelId !== manifest.modelId
    || adapter.modelVersion !== manifest.source.modelVersion || adapter.kind !== expectedKinds[manifest.modelId]) {
    throw new Error(`${manifest.modelId} 运行适配器身份或版本与批准清单不一致`);
  }
  if (manifest.modelId !== "battery.batterymformer") return;
  const embeddings = record(adapter.conditionEmbeddings);
  if (!safeFileName(embeddings.fileName) || !sha(embeddings.sha256)
    || !positiveInteger(embeddings.sizeBytes) || !positiveInteger(embeddings.rows)
    || !positiveInteger(embeddings.columns)
    || Number(embeddings.rows) * Number(embeddings.columns) * 4 !== embeddings.sizeBytes) {
    throw new Error("BatteryMFormer 工况嵌入描述无效");
  }
  const embeddingPath = resolveArtifactPath(artifactRoot, embeddings.fileName);
  await verifyFile(embeddingPath, Number(embeddings.sizeBytes), String(embeddings.sha256), "工况嵌入", MAX_EMBEDDING_BYTES);
}

async function readManifestFile(path: string): Promise<BatteryOnnxEquivalenceManifest[]> {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_MANIFEST_BYTES) {
    throw new Error(`电池 ONNX 清单体积无效：${info.size} bytes`);
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (values.length === 0 || !values.every(isManifestShape)) {
    throw new Error("电池 ONNX 清单结构无效");
  }
  return values;
}

function isManifestShape(value: unknown): value is BatteryOnnxEquivalenceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const artifact = record(item.artifact);
  const adapter = record(item.runtimeAdapter);
  const source = record(item.source);
  const contract = record(item.contract);
  const validation = record(item.validation);
  const approval = record(item.approval);
  return item.schemaVersion === 1
    && ["battery.bmsformer", "battery.socformer", "battery.batterymformer"].includes(String(item.modelId))
    && nonEmpty(source.modelVersion) && sha(source.checkpointSha256)
    && safeFileName(artifact.fileName) && sha(artifact.sha256) && positiveInteger(artifact.sizeBytes)
    && artifact.opset === 18 && artifact.precision === "fp32"
    && safeFileName(adapter.fileName) && String(adapter.fileName).endsWith(".json")
    && sha(adapter.sha256) && positiveInteger(adapter.sizeBytes) && adapter.schemaVersion === 1
    && nonEmpty(contract.input) && nonEmpty(contract.output)
    && nonEmpty(contract.preprocessing) && nonEmpty(contract.postprocessing)
    && Array.isArray(validation.outputs)
    && approval.decisionStatus === "production-approved";
}

function parseRequestedModels(
  raw: string | undefined,
  eligible: readonly FormalBatteryPrimaryModelId[],
): FormalBatteryModel[] {
  const values = raw?.split(",").map((value) => value.trim()).filter(Boolean)
    ?? eligible.map((modelId) => modelId.replace("battery.", ""));
  const supported = new Set<FormalBatteryModel>(["bmsformer", "socformer", "batterymformer"]);
  const unique = [...new Set(values)];
  if (!unique.every((value): value is FormalBatteryModel => supported.has(value as FormalBatteryModel))) {
    throw new Error(`BATTERY_ONNX_MODELS 包含未知模型：${unique.filter((value) => !supported.has(value as FormalBatteryModel)).join(", ")}`);
  }
  return unique;
}

function resolveArtifactPath(root: string, fileName: string): string {
  if (!safeFileName(fileName)) throw new Error(`电池 ONNX 制品文件名无效：${fileName}`);
  const target = resolve(root, fileName);
  const route = relative(root, target);
  if (route.startsWith("..") || isAbsolute(route)) throw new Error(`电池 ONNX 制品越出配置目录：${fileName}`);
  return target;
}

async function verifyFile(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
  label: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Promise<void> {
  const info = await stat(path);
  if (!info.isFile() || info.size !== expectedBytes || info.size > maximumBytes) {
    throw new Error(`${label}体积与清单不一致：${basename(path)}`);
  }
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  if (digest !== expectedSha256.toLowerCase()) throw new Error(`${label}哈希与清单不一致：${basename(path)}`);
}

function disabledDeployment(): BatteryOnnxDeployment {
  return {
    enabled: false,
    requestedModels: [],
    manifests: [],
    models: {},
    diagnostics: ["未配置 BATTERY_ONNX_MANIFEST_FILE，保持 Python 正式主输出"],
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function sha(value: unknown): boolean {
  return typeof value === "string" && /^[a-f\d]{64}$/i.test(value);
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeFileName(value: unknown): value is string {
  return typeof value === "string" && value === basename(value) && value !== "." && value !== "..";
}
