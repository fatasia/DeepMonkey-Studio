/**
 * PLC Live 模式(OPC UA 实连)合同,与 virtualCommissioning.ts 的确定性 Replay 模式并存。
 * 定案(2026-09-26,规格审阅):Live 证据必须显式标记 non-deterministic,
 * 与 Replay 的 evidenceFingerprint 轨迹严格隔离,禁止混入黄金用例矩阵。
 */
import type { VirtualDebugSignalValue } from "./virtualCommissioning.js";

/** OPC UA 消息安全模式;None 仅限可信内网,Sign/SignAndEncrypt 需要宿主侧证书管理配合。 */
export type OpcUaSecurityMode = "None" | "Sign" | "SignAndEncrypt";

export interface OpcUaLiveIdentity {
  user: string;
  /** 指向密钥库/环境变量的密码占位符;合同不承载明文密码,解析由宿主负责。 */
  passwordRef: string;
}

export interface OpcUaLiveEndpoint {
  /** 例如 opc.tcp://127.0.0.1:4840 */
  endpointUrl: string;
  securityMode: OpcUaSecurityMode;
  identity?: OpcUaLiveIdentity;
  /** 绑定 nodeId 未携带 ns= 前缀时的默认命名空间索引。 */
  namespace: number;
}

/** 信号名到 OPC UA NodeId 的绑定;signal 与 VirtualDebugScenario 的信号键一致。 */
export interface OpcUaLiveBinding {
  signal: string;
  /** 完整形式 ns=2;s=Channel1.Tag1 / ns=2;i=1001,或相对 id(如 Tag1、1001)。 */
  nodeId: string;
}

export interface OpcUaLiveSessionState {
  status: "disconnected" | "connecting" | "connected" | "error";
  message?: string;
  /** ISO 8601;Live 会话时间取自真实时钟,不可复现。 */
  connectedAt?: string;
}

export interface OpcUaLiveSample {
  signal: string;
  nodeId: string;
  value: VirtualDebugSignalValue;
  /** 现场数据源时间戳(ISO 8601);不参与任何确定性指纹计算。 */
  timestamp: string;
}

/** Live 证据链:与 VirtualDebugResult 的确定性指纹不同型,字段集不相交。 */
export interface OpcUaLiveEvidence {
  mode: "live";
  endpoint: string;
  startedAt: string;
  endedAt: string;
  sampleCount: number;
  /** 常量 true:Live 采样来自真实 PLC 时序,同参数重放无法复现。 */
  nonDeterministic: true;
}

const OPC_UA_SECURITY_MODES: readonly OpcUaSecurityMode[] = ["None", "Sign", "SignAndEncrypt"];
const FULL_NODE_ID_PATTERN = /^ns=\d+;[is]=.+/;

/** 判定 nodeId 是否已是完整形式(ns=<index>;i=<id> 或 ns=<index>;s=<id>)。 */
export function isFullOpcUaNodeId(nodeId: string): boolean {
  return FULL_NODE_ID_PATTERN.test(nodeId);
}

/** 相对 id 展开为完整 NodeId:纯数字按数值 id(i=),否则按字符串 id(s=)。 */
export function resolveOpcUaNodeId(nodeId: string, namespace: number): string {
  if (isFullOpcUaNodeId(nodeId)) return nodeId;
  if (nodeId.startsWith("ns=") || nodeId.includes(";")) {
    throw new Error(`NodeId ${nodeId} 形如完整 NodeId 但不符合 ns=<index>;[i|s]=<id> 规范`);
  }
  return /^\d+$/.test(nodeId) ? `ns=${namespace};i=${nodeId}` : `ns=${namespace};s=${nodeId}`;
}

export function assertOpcUaLiveEndpoint(value: unknown, path = "opcUaLiveEndpoint"): asserts value is OpcUaLiveEndpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是端点对象`);
  const endpoint = value as Record<string, unknown>;
  if (typeof endpoint.endpointUrl !== "string" || !/^opc\.tcp:\/\//i.test(endpoint.endpointUrl.trim())) {
    throw new Error(`${path}.endpointUrl 必须以 opc.tcp:// 开头`);
  }
  if (!OPC_UA_SECURITY_MODES.includes(endpoint.securityMode as OpcUaSecurityMode)) {
    throw new Error(`${path}.securityMode 必须是 None/Sign/SignAndEncrypt`);
  }
  if (!Number.isSafeInteger(endpoint.namespace) || (endpoint.namespace as number) < 0) {
    throw new Error(`${path}.namespace 必须是非负整数`);
  }
  if (endpoint.identity !== undefined) {
    if (!endpoint.identity || typeof endpoint.identity !== "object" || Array.isArray(endpoint.identity)) {
      throw new Error(`${path}.identity 必须是对象`);
    }
    const identity = endpoint.identity as Record<string, unknown>;
    if (typeof identity.user !== "string" || !identity.user.trim()) throw new Error(`${path}.identity.user 不能为空`);
    if (typeof identity.passwordRef !== "string" || !identity.passwordRef.trim()) {
      throw new Error(`${path}.identity.passwordRef 不能为空(合同不承载明文密码)`);
    }
  }
}

export function assertOpcUaLiveBindings(value: unknown, path = "opcUaLiveBindings"): asserts value is OpcUaLiveBinding[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error(`${path} 必须是非空数组`);
  const signals = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error(`${path} 每一项必须是绑定对象`);
    const binding = item as Record<string, unknown>;
    if (typeof binding.signal !== "string" || !binding.signal.trim()) throw new Error(`${path}.signal 不能为空`);
    if (signals.has(binding.signal)) throw new Error(`${path}.signal 重复:${binding.signal}`);
    if (typeof binding.nodeId !== "string" || !binding.nodeId.trim()) throw new Error(`${path}.nodeId 不能为空`);
    if (!isFullOpcUaNodeId(binding.nodeId) && (binding.nodeId.startsWith("ns=") || binding.nodeId.includes(";"))) {
      throw new Error(`${path}.nodeId ${binding.nodeId} 不符合 OPC UA NodeId 规范`);
    }
    signals.add(binding.signal);
  }
}

/** OPC UA Variant 标量 → 可序列化控制信号值;不支持类型返回 undefined,由调用方显式记录而非静默丢弃。 */
export function normalizeOpcUaLiveValue(value: unknown): VirtualDebugSignalValue | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Math.abs(converted) <= Number.MAX_SAFE_INTEGER ? converted : value.toString();
  }
  return undefined;
}
