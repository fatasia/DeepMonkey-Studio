/**
 * PLC Live 模式(OPC UA 实连):与 engine.ts 的确定性 Replay 并存,证据标记 non-deterministic。
 * 依赖决策(2026-09-26):node-opcua-client 是 optional peerDependency——本包不携带硬依赖,
 * 宿主(apps/api)安装后经动态 import 启用;缺失时显式报"OPC UA 支持未安装",不 crash。
 * 测试纪律:单元测试一律走内存 fake transport,不依赖真实 PLC,也不依赖 node-opcua-client。
 */
import type {
  OpcUaLiveBinding,
  OpcUaLiveEndpoint,
  OpcUaLiveEvidence,
  OpcUaLiveSample,
  OpcUaLiveSessionState,
  VirtualDebugSignalValue,
} from "@bim-studio/contracts";
import {
  assertOpcUaLiveBindings,
  assertOpcUaLiveEndpoint,
  normalizeOpcUaLiveValue,
  resolveOpcUaNodeId,
} from "@bim-studio/contracts";

/** 订阅采样间隔(ms):满足联锁观测即可,过低会放大现场负载。 */
export const OPC_UA_SAMPLING_INTERVAL_MS = 250;
/** 订阅发布间隔(ms):与采样间隔同量级,通知合并交给 OPC UA 栈。 */
export const OPC_UA_PUBLISHING_INTERVAL_MS = 250;
/** 每个 monitored item 的队列长度;丢弃最旧值,保最新语义。 */
export const OPC_UA_MONITORED_QUEUE_SIZE = 10;
/** 单会话采样留存上限,超出后停止留存并告警,避免长会话内存无界。 */
export const OPC_UA_MAX_RETAINED_SAMPLES = 50_000;
/** 可选依赖缺失时的显式错误文案(契约:不 crash,由会话状态机承接)。 */
export const OPC_UA_SUPPORT_NOT_INSTALLED =
  "OPC UA 支持未安装:请在宿主应用安装可选依赖 node-opcua-client(2.178.0,MPL-2.0)后再连接真实 PLC。";

export interface OpcUaLiveResolvedBinding {
  signal: string;
  nodeId: string;
}

/** transport 事件:sample 进入采样流;unsupported-value 进入告警流,不许静默丢弃。 */
export type OpcUaLiveTransportEvent =
  | { kind: "sample"; signal: string; nodeId: string; value: VirtualDebugSignalValue; timestamp: string }
  | { kind: "unsupported-value"; signal: string; nodeId: string; received: string };

export interface OpcUaLiveTransport {
  readonly kind: string;
  connect(endpoint: OpcUaLiveEndpoint): Promise<void>;
  subscribe(bindings: readonly OpcUaLiveResolvedBinding[], emit: (event: OpcUaLiveTransportEvent) => void): Promise<void>;
  write(nodeId: string, value: VirtualDebugSignalValue): Promise<void>;
  disconnect(): Promise<void>;
}

export interface OpcUaLiveHooks {
  /** 注入 transport(默认尝试 node-opcua-client);测试一律注入 fake。 */
  transport?: OpcUaLiveTransport;
  /** 高级:替换动态 import 的可选依赖模块说明符;默认 "node-opcua-client",供测试与替代构建使用。 */
  transportModuleSpecifier?: string;
  onSessionState?(state: OpcUaLiveSessionState): void;
  onSample?(sample: OpcUaLiveSample): void;
  /** 测试与审计需要确定性时间戳时注入;默认真实时钟(Live 语义本就不可复现)。 */
  now?: () => Date;
}

export interface OpcUaLiveSession {
  readonly endpointUrl: string;
  readonly transportKind: string;
  state(): OpcUaLiveSessionState;
  /** VirtualDebugScenario 可直接消费的信号快照(等价 initialSignals 形态)。 */
  snapshot(): Record<string, VirtualDebugSignalValue>;
  samples(): readonly OpcUaLiveSample[];
  warnings(): readonly string[];
  sampleCount(): number;
  /** set 命令下发:按绑定把信号键映射回 NodeId 写入 PLC。 */
  writeSignal(signal: string, value: VirtualDebugSignalValue): Promise<void>;
  evidence(): OpcUaLiveEvidence | null;
  /** 幂等;断开后返回完整 Live 证据(连接失败也会产出 sampleCount=0 的证据)。 */
  close(): Promise<OpcUaLiveEvidence>;
}

