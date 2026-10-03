/**
 * T24 切片:OPC UA 持久订阅适配器——把 node-opcua-client 封装为 SubscriptionSource。
 *
 * 链路:endpoint 连接 → session → ClientSubscription → 每 NodeId 一个 MonitoredItem(Value 属性)
 * → DataChangeNotification("changed")→ SourceSample 事件流。
 * 安全(T24 接线):config.security 存在时默认 createClient 走 Sign + Basic256Sha256
 * (opcUaSecureTransport,客户端自签证书跨实例复用);缺省维持 None 匿名(零退化)。
 * 断线检测:client "connection_lost"、session "session_closed"、subscription "terminated"
 * 任一触发即上报 disconnected,由订阅运行时的既有退避重连 + 恢复对账接管;
 * 内部自动重连关闭(connectionStrategy.maxRetry=0),重连所有权归运行时,避免双权重连。
 *
 * 序列语义(诚实条款):
 * - OPC UA 无源侧显式序列号。本适配器以服务端时间戳(sourceTimestamp 优先——设备源时钟,
 *   serverTimestamp 兜底——服务器读时钟)为序:严格递增视为"新的源更新",据此维护
 *   单调计数器并映射为 SourceSample.sequence,交给会话按权威序列对账。
 * - 配置了 samplingIntervalMs(即声明"预期更新周期")时,时间戳跳变按 (Δt/周期)-1 估计
 *   丢失点数,序列跳号,由会话产出 sequenceKnown:true 的缺口报告(estimatedCount 是估计值,
 *   以 fromTime/toTime 为界);断线恢复后的首条样本同样按 resume 上下文(运行时注入的
 *   checkpoint 位置)做该估计。
 * - 时间戳缺失/不可解析、或同 sourceTimestamp 重发(源更新未变)时,样本不带 sequence:
 *   会话按"完整性未知"口径对账(断线恢复后 sequenceKnown:false 缺口报告 / 指纹去重),
 *   绝不伪造连续性。
 * - 已知限制(如实声明):多节点共享断线窗口,缺口按恢复后首条样本一次性报告,不做每节点
 *   重复报告;跨重连的同时间戳旧值重放(真实 server 罕见)依赖运行时指纹去重窗口。
 *
 * 每次重连由会话经 sourceFactory 重建全新实例;旧实例 dispose() 释放全部监听器与连接对象。
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { DataEvent, DataEventAction, DataEventTarget } from "@bim-studio/contracts";
// 类型引用在编译期擦除,不破坏本模块级零 node-opcua 运行时依赖(安全路径惰性 import)。
import type { OpcUaMessageSecurityMode } from "./opcUaSecureTransport.js";
import { normalizeOpcUaLiveValue, isFullOpcUaNodeId, resolveOpcUaNodeId } from "@bim-studio/contracts";
import type { SourceLifecycleEvent, SourceResumeContext, SourceSample, SubscriptionSource } from "./subscriptionRuntime.js";

// ---- node-opcua-client 最小接口形状(便于测试注入假客户端;默认实现用真实客户端) ----

export interface OpcUaDataValueLike {
  value?: { value?: unknown };
  sourceTimestamp?: Date | string | null;
  serverTimestamp?: Date | string | null;
  statusCode?: unknown;
}

export interface OpcUaMonitoredItemLike {
  on(event: "changed", listener: (dataValue: OpcUaDataValueLike) => void): unknown;
  off?(event: "changed", listener: (dataValue: OpcUaDataValueLike) => void): unknown;
}

export interface OpcUaSubscriptionLike {
  monitor(
    itemToMonitor: { nodeId: string; attributeId: number },
    parameters: { samplingInterval: number; discardOldest: boolean; queueSize: number },
    timestampsToReturn: number,
  ): Promise<OpcUaMonitoredItemLike>;
  on(event: "terminated", listener: () => void): unknown;
  off?(event: "terminated", listener: () => void): unknown;
  terminate?(): Promise<unknown>;
}

export interface OpcUaSessionLike {
  createSubscription(options: Record<string, unknown>): Promise<OpcUaSubscriptionLike>;
  on(event: "session_closed" | "keepalive_failure", listener: () => void): unknown;
  off?(event: "session_closed" | "keepalive_failure", listener: () => void): unknown;
  close(): Promise<unknown>;
}

export interface OpcUaClientLike {
  connect(endpointUrl: string): Promise<unknown>;
  createSession(options?: Record<string, unknown>): Promise<OpcUaSessionLike>;
  disconnect(): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  off?(event: string, listener: (...args: never[]) => void): unknown;
}

/**
 * 客户端工厂:同步注入(测试假客户端)与异步默认实现(安全路径需先生成/复用证书)都合法;
 * 调用侧统一 await,同步返回值 await 后原样透传(零行为变化)。
 */
