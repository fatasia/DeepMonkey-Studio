import type { DirectBindingSpec } from "./directBinding.js";
import type { DataWritebackConfig } from "./dataWriteback.js";

/** 数据接入、数据产品、管道与对外端点的稳定合同。 */
export type DataConnectionType =
  | "postgresql"
  | "mysql"
  | "mariadb"
  | "tidb"
  | "doris"
  | "starrocks"
  | "sqlserver"
  | "oracle"
  | "tdengine"
  | "clickhouse"
  | "mongodb"
  | "elasticsearch"
  | "influxdb"
  | "prometheus"
  | "csv"
  | "excel"
  | "http"
  | "websocket"
  | "mqtt"
  | "opcua"
  | "modbus"
  | "bacnet"
  | "tcp"
  | "udp"
  | "serial"
  | "s7"
  | "ethernet-ip"
  | "snmp"
  | "amqp"
  | "kafka"
  | "coap"
  | "simulation";

export interface DataConnectionRecord {
  id: string;
  projectId: string;
  name: string;
  type: DataConnectionType;
  enabled: boolean;
  /** 连接参数不保存明文密码；密码通过 passwordEnv 指向服务端环境变量。 */
  config: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

export type DataFieldType = "string" | "number" | "boolean" | "datetime" | "json";

export type DataEventAction = "color" | "visibility" | "position" | "label" | "opacity" | "focus" | "animation" | "effects" | "material" | "alarm";

export interface DataEventTarget {
  modelId?: string;
  layerId?: string;
  annotationId?: string;
}

export interface DataMessage {
  source: string;
  key: string;
  value: unknown;
  timestamp: string;
  /** 源序列号(OPC UA source timestamp 序 / MQTT 用户属性或负载字段);缺失表示源不保证序。 */
  sequence?: number;
  sceneId?: string;
  target?: DataEventTarget;
  action?: DataEventAction;
}

/** A declarative bridge from one shared data product field to a 3D target. */
export interface SceneDataBindingState {
  id: string;
  name: string;
  enabled: boolean;
  datasetId?: string;
  pipelineId?: string;
  directBinding?: DirectBindingSpec;
  field: string;
  rowIndex?: number;
  target: DataEventTarget;
  action: DataEventAction;
  signalRule?: import("./deviceSignal.js").DeviceSignalRule;
  refreshSeconds: number;
}

export interface DataEvent extends DataMessage {
  id: string;
  projectId: string;
}

export interface DataDatasetField {
  key: string;
  label: string;
  type: DataFieldType;
  unit?: string;
}

export interface DataComputedField {
  id: string;
  key: string;
  label: string;
  type: DataFieldType;
  mode?: "formula" | "script";
  formula: string;
}

export interface DataDatasetRecord {
  id: string;
  projectId: string;
  connectionId: string;
  name: string;
  query?: string;
  sourceKey?: string;
  refreshSeconds: number;
  fields: DataDatasetField[];
  computedFields?: DataComputedField[];
  writeback?: DataWritebackConfig;
  createdAt: string;
  updatedAt: string;
}

export interface DataDatasetPreview {
  dataset: DataDatasetRecord;
  fields: DataDatasetField[];
  rows: Array<Record<string, unknown>>;
  durationMs: number;
}

/** AI/算法运行所读取的数据快照证据；只记录来源身份，不暴露连接凭据。 */
export interface DataSourceEvidence {
  datasetId: string;
  datasetName: string;
  connectionId: string;
  connectionType: DataConnectionType;
  rowCount: number;
  fieldKeys: string[];
  sampledAt: string;
  durationMs: number;
}

export type DataPipelineNode =
  | { id: string; type: "source"; name: string; datasetId: string; position: { x: number; y: number } }
  | { id: string; type: "filter"; name: string; formula: string; position: { x: number; y: number } }
  | { id: string; type: "formula"; name: string; key: string; label: string; fieldType: DataFieldType; formula: string; position: { x: number; y: number } }
  | { id: string; type: "script"; name: string; key: string; label: string; fieldType: DataFieldType; source: string; position: { x: number; y: number } }
  | { id: string; type: "select"; name: string; fields: string[]; position: { x: number; y: number } }
  | { id: string; type: "deduplicate"; name: string; fields: string[]; position: { x: number; y: number } }
  | {
      id: string;
      type: "aggregate";
      name: string;
      groupBy: string[];
      field: string;
      operation: "count" | "sum" | "average" | "min" | "max";
      outputKey: string;
      position: { x: number; y: number };
    }
  | { id: string; type: "sort"; name: string; field: string; direction: "asc" | "desc"; position: { x: number; y: number } }
  | { id: string; type: "limit"; name: string; count: number; position: { x: number; y: number } }
  | { id: string; type: "merge"; name: string; position: { x: number; y: number } }
  | { id: string; type: "output"; name: string; position: { x: number; y: number } };

export interface DataPipelineEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
}

