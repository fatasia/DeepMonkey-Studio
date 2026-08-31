import type { DirectBindingSpec } from "./directBinding.js";

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

export type DataEventAction = "color" | "visibility" | "position" | "label" | "opacity" | "focus" | "animation" | "effects" | "material";

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