export type OpcUaClientFactory = () => OpcUaClientLike | Promise<OpcUaClientLike>;

export interface OpcUaSubscriptionDeps {
  /** 默认用 node-opcua-client 的 OPCUAClient.create;测试注入可控假客户端。显式注入优先于 security 默认签名客户端。 */
  createClient?: OpcUaClientFactory;
}

/**
 * 安全配置(可选):存在即把默认 createClient 切到 Basic256Sha256 签名通道
 * (opcUaSecureTransport.createSignedOpcUaClient,客户端自签证书落盘于 rootDir 并跨实例复用);
 * messageSecurityMode 缺省 sign(既有行为);不存在时维持 None 匿名(既有行为,零退化)。
 * 注意:deps.createClient 显式注入优先于本默认。
 */
export interface OpcUaSecurityConfig {
  /** 客户端 PKI 存储根目录(证书/私钥落盘于此;同目录重连复用既有证书)。 */
  certificateManagerRootDir: string;
  /** 客户端证书 CN 与 applicationName;缺省 bim-studio-client。 */
  applicationName?: string;
  /** 消息安全模式;缺省 sign。"signAndEncrypt"=签名+加密通道。 */
  messageSecurityMode?: OpcUaMessageSecurityMode;
}

/**
 * 连接配置 → security 组装(单一事实源,2026-10-02 自 mqttIngestRoutes 上移,preview 与
 * 持久订阅两条链共用同一校验):连接配置是扁平原始值(Record<string, string|number|boolean>),
 * 无法直接嵌套 security 对象,在此统一组装。
 * 校验口径:配置了 certificateManagerRootDir 键即视为启用签名通道——空值/非文本是配置错误,
 * fail-closed 显式拒绝(静默降级回 None 匿名会掩盖用户的安全意图);未配置该键时返回
 * undefined,调用方 config 输出与透传前逐位相同(None 匿名路径零退化)。
 */
export function resolveOpcUaSecurity(config: Record<string, string | number | boolean>): OpcUaSecurityConfig | undefined {
  const rootDirRaw = config.certificateManagerRootDir;
  if (rootDirRaw === undefined) {
    if (config.securityMode !== undefined) {
      throw new Error("OPC UA 显式 securityMode 需要 certificateManagerRootDir，不能降级为 None 通道");
    }
    return undefined;
  }
  if (typeof rootDirRaw !== "string" || rootDirRaw.trim() === "") {
    throw new Error("OPC UA 签名通道需要非空的 certificateManagerRootDir(客户端证书 PKI 根目录)");
  }
  const applicationNameRaw = config.applicationName;
  if (applicationNameRaw !== undefined && (typeof applicationNameRaw !== "string" || applicationNameRaw.trim() === "")) {
    throw new Error("OPC UA 签名通道 applicationName 必须是非空文本");
  }
  const securityModeRaw = config.securityMode;
  let messageSecurityMode: OpcUaMessageSecurityMode | undefined;
  if (securityModeRaw !== undefined) {
    if (typeof securityModeRaw !== "string") {
      throw new Error("OPC UA 安全通道 securityMode 必须是文本:sign | signAndEncrypt");
    }
    const normalized = securityModeRaw.trim().toLowerCase();
    if (normalized !== "sign" && normalized !== "signandencrypt") {
      throw new Error(`OPC UA 安全通道 securityMode 不支持 "${securityModeRaw}":仅 sign | signAndEncrypt(fail-closed,拒绝静默降级)`);
    }
    messageSecurityMode = normalized === "sign" ? "sign" : "signAndEncrypt";
  }
  return {
    // 路径规整:去首尾空白 + 统一分隔符/折叠冗余段;不绝对化,相对路径语义保持宿主进程。
    certificateManagerRootDir: path.normalize(rootDirRaw.trim()),
    ...(applicationNameRaw !== undefined ? { applicationName: applicationNameRaw.trim() } : {}),
    ...(messageSecurityMode !== undefined ? { messageSecurityMode } : {}),
  };
}