/** 连接 OPC UA 端点并订阅绑定信号;transport 层失败(含依赖缺失)转化为 error 状态,不向调用方抛出。 */
export async function connectOpcUaLive(
  endpoint: OpcUaLiveEndpoint,
  bindings: readonly OpcUaLiveBinding[],
  hooks: OpcUaLiveHooks = {},
): Promise<OpcUaLiveSession> {
  assertOpcUaLiveEndpoint(endpoint);
  assertOpcUaLiveBindings(bindings);
  const now = hooks.now ?? (() => new Date());
  const resolved: OpcUaLiveResolvedBinding[] = bindings.map((binding) => ({
    signal: binding.signal,
    nodeId: resolveOpcUaNodeId(binding.nodeId, endpoint.namespace),
  }));
  const nodeBySignal = new Map(resolved.map((item) => [item.signal, item.nodeId]));

  const snapshot: Record<string, VirtualDebugSignalValue> = {};
  const samples: OpcUaLiveSample[] = [];
  const warnings: string[] = [];
  const seenWarnings = new Set<string>();
  let retainedSamplesExhausted = false;
  let sessionState: OpcUaLiveSessionState = { status: "disconnected" };
  let transport: OpcUaLiveTransport | undefined;
  let closed = false;
  const startedAt = now();

  const setState = (next: OpcUaLiveSessionState): void => {
    sessionState = next;
    hooks.onSessionState?.(next);
  };
  const warn = (key: string, message: string): void => {
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    warnings.push(message);
  };
  const onEvent = (event: OpcUaLiveTransportEvent): void => {
    if (closed) return;
    if (event.kind === "unsupported-value") {
      warn(`value:${event.nodeId}`, `信号 ${event.signal}(${event.nodeId})收到不支持的 OPC UA 值类型(${event.received}),已跳过采样`);
      return;
    }
    const sample: OpcUaLiveSample = { signal: event.signal, nodeId: event.nodeId, value: event.value, timestamp: event.timestamp };
    snapshot[event.signal] = event.value;
    if (samples.length < OPC_UA_MAX_RETAINED_SAMPLES) {
      samples.push(sample);
    } else if (!retainedSamplesExhausted) {
      retainedSamplesExhausted = true;
      warnings.push(`采样留存达到上限 ${OPC_UA_MAX_RETAINED_SAMPLES} 条,后续采样仅更新快照不再留存`);
    }
    hooks.onSample?.(sample);
  };

  setState({ status: "connecting" });
  try {
    transport = hooks.transport
      ?? (await createNodeOpcUaLiveTransport(hooks.transportModuleSpecifier ? { moduleSpecifier: hooks.transportModuleSpecifier } : {}));
    await transport.connect(endpoint);
    await transport.subscribe(resolved, onEvent);
    setState({ status: "connected", connectedAt: now().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState({ status: "error", message });
    warn("connect", `Live 会话连接失败:${message}`);
  }

  let closedEvidence: OpcUaLiveEvidence | null = null;
  const buildEvidence = (endedAt: Date): OpcUaLiveEvidence => ({
    mode: "live",
    endpoint: endpoint.endpointUrl,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    sampleCount: samples.length,
    nonDeterministic: true,
  });

  return {
    endpointUrl: endpoint.endpointUrl,
    transportKind: transport?.kind ?? "node-opcua",
    state: () => ({ ...sessionState }),
    snapshot: () => ({ ...snapshot }),
    samples: () => [...samples],
    warnings: () => [...warnings],
    sampleCount: () => samples.length,
    async writeSignal(signal, value) {
      if (closed) throw new Error("Live 会话已关闭,不能下发写命令");
      if (sessionState.status !== "connected") throw new Error(`Live 会话未连接(当前 ${sessionState.status}),不能下发写命令`);
      const nodeId = nodeBySignal.get(signal);
      if (!nodeId) throw new Error(`信号 ${signal} 未绑定 OPC UA NodeId,拒绝下发`);
      await transport!.write(nodeId, value);
    },
    evidence: () => closedEvidence,
    async close() {
      if (closedEvidence) return closedEvidence;
      closed = true;
      if (transport) {
        try {
          await transport.disconnect();
        } catch (error) {
          warn("disconnect", `transport 断开失败:${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (sessionState.status === "connected" || sessionState.status === "connecting") {
        setState({ status: "disconnected" });
      }
      closedEvidence = buildEvidence(now());
      return closedEvidence;
    },
  };
}

export interface OpcUaLiveWindowResult {
  evidence: OpcUaLiveEvidence;
  state: OpcUaLiveSessionState;
  snapshot: Record<string, VirtualDebugSignalValue>;
  samples: readonly OpcUaLiveSample[];
  warnings: readonly string[];
}

/** 有界采样窗口:连接 → 采样 durationMs → 关闭,返回 Live 证据与信号快照;供 API 层与集成测试封装。 */
export async function sampleOpcUaLiveWindow(options: {
  endpoint: OpcUaLiveEndpoint;
  bindings: readonly OpcUaLiveBinding[];
  durationMs: number;
  transport?: OpcUaLiveTransport;
  now?: () => Date;
  onSample?(sample: OpcUaLiveSample): void;
  onSessionState?(state: OpcUaLiveSessionState): void;
}): Promise<OpcUaLiveWindowResult> {
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs <= 0) throw new Error("durationMs 必须是正整数");
  const session = await connectOpcUaLive(options.endpoint, options.bindings, {
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onSample ? { onSample: options.onSample } : {}),
    ...(options.onSessionState ? { onSessionState: options.onSessionState } : {}),
  });
  await new Promise<void>((resolve) => setTimeout(resolve, options.durationMs));
  const evidence = await session.close();
  return { evidence, state: session.state(), snapshot: session.snapshot(), samples: session.samples(), warnings: session.warnings() };
}

// ---------------------------------------------------------------------------
// 内存 fake transport:测试与演示的唯一依赖,不需要真实 PLC 或 node-opcua-client。
// ---------------------------------------------------------------------------

export interface InMemoryOpcUaTransportOptions {
  /** 写入后立即把新值回推为采样,模拟 PLC 对写命令的确认回读;默认 true。 */
  autoEchoWrites?: boolean;
  /** connect() 直接失败,模拟端点不可达。 */
  failOnConnect?: string;
  /** write() 直接失败,模拟 PLC 拒绝写入。 */
  failOnWrite?: string;
  now?: () => Date;
}

export interface InMemoryOpcUaTransport extends OpcUaLiveTransport {
  /** 按信号键或完整 NodeId 推送现场值;未订阅或键不存在时显式抛错,防止测试误接线。 */
  publish(signalOrNodeId: string, value: VirtualDebugSignalValue): void;
  writes(): readonly { nodeId: string; value: VirtualDebugSignalValue; at: string }[];
  connectCalls(): number;
  disconnectCalls(): number;
}

export function createInMemoryOpcUaTransport(options: InMemoryOpcUaTransportOptions = {}): InMemoryOpcUaTransport {
  const now = options.now ?? (() => new Date());
  let emit: ((event: OpcUaLiveTransportEvent) => void) | undefined;
  let signalToNode = new Map<string, string>();
  let nodeToSignal = new Map<string, string>();
  let connected = 0;
  let disconnected = 0;
  const writes: { nodeId: string; value: VirtualDebugSignalValue; at: string }[] = [];

  const pushSample = (signal: string, nodeId: string, value: VirtualDebugSignalValue): void => {
    emit?.({ kind: "sample", signal, nodeId, value, timestamp: now().toISOString() });
  };

  return {
    kind: "in-memory",
    async connect(endpoint) {
      connected += 1;
      if (options.failOnConnect) throw new Error(options.failOnConnect);
      if (!/^opc\.tcp:\/\//i.test(endpoint.endpointUrl)) throw new Error(`endpointUrl 非法:${endpoint.endpointUrl}`);
    },
    async subscribe(bindings, next) {
      signalToNode = new Map(bindings.map((item) => [item.signal, item.nodeId]));
      nodeToSignal = new Map(bindings.map((item) => [item.nodeId, item.signal]));
      emit = next;
    },
    async write(nodeId, value) {
      if (options.failOnWrite) throw new Error(options.failOnWrite);
      writes.push({ nodeId, value, at: now().toISOString() });
      if (options.autoEchoWrites !== false) {
        const signal = nodeToSignal.get(nodeId);
        if (signal) pushSample(signal, nodeId, value);
      }
    },
    async disconnect() {
      disconnected += 1;
      emit = undefined;
    },
    publish(signalOrNodeId, value) {
      const bySignal = signalToNode.get(signalOrNodeId);
      if (bySignal) {
        pushSample(signalOrNodeId, bySignal, value);
        return;
      }
      const reverseSignal = nodeToSignal.get(signalOrNodeId);
      if (!reverseSignal) throw new Error(`fake transport 未订阅信号或 NodeId:${signalOrNodeId}`);
      pushSample(reverseSignal, signalOrNodeId, value);
    },
    writes: () => [...writes],
    connectCalls: () => connected,
    disconnectCalls: () => disconnected,
  };
}

// ---------------------------------------------------------------------------
// node-opcua 适配器:optional peerDependency,经变量化模块说明符动态 import,
// 编译期零依赖(最小结构接口),运行期缺失时抛出显式安装指引。
// ---------------------------------------------------------------------------

interface NodeOpcUaMonitoredItemLike {
  on(event: string, handler: (dataValue: unknown) => void): unknown;
}
interface NodeOpcUaSubscriptionLike {
  monitor(item: Record<string, unknown>, parameters: Record<string, unknown>, timestamps: unknown): Promise<NodeOpcUaMonitoredItemLike>;
}
interface NodeOpcUaSessionLike {
  write(nodesToWrite: unknown[]): Promise<unknown>;
  createSubscription(parameters: Record<string, unknown>): Promise<NodeOpcUaSubscriptionLike>;
  close(): Promise<unknown>;
}
interface NodeOpcUaClientLike {
  connect(endpointUrl: string): Promise<unknown>;
  createSession(identity?: Record<string, unknown>): Promise<NodeOpcUaSessionLike>;
  disconnect(): Promise<unknown>;
}

export interface NodeOpcUaTransportOptions {
  /** endpoint.identity.passwordRef → 明文密码的宿主解析器;提供 identity 但缺解析器时显式报错。 */
  resolvePassword?(passwordRef: string): string | Promise<string>;
  /** 高级:替换动态 import 的可选依赖模块说明符;默认 "node-opcua-client",供测试与替代构建使用。 */
  moduleSpecifier?: string;
}

const NODE_OPC_UA_REQUIRED_EXPORTS = [
  "OPCUAClient",
  "AttributeIds",
  "MessageSecurityMode",
  "SecurityPolicy",
  "UserTokenType",
  "TimestampsToReturn",
  "DataType",
  "Variant",
  "DataValue",
] as const;

/** 显式加载可选依赖;模块说明符经参数注入(默认官方包),避免把 optional peer 变成编译期硬依赖。 */
async function loadNodeOpcUaClientModule(specifier: string): Promise<Record<string, any>> {
  let module: unknown;
  try {
    module = await import(specifier);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${OPC_UA_SUPPORT_NOT_INSTALLED} 原因:${reason}`);
  }
  const exports = module as Record<string, unknown> | null;
  const missing = NODE_OPC_UA_REQUIRED_EXPORTS.filter((name) => !exports || exports[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`${OPC_UA_SUPPORT_NOT_INSTALLED} 原因:模块缺少导出 ${missing.join(", ")}`);
  }
  return exports as Record<string, any>;
}

export async function createNodeOpcUaLiveTransport(options: NodeOpcUaTransportOptions = {}): Promise<OpcUaLiveTransport> {
  const opcua = await loadNodeOpcUaClientModule(options.moduleSpecifier ?? "node-opcua-client");
  const { AttributeIds, MessageSecurityMode, SecurityPolicy, UserTokenType, TimestampsToReturn, DataType, Variant, DataValue } = opcua;  let client: NodeOpcUaClientLike | undefined;
  let session: NodeOpcUaSessionLike | undefined;

  return {
    kind: "node-opcua",
    async connect(endpoint) {
      const created: NodeOpcUaClientLike = opcua.OPCUAClient.create({
        endpointMustExist: false,
        applicationName: "Deep Monkey Studio Virtual Commissioning",
        connectionStrategy: { initialDelay: 250, maxDelay: 1_000, maxRetry: 1 },
        securityMode: MessageSecurityMode[endpoint.securityMode],
        // None=纯内网直连;Sign/SignAndEncrypt 需要 256Sha256 及应用证书(证书供给由宿主负责,本期未接管理界面)。
        securityPolicy: endpoint.securityMode === "None" ? SecurityPolicy.None : SecurityPolicy.Basic256Sha256,
      });
      client = created;
      await created.connect(endpoint.endpointUrl);
      const identity = await sessionIdentity(endpoint, options, UserTokenType);
      session = await created.createSession(identity);
    },
    async subscribe(bindings, emit) {
      if (!session) throw new Error("node-opcua transport 未连接,不能订阅");
      const subscription = await session.createSubscription({
        requestedPublishingInterval: OPC_UA_PUBLISHING_INTERVAL_MS,
        requestedLifetimeCount: 600,
        requestedMaxKeepAliveCount: 10,
        maxNotificationsPerPublish: 1_000,
        publishingEnabled: true,
        priority: 0,
      });
      await Promise.all(
        bindings.map(async (binding) => {
          const item = await subscription.monitor(
            { nodeId: binding.nodeId, attributeId: AttributeIds.Value },
            { samplingInterval: OPC_UA_SAMPLING_INTERVAL_MS, discardOldest: true, queueSize: OPC_UA_MONITORED_QUEUE_SIZE },
            TimestampsToReturn.Both,
          );
          item.on("changed", (dataValue) => {
            try {
              const value = normalizeOpcUaLiveValue(extractVariantValue(dataValue));
              if (value === undefined) {
                emit({ kind: "unsupported-value", signal: binding.signal, nodeId: binding.nodeId, received: describeReceived(dataValue) });
                return;
              }
              emit({
                kind: "sample",
                signal: binding.signal,
                nodeId: binding.nodeId,
                value,
                timestamp: extractSourceTimestamp(dataValue),
              });
            } catch (error) {
              emit({ kind: "unsupported-value", signal: binding.signal, nodeId: binding.nodeId, received: error instanceof Error ? error.message : String(error) });
            }
          });
        }),
      );
    },
    async write(nodeId, value) {
      if (!session) throw new Error("node-opcua transport 未连接,不能写入");
      const dataType =
        typeof value === "boolean" ? DataType.Boolean :
        typeof value === "number" ? DataType.Double :
        DataType.String;
      const result = await session.write([
        { nodeId, attributeId: AttributeIds.Value, value: new DataValue({ value: new Variant({ dataType, value }) }) },
      ]);
      const outcome = Array.isArray(result) ? result[0] : result;
      const statusName =
        typeof outcome === "object" && outcome !== null && "name" in (outcome as Record<string, unknown>)
          ? String((outcome as Record<string, unknown>).name)
          : String(outcome);
      if (!/^good$/i.test(statusName)) throw new Error(`OPC UA 写入被拒绝(状态 ${statusName}):${nodeId}`);
    },
    async disconnect() {
      try {
        await session?.close();
      } finally {
        session = undefined;
        await client?.disconnect();
        client = undefined;
      }
    },
  };
}

async function sessionIdentity(
  endpoint: OpcUaLiveEndpoint,
  options: NodeOpcUaTransportOptions,
  userTokenType: unknown,
): Promise<Record<string, unknown> | undefined> {
  if (!endpoint.identity) return undefined;
  if (!options.resolvePassword) {
    throw new Error(`端点 identity.passwordRef=${endpoint.identity.passwordRef} 需要宿主提供 resolvePassword 才能解析凭据(合同不承载明文密码)`);
  }
  return {
    type: userTokenType,
    userName: endpoint.identity.user,
    password: await options.resolvePassword(endpoint.identity.passwordRef),
  };
}

function extractVariantValue(dataValue: unknown): unknown {
  return (dataValue as { value?: { value?: unknown } } | null | undefined)?.value?.value;
}

function extractSourceTimestamp(dataValue: unknown): string {
  const sourceTimestamp = (dataValue as { sourceTimestamp?: unknown } | null | undefined)?.sourceTimestamp;
  return sourceTimestamp instanceof Date ? sourceTimestamp.toISOString() : new Date().toISOString();
}

function describeReceived(dataValue: unknown): string {
  const variant = (dataValue as { value?: { value?: unknown; dataType?: unknown } } | null | undefined)?.value;
  return typeof variant?.dataType === "string" || typeof variant?.dataType === "number" ? String(variant.dataType) : typeof variant?.value;
}
