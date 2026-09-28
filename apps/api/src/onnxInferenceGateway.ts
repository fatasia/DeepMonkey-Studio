/**
 * T32 引擎侧 ONNX 推理网关:把 battery 域反复手写的会话生命周期、契约校验、
 * 超时与取消泛化为跨域可复用入口。设计取舍:
 * - 预处理/后处理留在各域(它们才是域语义),网关只管"注册→加载→校验→执行→校验"。
 * - fail-closed:加载失败、会话契约不符、输入/输出契约不符一律报错,绝不静默放行。
 * - 超时/取消拒绝 Promise 并释放调用方;onnxruntime-node 无法真正中断在途原生推理,
 *   超时后被放弃的那次 run 不影响后续推理(会话可复用),与 battery 既有语义一致。
 * - 确定性承诺仅限 CPU EP:同构建同输入逐位一致;GPU EP 允许低阶位差异,不承诺逐位。
 */
import { Tensor } from "onnxruntime-node";
import {
  createOnnxSession,
  type CreatedOnnxSession,
  type OnnxArtifact,
  type ProviderSession,
  type ProviderSessionOutput,
  type SessionFactory,
} from "./onnxSessionProviders.js";

export type OnnxTensorElementType = "float32" | "float64" | "int32" | "int64" | "bool";

export type OnnxDimSpec = number | "dynamic";

export interface OnnxPortContract {
  name: string;
  elementType: OnnxTensorElementType;
  dims: readonly OnnxDimSpec[];
}

export interface OnnxModelContract {
  inputs: readonly OnnxPortContract[];
  outputs: readonly OnnxPortContract[];
}

export interface RegisteredOnnxModel {
  modelId: string;
  version: string;
  contract: OnnxModelContract;
  artifactPath?: string;
  modelBytes?: Uint8Array;
  /** 该模型默认推理超时;单次请求可用 request.timeoutMs 覆盖。 */
  timeoutMs: number;
}

export type OnnxGatewayTensorData = Float32Array | Float64Array | Int32Array | BigInt64Array | Uint8Array;

export interface OnnxGatewayTensor {
  data: OnnxGatewayTensorData;
  dims: number[];
}

export interface OnnxInferenceRequest {
  modelId: string;
  inputs: Record<string, OnnxGatewayTensor>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OnnxInferenceResult {
  modelId: string;
  version: string;
  outputs: Record<string, OnnxGatewayTensor>;
  executionProvider: string;
  fallbackReason?: string;
  elapsedMs: number;
}

export interface OnnxGatewayModelInfo {
  modelId: string;
  version: string;
  executionProvider: string;
  fallbackReason?: string;
  sessionLoaded: boolean;
}

export class OnnxInferenceTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`ONNX 推理超时（${timeoutMs}ms），在途原生执行已被放弃`);
    this.name = "OnnxInferenceTimeoutError";
  }
}

export interface OnnxInferenceGatewayOptions {
  preferredProviders?: readonly string[];
  supportedProviders?: readonly string[];
  createSession?: SessionFactory;
}

const ELEMENT_ARRAYS: Record<OnnxTensorElementType, new (length: number) => OnnxGatewayTensorData> = {
  float32: Float32Array,
  float64: Float64Array,
  int32: Int32Array,
  int64: BigInt64Array,
  bool: Uint8Array,
};

interface ModelEntry {
  descriptor: RegisteredOnnxModel;
  session?: Promise<CreatedOnnxSession>;
  executionProvider?: string;
  fallbackReason?: string;
}

export class OnnxInferenceGateway {
  private readonly entries = new Map<string, ModelEntry>();
  private disposed = false;

  constructor(private readonly options: OnnxInferenceGatewayOptions = {}) {}

  register(descriptor: RegisteredOnnxModel): void {
    this.assertNotDisposed();
    validateDescriptor(descriptor);
    if (this.entries.has(descriptor.modelId)) {
      throw new Error(`ONNX 模型重复注册：${descriptor.modelId}`);
    }
    this.entries.set(descriptor.modelId, { descriptor });
  }