/** AttributeIds.Value;数字字面量避免为类型注入引入整包常量依赖。 */
const ATTRIBUTE_VALUE = 13;
/** TimestampsToReturn.Both:同时取 sourceTimestamp/serverTimestamp。 */
const TIMESTAMPS_BOTH = 2;

export interface OpcUaSubscriptionSourceConfig {
  endpointUrl: string;
  /** 完整 NodeId 列表;相对 id 需同时提供 namespace(复用 contracts 的 resolveOpcUaNodeId 展开)。 */
  nodeIds: string[];
  /** 绑定 nodeId 未携带 ns= 前缀时的默认命名空间索引;缺省且出现相对 id 时 fail-closed。 */
  namespace?: number;
  user?: string;
  /** 明文密码仅进程内传递,连接配置侧按 passwordEnv 解析(与 MQTT 同口径)。 */
  password?: string;
  /** MonitoredItem 采样间隔;同时作为缺口估计的"预期更新周期"声明。 */
  samplingIntervalMs?: number;
  /** 订阅 publishing 周期;缺省 500ms。 */
  publishingIntervalMs?: number;
  /** MonitoredItem 队列深度;缺省 10。 */
  queueSize?: number;
  /** 安全配置;存在即默认 Sign + Basic256Sha256 签名通道,缺省 None 匿名(零退化)。 */
  security?: OpcUaSecurityConfig;
  /** 运行时(重)连时注入的恢复位置;用于断线区间的缺口估计。 */
  resume?: SourceResumeContext;
  deps?: OpcUaSubscriptionDeps;
}

/** 事件投影字段(DataEvent 派生);会话侧由 supervisor 提供。 */
export interface OpcUaEventProjection {
  source?: string;
  key?: string;
  sceneId?: string;
  target?: DataEventTarget;
  action?: DataEventAction;
}

export interface OpcUaIngestConfig extends OpcUaEventProjection {
  connectionId: string;
  projectId: string;
  endpointUrl: string;
  nodeIds: string[];
  namespace?: number;
  user?: string;
  password?: string;
  samplingIntervalMs?: number;
  publishingIntervalMs?: number;
  queueSize?: number;
  /** 安全配置透传(T24 路由层):存在即签名通道;由路由层从连接配置组装并校验。 */
  security?: OpcUaSecurityConfig;
  now?: () => number;
}