export interface DataPipelineDefinition {
  id: string;
  projectId: string;
  name: string;
  nodes: DataPipelineNode[];
  edges: DataPipelineEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface DataConnectorDiagnostics {
  connectionId: string;
  projectId: string;
  type: DataConnectionType;
  status: "idle" | "healthy" | "degraded" | "offline";
  totalReads: number;
  totalWrites: number;
  totalFailures: number;
  consecutiveFailures: number;
  reconnects: number;
  lastLatencyMs?: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
}

export interface DataPipelineNodeDiagnostic {
  nodeId: string;
  status: "success" | "error";
  inputRows: number;
  outputRows: number;
  durationMs: number;
  /** 节点实际收到的输入样例；用于逐节点调试，不包含连接凭据。 */
  inputSample: Array<Record<string, unknown>>;
  /** 节点处理后的输出样例。 */
  sample: Array<Record<string, unknown>>;
  error?: string;
}

export interface DataPipelinePreview {
  pipeline: DataPipelineDefinition;
  status: "success" | "error";
  fields: DataDatasetField[];
  rows: Array<Record<string, unknown>>;
  durationMs: number;
  diagnostics: DataPipelineNodeDiagnostic[];
  /** 存在时表示本次仅执行到该节点，不是可发布的全流程结果。 */
  executedThroughNodeId?: string;
  failedNodeId?: string;
  error?: string;
}

export type DataEndpointKind = "rest" | "websocket";

export interface DataEndpointDefinition {
  id: string;
  projectId: string;
  name: string;
  kind: DataEndpointKind;
  slug: string;
  pipelineId: string;
  enabled: boolean;
  apiKeyHint: string;
  method?: "GET" | "POST";
  channel?: string;
  intervalMs?: number;
  requestsPerMinute: number;
  createdAt: string;
  updatedAt: string;
}

export interface DataEndpointSaveResult {
  endpoint: DataEndpointDefinition;
  /** 仅在首次创建或主动轮换时返回，服务器不会再次提供明文。 */
  apiKey?: string;
}

export interface DataStreamEnvelope<T = unknown> {
  type: "data" | "heartbeat" | "error";
  channel: string;
  messageId: string;
  timestamp: string;
  schemaVersion: "1";
  payload: T;
}

/**
 * T24 持久订阅会话状态合同(路由响应与后续编辑器消费共用)。
 * 语义:断线恢复后的缺口如实报告,不伪造连续性。
 */
export type DataSubscriptionLifecycle =
  | "idle"
  | "starting"
  | "healthy"
  | "reconnecting"
  | "stopped"
  | "failed";

/** 一次断线区间对账结果;from/to 为闭区间,sequenceKnown=false 表示源无序列号、丢失量未知。 */
export interface DataSubscriptionGapReport {
  id: string;
  connectionId: string;
  /** 缺口期望序列号起点(含);源无序列号时为 null。 */
  fromSequence: number | null;
  /** 缺口期望序列号终点(含);源无序列号时为 null。 */
  toSequence: number | null;
  /** 估计丢失点数;源无序列号时为 null。 */
  estimatedCount: number | null;
  /** 断线前最后收到样本时间(ISO 8601)。 */
  fromTime: string;
  /** 恢复后首条样本到达时间(ISO 8601)。 */
  toTime: string;
  sequenceKnown: boolean;
  detectedAt: string;
}

export interface DataSubscriptionStatus {
  connectionId: string;
  projectId: string;
  protocol: string;
  lifecycle: DataSubscriptionLifecycle;
  /** 同一连接的会话替换序号;每次 start 递增,用于生成号治理。 */
  generation: number;
  received: number;
  published: number;
  deduplicated: number;
  droppedOutOfOrder: number;
  parseFailures: number;
  reconnects: number;
  /** 已记录的缺口报告(有界,超出上限合并计数)。 */
  gapReports: DataSubscriptionGapReport[];
  gapReportsTruncated: number;
  lastSequence: number | null;
  lastTimestamp: string | null;
  /** 下次重连尝试的绝对时间(ISO 8601);不在重连中时为 null。 */
  nextReconnectAt: string | null;
  lastError?: string;
  lastMessageAt?: string;
  updatedAt: string;
}