  has(modelId: string): boolean {
    return this.entries.has(modelId);
  }

  list(): OnnxGatewayModelInfo[] {
    return [...this.entries.values()].map((entry) => ({
      modelId: entry.descriptor.modelId,
      version: entry.descriptor.version,
      executionProvider: entry.executionProvider ?? "未加载",
      ...(entry.fallbackReason !== undefined ? { fallbackReason: entry.fallbackReason } : {}),
      sessionLoaded: entry.session !== undefined,
    }));
  }

  async infer(request: OnnxInferenceRequest): Promise<OnnxInferenceResult> {
    this.assertNotDisposed();
    const entry = this.entries.get(request.modelId);
    if (!entry) {
      throw new Error(`未注册的 ONNX 模型 "${request.modelId}"，已注册：${[...this.entries.keys()].join(", ") || "（无）"}`);
    }
    const timeoutMs = request.timeoutMs ?? entry.descriptor.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`ONNX 推理超时必须为有限正数，收到 ${timeoutMs}`);
    assertNotAborted(request.signal);
    const created = await this.sessionFor(entry, timeoutMs, request.signal);
    assertSessionContract(created.session, entry.descriptor.contract, request.modelId);
    assertNotAborted(request.signal);
    const feeds = buildFeeds(entry.descriptor.contract, request.inputs, request.modelId);

    const startedAt = performance.now();
    const rawOutputs = await runGuarded(
      () => created.session.run(feeds),
      timeoutMs,
      request.signal,
    );
    assertNotAborted(request.signal);
    const outputs = validateOutputs(entry.descriptor.contract, rawOutputs, request.modelId);
    return {
      modelId: request.modelId,
      version: entry.descriptor.version,
      outputs,
      executionProvider: created.executionProvider,
      ...(created.fallbackReason !== undefined ? { fallbackReason: created.fallbackReason } : {}),
      elapsedMs: performance.now() - startedAt,
    };
  }

  /** 释放全部会话;之后任何 infer/register 都会拒绝。未加载的模型跳过。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const sessions = [...this.entries.values()]
      .map((entry) => entry.session)
      .filter((session): session is Promise<CreatedOnnxSession> => session !== undefined);
    await Promise.allSettled(sessions).then((settled) => {
      for (const item of settled) {
        if (item.status === "fulfilled") item.value.session.release?.();
      }
    });
    this.entries.clear();
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("ONNX 推理网关已释放，不能再执行推理");
  }

  /** 会话按模型懒加载并缓存;失败清除缓存以便重试(与 battery 既有模式一致)。 */
  private sessionFor(entry: ModelEntry, timeoutMs: number, signal?: AbortSignal): Promise<CreatedOnnxSession> {
    entry.session ??= runGuarded(
      () => createOnnxSession({
        artifact: artifactOf(entry.descriptor),
        ...(this.options.preferredProviders !== undefined ? { preferredProviders: this.options.preferredProviders } : {}),
        ...(this.options.supportedProviders !== undefined ? { supported: this.options.supportedProviders } : {}),
        ...(this.options.createSession !== undefined ? { createSession: this.options.createSession } : {}),
      }),
      timeoutMs,
      signal,
    ).catch((error: unknown) => {
      delete entry.session;
      throw error;
    }).then((created: CreatedOnnxSession) => {
      entry.executionProvider = created.executionProvider;
      if (created.fallbackReason !== undefined) entry.fallbackReason = created.fallbackReason;
      return created;
    });
    return entry.session;
  }
}

function artifactOf(descriptor: RegisteredOnnxModel): OnnxArtifact {
  if (descriptor.artifactPath !== undefined && descriptor.modelBytes !== undefined) {
    throw new Error(`ONNX 模型 ${descriptor.modelId} 同时配置了路径与内存制品，来源歧义`);
  }
  if (descriptor.artifactPath !== undefined) return { path: descriptor.artifactPath };
  if (descriptor.modelBytes !== undefined) return { bytes: descriptor.modelBytes };
  throw new Error(`ONNX 模型 ${descriptor.modelId} 缺少制品：需要 artifactPath 或 modelBytes 之一`);
}

