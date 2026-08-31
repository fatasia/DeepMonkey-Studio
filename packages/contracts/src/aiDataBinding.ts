import type { DataSourceEvidence } from "./data.js";

/** 统一的表格、时序和消息类 AI 数据绑定；媒体输入继续使用视觉专用合同。 */
export type AiDataBindingStatus = "draft" | "active" | "paused" | "invalid";

export interface AiDataBindingEntity {
  keyField: string;
  selectedKeys?: string[];
}

export interface AiDataBindingTime {
  field: string;
  order: "asc" | "desc";
  timezone?: string;
}

export interface AiDataBindingFeature {
  modelField: string;
  sourceField: string;
  unit?: string;
  scale?: number;
  offset?: number;
  required: boolean;
}

export interface AiDataBindingWindow {
  rows?: number;
  durationSeconds?: number;
}

/** 固定周期使用秒数，不接受 cron；事件触发只描述一个上游事件，不编排多节点流程。 */
export type AiDataBindingTrigger =
  | { type: "manual" }
  | { type: "interval"; seconds: number }
  | { type: "event"; eventName?: string; debounceSeconds?: number };

export interface AiDataBindingQuality {
  minimumSamples: number;
  maxAgeSeconds: number;
  maximumMissingRate: number;
}

export interface AiDataBindingRetry {
  maxAttempts: number;
  backoffSeconds: number;
}

export type AiDataBindingOutput =
  | { type: "record"; targetDatasetId?: string }
  | { type: "case"; caseType?: string }
  | { type: "scene-link"; sceneId?: string; entityField?: string };

/**
 * 数据集只保存一次连接配置，能力绑定只保存字段和运行策略，不保存连接凭据。
 * revision 随数据集 Schema、能力版本或映射变化递增，供运行证据复现使用。
 */
export interface AiDataBinding {
  id: string;
  projectId: string;
  name: string;
  datasetId: string;
  capabilityId: string;
  /** 能力专用的稳定标量参数，例如模型、化学体系和额定容量；不得保存凭据。 */
  parameters?: Record<string, string | number | boolean>;
  status: AiDataBindingStatus;
  entity?: AiDataBindingEntity;
  time?: AiDataBindingTime;
  features: AiDataBindingFeature[];
  window: AiDataBindingWindow;
  trigger: AiDataBindingTrigger;
  quality: AiDataBindingQuality;
  retry: AiDataBindingRetry;
  output: AiDataBindingOutput;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type AiDataBindingRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

/** 只保存本次实际读取的数据证据和窗口摘要，不复制原始工业数据。 */
export interface AiDataBindingRunInput {
  sourceEvidence?: DataSourceEvidence;
  entityKeys?: string[];
  sampleCount?: number;
  windowStartAt?: string;
  windowEndAt?: string;
}

export interface AiDataBindingRunOutput {
  type: AiDataBindingOutput["type"];
  referenceIds?: string[];
  summary?: string;
  metrics?: Record<string, string | number | boolean | null>;
}

export interface AiDataBindingRunFailure {
  code?: string;
  message: string;
  retryable: boolean;
}

/**
 * 一次绑定执行的最小审计记录。绑定修订、触发策略和数据来源均按运行时快照保存，
 * 后续修改或删除绑定时仍可复盘；输出只保存摘要及业务引用，不保存模型大结果。
 */
export interface AiDataBindingRunRecord {
  id: string;
  projectId: string;
  bindingId: string;
  bindingRevision: number;
  capabilityId: string;
  datasetId: string;
  trigger: AiDataBindingTrigger;
  status: AiDataBindingRunStatus;
  attempt: number;
  input?: AiDataBindingRunInput;
  output?: AiDataBindingRunOutput;
  failure?: AiDataBindingRunFailure;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  updatedAt: string;
}
