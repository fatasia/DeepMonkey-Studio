/**
 * T32 引擎侧 ONNX 推理网关的执行提供器(EP)策略。
 * CPU EP 永远保证可用并兜底;GPU 类 EP(webgpu/dml)是可选项——先按
 * onnxruntime-node 官方 listSupportedBackends 探测捆绑情况,会话创建仍失败时
 * 降级 CPU(契约校验与输出语义一致,仅执行后端不同)。
 */
import * as ort from "onnxruntime-node";

export interface ProviderSessionOutput {
  data: ArrayLike<number | bigint>;
  dims: readonly number[];
  type: string;
}

export type ProviderSession = {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ProviderSessionOutput>>;
  release?(): void;
};

export interface OnnxArtifact {
  path?: string;
  bytes?: Uint8Array;
}

export interface ExecutionProviderPlan {
  providers: string[];
  unavailable: string[];
}

export interface CreatedOnnxSession {
  session: ProviderSession;
  /** 实际生效的首选执行提供器(降级后为 "cpu")。 */
  executionProvider: string;
  /** 不为空表示发生了能力缺口或创建失败降级;内容是可操作的原因。 */
  fallbackReason?: string;
}

export type SessionFactory = (artifact: OnnxArtifact, providers: string[]) => Promise<ProviderSession>;

const PROVIDER_NAME_PATTERN = /^[a-z0-9_-]+$/;

/** 当前平台捆绑的执行提供器;探测本身失败时按"仅 CPU"处理(CPU 是硬底线)。 */
export function bundledExecutionProviders(): string[] {
  try {
    return ort.listSupportedBackends().map((backend) => String(backend.name));
  } catch {
    return ["cpu"];
  }
}

/**
 * 把首选 EP 列表解析成可执行列表:捆绑不支持的记入 unavailable(不静默),
 * 解析结果为空或不含 cpu 时在末尾追加 cpu 兜底。
 */
export function resolveExecutionProviders(
  preferred: readonly string[],
  supported: readonly string[],
): ExecutionProviderPlan {
  const unique = [...new Set(preferred.map((name) => name.trim()).filter(Boolean))];
  const illegal = unique.filter((name) => !PROVIDER_NAME_PATTERN.test(name));
  if (illegal.length > 0) throw new Error(`执行提供器名称非法：${illegal.join(", ")}`);
  const unavailable = unique.filter((name) => !supported.includes(name));
  const available = unique.filter((name) => supported.includes(name));
  const providers = available.includes("cpu") ? available : [...available, "cpu"];
  return { providers, unavailable };
}

/**
 * 创建 ONNX 会话:按解析出的 EP 列表创建;列表含非 CPU EP 且创建失败时降级纯 CPU
 * 重试一次并记录原因。纯 CPU 创建失败直接抛错(fail-closed,不冒充成功)。
 */
export async function createOnnxSession(options: {
  artifact: OnnxArtifact;
  preferredProviders?: readonly string[];
  supported?: readonly string[];
  createSession?: SessionFactory;
}): Promise<CreatedOnnxSession> {
  if (options.artifact.path === undefined && options.artifact.bytes === undefined) {
    throw new Error("ONNX 制品缺失：需要 artifactPath 或 modelBytes 之一");
  }
  const supported = options.supported ?? bundledExecutionProviders();
  const factory = options.createSession ?? defaultCreateSession;
  const plan = resolveExecutionProviders(options.preferredProviders ?? ["cpu"], supported);
  try {
    const session = await factory(options.artifact, plan.providers);
    return {
      session,
      executionProvider: plan.providers[0] ?? "cpu",
      ...(plan.unavailable.length > 0
        ? { fallbackReason: `捆绑不支持的执行提供器已跳过：${plan.unavailable.join(", ")}` }
        : {}),
    };
  } catch (error) {
    if (plan.providers.length === 1 && plan.providers[0] === "cpu") throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const session = await factory(options.artifact, ["cpu"]);
    return {
      session,
      executionProvider: "cpu",
      fallbackReason: `执行提供器 [${plan.providers.join(", ")}] 会话创建失败，已降级 CPU：${reason}`,
    };
  }
}

/** 与既有 battery ONNX 链逐参数一致的 CPU 会话创建;薄壳消费的唯一入口。 */
export async function createCpuOnnxSession(artifactPath: string): Promise<ProviderSession> {
  return defaultCreateSession({ path: artifactPath }, ["cpu"]);
}

async function defaultCreateSession(artifact: OnnxArtifact, providers: string[]): Promise<ProviderSession> {
  const options = { executionProviders: providers, graphOptimizationLevel: "all" as const };
  if (artifact.path !== undefined) return ort.InferenceSession.create(artifact.path, options) as unknown as ProviderSession;
  if (artifact.bytes !== undefined) return ort.InferenceSession.create(artifact.bytes, options) as unknown as ProviderSession;
  throw new Error("ONNX 制品缺失：需要 artifactPath 或 modelBytes 之一");
}