function validateDescriptor(descriptor: RegisteredOnnxModel): void {
  if (typeof descriptor.modelId !== "string" || descriptor.modelId.trim().length === 0) {
    throw new Error("ONNX 模型 modelId 不能为空");
  }
  if (typeof descriptor.version !== "string" || descriptor.version.trim().length === 0) {
    throw new Error(`ONNX 模型 ${descriptor.modelId} 缺少版本`);
  }
  if (!Number.isFinite(descriptor.timeoutMs) || descriptor.timeoutMs <= 0) {
    throw new Error(`ONNX 模型 ${descriptor.modelId} 超时必须为有限正数`);
  }
  // 制品来源在注册期就 fail-closed:歧义或缺制品的描述符不可能被加载,不接受。
  const hasPath = descriptor.artifactPath !== undefined;
  const hasBytes = descriptor.modelBytes !== undefined;
  if (hasPath && hasBytes) {
    throw new Error(`ONNX 模型 ${descriptor.modelId} 同时配置了路径与内存制品，来源歧义`);
  }
  if (!hasPath && !hasBytes) {
    throw new Error(`ONNX 模型 ${descriptor.modelId} 缺少制品：需要 artifactPath 或 modelBytes 之一`);
  }
  validatePorts(descriptor.contract.inputs, `输入`, descriptor.modelId);
  validatePorts(descriptor.contract.outputs, `输出`, descriptor.modelId);
}

function validatePorts(ports: readonly OnnxPortContract[], label: string, modelId: string): void {
  if (!Array.isArray(ports) || ports.length === 0) throw new Error(`ONNX 模型 ${modelId} 的${label}契约不能为空`);
  const names = new Set<string>();
  for (const port of ports) {
    if (typeof port.name !== "string" || port.name.trim().length === 0) throw new Error(`ONNX 模型 ${modelId} 的${label}端口名不能为空`);
    if (names.has(port.name)) throw new Error(`ONNX 模型 ${modelId} 的${label}端口名重复：${port.name}`);
    names.add(port.name);
    if (!(port.elementType in ELEMENT_ARRAYS)) throw new Error(`ONNX 模型 ${modelId} 的${label} ${port.name} 元素类型无效：${String(port.elementType)}`);
    if (!Array.isArray(port.dims) || port.dims.length === 0) throw new Error(`ONNX 模型 ${modelId} 的${label} ${port.name} 维度不能为空`);
    for (const dim of port.dims) {
      if (dim === "dynamic") continue;
      if (!Number.isSafeInteger(dim) || (dim as number) <= 0) {
        throw new Error(`ONNX 模型 ${modelId} 的${label} ${port.name} 维度无效：${String(dim)}（正整数或 "dynamic"）`);
      }
    }
  }
}

function assertSessionContract(session: ProviderSession, contract: OnnxModelContract, modelId: string): void {
  const missingInputs = contract.inputs.filter((port) => !session.inputNames.includes(port.name));
  const missingOutputs = contract.outputs.filter((port) => !session.outputNames.includes(port.name));
  if (missingInputs.length > 0 || missingOutputs.length > 0) {
    throw new Error(
      `ONNX 会话与 ${modelId} 契约不符：缺输入 [${missingInputs.map((port) => port.name).join(", ")}]，`
      + `缺输出 [${missingOutputs.map((port) => port.name).join(", ")}]；`
      + `会话实际 输入 [${session.inputNames.join(", ")}] 输出 [${session.outputNames.join(", ")}]`,
    );
  }
}

function buildFeeds(contract: OnnxModelContract, inputs: Record<string, OnnxGatewayTensor>, modelId: string): Record<string, Tensor> {
  const supplied = new Set(Object.keys(inputs));
  const feeds: Record<string, Tensor> = {};
  for (const port of contract.inputs) {
    const tensor = inputs[port.name];
    if (!tensor) throw new Error(`${modelId} 缺少输入张量 "${port.name}"`);
    supplied.delete(port.name);
    validateTensorAgainstPort(port, tensor, modelId);
    feeds[port.name] = new Tensor(port.elementType, tensor.data, tensor.dims);
  }
  if (supplied.size > 0) {
    throw new Error(`${modelId} 提供了契约之外的输入：[${[...supplied].join(", ")}]`);
  }
  return feeds;
}