export function assertOpcUaSubscriptionConfig(config: OpcUaSubscriptionSourceConfig): void {
  if (!/^opc\.tcp:\/\//i.test(config.endpointUrl.trim())) {
    throw new Error(`OPC UA endpointUrl 必须以 opc.tcp:// 开头(收到 ${config.endpointUrl})`);
  }
  if (!Array.isArray(config.nodeIds) || config.nodeIds.length < 1) {
    throw new Error("OPC UA 持久订阅需要至少一个 NodeId");
  }
  if (config.namespace !== undefined && (!Number.isSafeInteger(config.namespace) || config.namespace < 0)) {
    throw new Error(`OPC UA namespace 必须是非负整数(收到 ${config.namespace})`);
  }
  for (const nodeId of config.nodeIds) {
    if (!nodeId.trim()) throw new Error("OPC UA NodeId 不能为空");
    // fail-closed:相对 id 未提供 namespace 时显式拒绝,绝不静默展开成 ns=NaN。
    if (!isFullOpcUaNodeId(nodeId.trim()) && config.namespace === undefined) {
      throw new Error(`OPC UA NodeId ${nodeId.trim()} 是相对 id,必须提供 namespace 才能展开`);
    }
    resolveOpcUaNodeId(nodeId.trim(), config.namespace ?? 0);
  }
}

/** SourceSample → DataEvent 投影:id 派生与 MQTT 投影同一合同。 */
export function projectOpcUaSample(
  config: Pick<OpcUaIngestConfig, "connectionId" | "projectId" | "source" | "key" | "sceneId" | "target" | "action">,
  sample: SourceSample,
): DataEvent {
  return {
    id: createHash("sha256")
      .update(`${config.projectId}:${sample.topic}:${sample.timestamp}:${JSON.stringify(sample.value)}`)
      .digest("hex")
      .slice(0, 32),
    projectId: config.projectId,
    source: config.source ?? `opcua/${config.connectionId}`,
    key: config.key ?? sample.topic,
    value: sample.value,
    timestamp: sample.timestamp,
    ...(sample.sequence !== undefined ? { sequence: sample.sequence } : {}),
    ...(config.sceneId ? { sceneId: config.sceneId } : {}),
    ...(config.target ? { target: config.target } : {}),
    ...(config.action ? { action: config.action } : {}),
  };
}

function toIsoTime(value: Date | string | null | undefined): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

/** OPC UA 服务端时间戳优先级:sourceTimestamp(设备源时钟)→ serverTimestamp(服务器钟)。 */
function resolveSampleTimestamp(dataValue: OpcUaDataValueLike): string | undefined {
  return toIsoTime(dataValue.sourceTimestamp) ?? toIsoTime(dataValue.serverTimestamp);
}

function isGoodStatus(statusCode: unknown): boolean {
  if (statusCode === undefined || statusCode === null) return true;
  if (typeof statusCode === "number") return statusCode === 0;
  if (typeof statusCode === "object") {
    const status = statusCode as { isGoodish?: () => boolean; isGood?: () => boolean; value?: number };
    if (typeof status.isGoodish === "function") return status.isGoodish();
    if (typeof status.isGood === "function") return status.isGood();
    if (typeof status.value === "number") return status.value === 0;
  }
  return true;
}

/**
 * 每节点的序列推导状态:服务端时间戳水位 + 断线区间估计只发生在实例首个受序样本上
 * (checkpoint 只有一份全局 lastTimestamp,逐节点外推会引入系统性估计误差,如实单点估计)。
 */
interface NodeSequenceState {
  lastTimestampMs: number | null;
  lastValueJson: string | null;
}

interface RealSessionShape {
  on?(event: string, listener: (...args: never[]) => void): unknown;
  off?(event: string, listener: (...args: never[]) => void): unknown;
  close(): Promise<unknown>;
}

interface RealClientShape {
  connect(url: string): Promise<unknown>;
  createSession(options?: Record<string, unknown>): Promise<RealSessionShape>;
  disconnect(): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  off?(event: string, listener: (...args: never[]) => void): unknown;
}

interface RealClientSubscriptionShape {
  create(session: unknown, options: Record<string, unknown>): Promise<OpcUaSubscriptionLike>;
}

/**
 * 真实 node-opcua-client 对象 → 最小接口适配。
 * 关键:ClientSession.createSubscription 是裸服务调用(返回 CreateSubscriptionResponse),
 * 订阅友好 API 是 ClientSubscription.create(session, options)——在此统一收口,
 * 使生产路径与测试注入共享同一最小接口(OpcUaClientLike)。
 */
