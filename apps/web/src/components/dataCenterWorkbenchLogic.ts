import type { DataConnectorDiagnostics, DataDatasetField, DataFieldType } from "@bim-studio/contracts";

/**
 * 数据中心工作台纯逻辑层（帆软 FVS 信息密度纪律的决策面）：
 * 四步向导三态推导、连接监控迷你趋势标定、字段统计（类型徽章/样例值/空值率）、
 * 预览表虚拟滚动行窗。全部确定性纯函数，画布/表格外的一切决策在此可单测。
 *
 * 诚实边界：步骤完成度只来自已加载的真实计数；未加载（undefined）= "未知"，
 * 不伪造完成态；趋势条只反映本会话采到的诊断快照，不足两条如实标注。
 */

// ---------------------------------------------------------------------------
// 四步向导：当前 / 完成 / 可跳转 三态
// ---------------------------------------------------------------------------

export type DataCenterStepId = "connect" | "transform" | "publish" | "semantic";

export interface DataCenterStepState {
  id: DataCenterStepId;
  /** 已就绪（该步有真实产出物）；undefined = 计数未加载，不谎报完成。 */
  done: boolean | undefined;
  count: number | undefined;
}

export interface DataCenterStepCounts {
  connect: number | undefined;
  transform: number | undefined;
  publish: number | undefined;
  semantic: number | undefined;
}export const DATA_CENTER_STEP_ORDER: readonly DataCenterStepId[] = ["connect", "transform", "publish", "semantic"];

export const DATA_CENTER_STEP_META: Record<DataCenterStepId, { zh: string; en: string }> = {
  connect: { zh: "接入数据", en: "Connect data" },
  transform: { zh: "处理逻辑", en: "Transform" },
  publish: { zh: "发布接口", en: "Publish API" },
  semantic: { zh: "语义模型", en: "Semantic models" },
};

/** 步骤状态推导：done = 有产出物；undefined = 未知（接口未回/失败），展示为"未清点"。 */
export function dataCenterStepStates(counts: DataCenterStepCounts): Record<DataCenterStepId, DataCenterStepState> {
  return {
    connect: { id: "connect", done: counts.connect === undefined ? undefined : counts.connect > 0, count: counts.connect },
    transform: { id: "transform", done: counts.transform === undefined ? undefined : counts.transform > 0, count: counts.transform },
    publish: { id: "publish", done: counts.publish === undefined ? undefined : counts.publish > 0, count: counts.publish },
    semantic: { id: "semantic", done: counts.semantic === undefined ? undefined : counts.semantic > 0, count: counts.semantic },
  };
}

// ---------------------------------------------------------------------------
// 连接监控迷你趋势条（本会话诊断快照序列）
// ---------------------------------------------------------------------------

export interface ConnectorTrendSample {
  at: string;
  latencyMs: number;
  /** 该快照的失败计数（连续失败优先，取不到回落总失败）。 */
  failures: number;
}

/** 追加采样并截断窗口（同刻去重：同毫秒覆盖，幂等）。
 *  失败标记只取连续失败（当前失败连击）；totalFailures 是累计值，不作本快照判据。 */
export function pushConnectorSample(samples: ConnectorTrendSample[], diagnostics: DataConnectorDiagnostics, now: string, windowSize = 16): ConnectorTrendSample[] {
  const next: ConnectorTrendSample = {
    at: now,
    latencyMs: diagnostics.lastLatencyMs ?? 0,
    failures: diagnostics.consecutiveFailures,
  };
  const merged = samples.length > 0 && samples[samples.length - 1]!.at === now
    ? [...samples.slice(0, -1), next]
    : [...samples, next];
  return merged.slice(-windowSize);
}

/** 延迟条高（0–1）：相对窗口内最大延迟；窗口全 0 时全部给最小可见高。 */
export function connectorTrendBars(samples: ConnectorTrendSample[]): Array<{ latency: number; failures: number; latencyMs: number }> {
  const max = Math.max(1, ...samples.map((sample) => sample.latencyMs));
  return samples.map((sample) => ({
    latencyMs: sample.latencyMs,
    latency: Math.max(sample.latencyMs > 0 ? 0.08 : 0.03, sample.latencyMs / max),
    failures: sample.failures,
  }));
}

// ---------------------------------------------------------------------------
// 数据预览字段统计：类型徽章 + 样例值 + 空值率
// ---------------------------------------------------------------------------

export interface DatasetFieldStat {
  key: string;
  type: DataFieldType;
  /** 首个非空值（格式化前的原值转字符串，空值率旁一并透出）。 */
  sample: string;
  /** 空值率（0–1，按预览行集合；无行时 undefined=不谎报 0）。 */
  nullRate: number | undefined;
}

export function datasetFieldStats(fields: ReadonlyArray<DataDatasetField>, rows: ReadonlyArray<Record<string, unknown>>): DatasetFieldStat[] {
  return fields.map((field) => {
    let nulls = 0;
    let sample = "";
    for (const row of rows) {
      const value = row[field.key];
      if (value === null || value === undefined || value === "") {
        nulls += 1;
        continue;
      }
      if (!sample) sample = typeof value === "object" ? JSON.stringify(value) : String(value);
    }
    return {
      key: field.key,
      type: field.type,
      sample,
      nullRate: rows.length > 0 ? nulls / rows.length : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// 预览表虚拟滚动：固定行高行窗
// ---------------------------------------------------------------------------

export const PREVIEW_ROW_HEIGHT = 34;

/** 可见行区间（含 overscan），滚动任意位置都返回闭区间 [start, end)；total=0 给空窗。 */
export function visibleRowRange(options: { scrollTop: number; viewportHeight: number; total: number; rowHeight?: number; overscan?: number }): { start: number; end: number } {
  const rowHeight = options.rowHeight ?? PREVIEW_ROW_HEIGHT;
  const overscan = options.overscan ?? 6;
  const { total, scrollTop, viewportHeight } = options;
  if (total <= 0 || viewportHeight <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const end = Math.min(total, start + visibleCount);
  return { start, end };
}