function validateTensorAgainstPort(port: OnnxPortContract, tensor: OnnxGatewayTensor, modelId: string): void {
  const expectedArray = ELEMENT_ARRAYS[port.elementType];
  if (!(tensor.data instanceof expectedArray)) {
    throw new Error(`${modelId} 输入 "${port.name}" 元素类型不符：契约 ${port.elementType}，收到 ${tensor.data.constructor.name}`);
  }
  if (!Array.isArray(tensor.dims) || tensor.dims.length === 0 || !tensor.dims.every((dim) => Number.isSafeInteger(dim) && dim > 0)) {
    throw new Error(`${modelId} 输入 "${port.name}" 维度无效`);
  }
  if (tensor.dims.length !== port.dims.length) {
    throw new Error(`${modelId} 输入 "${port.name}" 秩不符：契约 ${port.dims.length} 维，收到 ${tensor.dims.length} 维`);
  }
  for (let index = 0; index < port.dims.length; index += 1) {
    const spec = port.dims[index];
    const actual = tensor.dims[index];
    if (spec !== "dynamic" && spec !== actual) {
      throw new Error(`${modelId} 输入 "${port.name}" 第 ${index} 维不符：契约 ${spec}，收到 ${actual}`);
    }
  }
  const expectedLength = tensor.dims.reduce((product, dim) => product * dim, 1);
  if (tensor.data.length !== expectedLength) {
    throw new Error(`${modelId} 输入 "${port.name}" 数据长度不符：维度乘积 ${expectedLength}，收到 ${tensor.data.length}`);
  }
}

function validateOutputs(
  contract: OnnxModelContract,
  raw: Record<string, ProviderSessionOutput>,
  modelId: string,
): Record<string, OnnxGatewayTensor> {
  const outputs: Record<string, OnnxGatewayTensor> = {};
  for (const port of contract.outputs) {
    const tensor = raw[port.name];
    if (!tensor) throw new Error(`${modelId} ONNX 会话缺少契约输出 "${port.name}"`);
    if (tensor.type !== port.elementType) {
      throw new Error(`${modelId} 输出 "${port.name}" 元素类型不符：契约 ${port.elementType}，会话返回 ${tensor.type}`);
    }
    if (!Array.isArray(tensor.dims) || tensor.dims.length === 0) throw new Error(`${modelId} 输出 "${port.name}" 缺少维度信息`);
    if (tensor.dims.length !== port.dims.length) {
      throw new Error(`${modelId} 输出 "${port.name}" 秩不符：契约 ${port.dims.length} 维，收到 ${tensor.dims.length} 维`);
    }
    for (let index = 0; index < port.dims.length; index += 1) {
      const spec = port.dims[index];
      const actual = tensor.dims[index];
      if (spec !== "dynamic" && spec !== actual) {
        throw new Error(`${modelId} 输出 "${port.name}" 第 ${index} 维不符：契约 ${spec}，收到 ${actual}`);
      }
    }
    const data = tensor.data;
    if (data instanceof Float32Array || data instanceof Float64Array) {
      for (let index = 0; index < data.length; index += 1) {
        if (!Number.isFinite(data[index])) throw new Error(`${modelId} 输出 "${port.name}" 含非有限数值（索引 ${index}）`);
      }
    }
    outputs[port.name] = { data: data as OnnxGatewayTensorData, dims: [...tensor.dims] };
  }
  return outputs;
}

/**
 * 超时与取消的统一护栏:超时/取消立即拒绝并移除监听,不吞底层错误;
 * 底层原生 run 无法真正中断,被放弃的执行由调用方语义(放弃结果)收尾。
 */
function runGuarded<T>(operation: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    const timer = setTimeout(() => finish(() => reject(new OnnxInferenceTimeoutError(timeoutMs))), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    operation().then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("ONNX 推理已取消");
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

export type { OnnxArtifact };