function adaptRealClient(realClient: RealClientShape, clientSubscription: RealClientSubscriptionShape): OpcUaClientLike {
  return {
    connect: (url) => realClient.connect(url),
    createSession: async (options) => {
      const session = await realClient.createSession(options);
      return {
        createSubscription: (createOptions) => clientSubscription.create(session, createOptions),
        on: (event, listener) => session.on?.(event, listener as (...args: never[]) => void),
        off: (event, listener) => session.off?.(event, listener as (...args: never[]) => void),
        close: () => session.close(),
      };
    },
    disconnect: () => realClient.disconnect(),
    on: (event, listener) => realClient.on(event, listener),
    off: (event, listener) => realClient.off?.(event, listener),
  };
}

export function createOpcUaSubscriptionSource(config: OpcUaSubscriptionSourceConfig): SubscriptionSource {
  assertOpcUaSubscriptionConfig(config);
  const topics = config.nodeIds.map((nodeId) => resolveOpcUaNodeId(nodeId.trim(), config.namespace ?? 0));
  const samplingIntervalMs = config.samplingIntervalMs ?? 0;
  const publishingIntervalMs = config.publishingIntervalMs ?? 500;
  const queueSize = config.queueSize ?? 10;

  let client: OpcUaClientLike | undefined;
  let session: OpcUaSessionLike | undefined;
  let subscription: OpcUaSubscriptionLike | undefined;
  let started = false;
  let disposed = false;
  let disconnectEmitted = false;
  /** 源更新计数器:从 resume.lastSequence 播种,保证跨实例单调,旧样本由会话幂等丢弃。 */
  let sequenceCounter = config.resume?.lastSequence ?? 0;
  /**
   * 实例生命周期内是否已经消费"断线区间估计"机会:首个受序样本评估一次。
   * 全新连接(无 resume)视为已消费——不存在断线区间可估。
   */
  let resumeEstimatePending = config.resume?.lastSequence !== null && config.resume?.lastSequence !== undefined
    ? true
    : config.resume?.lastTimestamp !== null && config.resume?.lastTimestamp !== undefined;
  const nodeStates = new Map<string, NodeSequenceState>();
  const sampleListeners = new Set<(sample: SourceSample) => void>();
  const lifecycleListeners = new Set<(event: SourceLifecycleEvent) => void>();
  const stats = { parseFailures: 0, badQuality: 0, staleDuplicates: 0, droppedStale: 0, samplesEmitted: 0 };

  const emitSample = (sample: SourceSample): void => {
    stats.samplesEmitted += 1;
    for (const listener of sampleListeners) listener(sample);
  };
  const emitDisconnected = (reason: string): void => {
    if (disconnectEmitted || disposed) return;
    disconnectEmitted = true;
    for (const listener of lifecycleListeners) listener({ kind: "disconnected", reason });
  };

  /**
   * 受序路径(严格更新的源样本):
   * 1. 首个受序样本若处于恢复状态(resumeEstimatePending):
   *    - 有周期声明(samplingIntervalMs>0)且 resume 有时间戳基准且样本晚于基准 →
   *      按时间差折算丢失点数,序列跳号 → 会话产出 sequenceKnown:true 缺口;
   *    - 样本早于基准(陈旧重放)→ 适配器丢弃;
   *    - 无周期声明或无基准 → 本条样本不带 sequence(会话以 sequenceKnown:false 对账,
   *      如实声明完整性未知),计数器仍前进一步,使后续样本从 checkpoint 连续处恢复。
   * 2. 流内:时间跳变且声明了周期 → 同法估计丢失并跳号;否则计数器 +1(连续)。
   */
  const acceptOrderedSample = (
    topic: string,
    normalized: unknown,
    timestamp: string,
    timestampMs: number,
    valueJson: string,
    state: NodeSequenceState,
  ): void => {
    if (resumeEstimatePending) {
      const resumeTimestampMs =
        config.resume?.lastTimestamp !== null && config.resume?.lastTimestamp !== undefined
          ? Date.parse(config.resume.lastTimestamp)
          : Number.NaN;
      if (Number.isFinite(resumeTimestampMs) && timestampMs < resumeTimestampMs) {
        // 恢复后的陈旧重放:早于断线前已确认位置,直接丢弃;估计机会保留给首条有效样本。
        stats.droppedStale += 1;
        return;
      }
      resumeEstimatePending = false;
      if (samplingIntervalMs > 0 && Number.isFinite(resumeTimestampMs) && timestampMs > resumeTimestampMs) {
        const missed = Math.max(0, Math.round((timestampMs - resumeTimestampMs) / samplingIntervalMs) - 1);
        sequenceCounter += missed + 1;
      } else {
        // 无周期声明/无时间基准:本条降级为无序列样本,由会话按完整性未知口径对账;
        // 计数器不动,使下一条受序样本恰从 checkpoint 序列连续处(lastSequence+1)恢复。
        emitSample({ topic, value: normalized, timestamp });
        state.lastTimestampMs = timestampMs;
        state.lastValueJson = valueJson;
        return;
      }
    } else if (state.lastTimestampMs !== null && samplingIntervalMs > 0) {
      // 流内时间跳变(源停摆后恢复):按声明周期估计丢失点数,序列跳号。
      const missed = Math.round((timestampMs - state.lastTimestampMs) / samplingIntervalMs) - 1;
      sequenceCounter += missed >= 1 ? missed + 1 : 1;
    } else {
      sequenceCounter += 1;
    }
    emitSample({ topic, value: normalized, timestamp, sequence: sequenceCounter });
    state.lastTimestampMs = timestampMs;
    state.lastValueJson = valueJson;
  };

  const handleDataValue = (topic: string, dataValue: OpcUaDataValueLike): void => {
    if (disposed) return;
    if (!isGoodStatus(dataValue.statusCode)) {
      stats.badQuality += 1;
      for (const listener of lifecycleListeners) {
        listener({ kind: "invalid-sample", reason: `OPC UA 值质量异常(topic=${topic}, status=${String(dataValue.statusCode)})` });
      }
      return;
    }
    const normalized = normalizeOpcUaLiveValue(dataValue.value?.value);
    if (normalized === undefined) {
      stats.parseFailures += 1;
      for (const listener of lifecycleListeners) {
        listener({ kind: "invalid-sample", reason: `OPC UA 值不可序列化(topic=${topic}, dataType=${typeof dataValue.value?.value})` });
      }
      return;
    }

    const state = nodeStates.get(topic) ?? { lastTimestampMs: null, lastValueJson: null };
    nodeStates.set(topic, state);
    const serverTimestampIso = resolveSampleTimestamp(dataValue);
    const timestampMs = serverTimestampIso !== undefined ? Date.parse(serverTimestampIso) : Number.NaN;
    const timestamp = serverTimestampIso ?? new Date().toISOString();
    const valueJson = JSON.stringify(normalized);

    // 时间戳不可用:降级为无序列路径(会话指纹去重/水位),计数器与水位不动。
    if (!Number.isFinite(timestampMs)) {
      emitSample({ topic, value: normalized, timestamp });
      return;
    }
    // 同 sourceTimestamp 重发:同一源更新。值未变 → 直接丢弃;值变(规格上不应发生)
    // → 不带 sequence 外发,由会话按无序口径处置,绝不给重复序列号。
    if (state.lastTimestampMs !== null && timestampMs === state.lastTimestampMs) {
      if (state.lastValueJson === valueJson) {
        stats.staleDuplicates += 1;
        return;
      }
      emitSample({ topic, value: normalized, timestamp });
      return;
    }
    // 时间戳倒退:过期重放,适配器侧丢弃(节点内服务端时间戳即权威顺序)。
    if (state.lastTimestampMs !== null && timestampMs < state.lastTimestampMs) {
      stats.droppedStale += 1;
      return;
    }
    acceptOrderedSample(topic, normalized, timestamp, timestampMs, valueJson, state);
  };

  const onConnectionLost = (): void => emitDisconnected("OPC UA 连接丢失");
  const onSessionClosed = (): void => emitDisconnected("OPC UA 会话关闭");
  const onKeepaliveFailure = (): void => emitDisconnected("OPC UA keepalive 失效");
  const onSubscriptionTerminated = (): void => emitDisconnected("OPC UA 订阅终止");

  return {
    protocol: "opcua",
    async start() {
      // 已释放的实例永久不可用,该检查先于 started。
      if (disposed) throw new Error("OPC UA 订阅源已释放");
      if (started) throw new Error("OPC UA 订阅源已启动;重连请通过 sourceFactory 重建实例");
      started = true;
      const { OPCUAClient, ClientSubscription, MessageSecurityMode, SecurityPolicy, UserTokenType } = await import("node-opcua-client");
      const security = config.security;
      const clientFactory: OpcUaClientFactory =
        config.deps?.createClient ??
        (security
          ? async () => {
              // 安全路径(T24 接线):Sign + Basic256Sha256,客户端自签证书由
              // opcUaSecureTransport 的 CertificateManager 生成并在同 rootDir 内跨实例复用。
              // 惰性 import 保持本模块级零 node-opcua 依赖(仅安全路径加载传输批)。
              const { createSignedOpcUaClient } = await import("./opcUaSecureTransport.js");
              const realClient = await createSignedOpcUaClient({
                endpointUrl: config.endpointUrl.trim(),
                certificateManagerRootDir: security.certificateManagerRootDir,
                ...(security.applicationName ? { applicationName: security.applicationName } : {}),
                ...(security.messageSecurityMode !== undefined ? { messageSecurityMode: security.messageSecurityMode } : {}),
              });
              return adaptRealClient(
                realClient as unknown as RealClientShape,
                ClientSubscription as unknown as RealClientSubscriptionShape,
              );
            }
          : () =>
              adaptRealClient(
                OPCUAClient.create({
                  endpointMustExist: false,
                  // 内部自动重连关闭:重连所有权归订阅运行时的退避策略,避免双权重连。
                  connectionStrategy: { initialDelay: 250, maxDelay: 1_000, maxRetry: 0 },
                  securityMode: MessageSecurityMode.None,
                  securityPolicy: SecurityPolicy.None,
                }) as unknown as RealClientShape,
                ClientSubscription as unknown as RealClientSubscriptionShape,
              ));
      client = await clientFactory();
      client.on("connection_lost", onConnectionLost as unknown as (...args: never[]) => void);
      const activeClient = client;
      try {
        await activeClient.connect(config.endpointUrl.trim());
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`OPC UA endpoint 不可达(${config.endpointUrl.trim()}): ${reason || "连接失败"}`);
      }
      try {
        session = await activeClient.createSession(
          config.user
            ? { type: UserTokenType.UserName, userName: config.user, ...(config.password ? { password: config.password } : {}) }
            : undefined,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        try {
          await activeClient.disconnect();
        } catch {
          /* disconnect 失败不掩盖原错误 */
        }
        throw new Error(`OPC UA 会话建立失败(${config.endpointUrl.trim()}): ${reason || "被服务器拒绝"}`);
      }
      session.on("session_closed", onSessionClosed as unknown as (...args: never[]) => void);
      session.on("keepalive_failure", onKeepaliveFailure as unknown as (...args: never[]) => void);
      try {
        subscription = await session.createSubscription({
          requestedPublishingInterval: publishingIntervalMs,
          requestedLifetimeCount: 60,
          requestedMaxKeepAliveCount: 10,
          maxNotificationsPerPublish: 1_000,
          publishingEnabled: true,
          priority: 0,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        try {
          await session.close();
        } catch {
          /* 不掩盖原错误 */
        }
        try {
          await activeClient.disconnect();
        } catch {
          /* 不掩盖原错误 */
        }
        throw new Error(`OPC UA 订阅建立失败(${config.endpointUrl.trim()}): ${reason || "被服务器拒绝"}`);
      }
      subscription.on("terminated", onSubscriptionTerminated as unknown as (...args: never[]) => void);
      for (const topic of topics) {
        const monitoredItem = await subscription.monitor(
          { nodeId: topic, attributeId: ATTRIBUTE_VALUE },
          { samplingInterval: samplingIntervalMs > 0 ? samplingIntervalMs : 0, discardOldest: true, queueSize },
          TIMESTAMPS_BOTH,
        );
        monitoredItem.on("changed", (dataValue) => handleDataValue(topic, dataValue));
      }
      for (const listener of lifecycleListeners) listener({ kind: "ready" });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      sampleListeners.clear();
      lifecycleListeners.clear();
      const activeSubscription = subscription;
      subscription = undefined;
      const activeSession = session;
      session = undefined;
      const activeClient = client;
      client = undefined;
      if (activeSubscription?.off) activeSubscription.off("terminated", onSubscriptionTerminated as unknown as () => void);
      if (activeSession?.off) {
        activeSession.off("session_closed", onSessionClosed as unknown as () => void);
        activeSession.off("keepalive_failure", onKeepaliveFailure as unknown as () => void);
      }
      activeSubscription?.terminate?.().catch(() => undefined);
      if (activeSession) {
        try {
          await activeSession.close();
        } catch {
          /* 会话可能已随连接断开 */
        }
      }
      if (activeClient?.off) activeClient.off("connection_lost", onConnectionLost as unknown as () => void);
      if (activeClient) {
        try {
          await activeClient.disconnect();
        } catch {
          /* 连接可能已断开 */
        }
      }
    },
    onSample(listener) {
      sampleListeners.add(listener);
      return () => sampleListeners.delete(listener);
    },
    onLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    stats: () => ({ ...stats }),
  };
}

/**
 * 支持度描述:路由与编辑器消费它如实标注能力边界(替代旧 implemented:false 占位)。
 * securityEnabled:安全声明随实际配置条件化——配置 security 的调用方应传 true,
 * 此时限定为 Sign + Basic256Sha256 并如实声明未覆盖面;无参调用(既有路由/编辑器)
 * 输出与安全接线前逐字一致(零变化承诺)。
 */
export function describeOpcUaSubscriptionSupport(options?: { securityEnabled?: boolean }): {
  implemented: true;
  sequenceSemantics: string;
  limitations: string[];
} {
  return {
    implemented: true,
    sequenceSemantics:
      "服务端时间戳(sourceTimestamp 优先、serverTimestamp 兜底)单调序映射为序列;配置 samplingIntervalMs 时按时间差估计断线/停摆丢失点数(sequenceKnown:true),未配置或时间戳不可用时如实降级为完整性未知(sequenceKnown:false)。",
    limitations: [
      "SubscriptionTransfer(subscriptionId 迁移)未实现:断线后由运行时重建订阅,断线区间数据不补发,以缺口报告对账。",
      options?.securityEnabled === true
        ? "支持 Basic256Sha256；securityMode 可选 sign / signAndEncrypt，缺省 sign。客户端自签证书由 CertificateManager 管理；远端 CA/CRL 信任配置未接入产品连接表单，静态 CRL 拒绝仅有隔离服务端测试证据。"
        : "安全模式固定 None(与 previewOpcUa 同口径);Sign/SignAndEncrypt 需宿主证书管理,留待后续子项。",
      "缺口 estimatedCount 是按声明更新周期的估计值,以 fromTime/toTime 为界;非周期源请勿配置 samplingIntervalMs。",
    ],
  };
}
