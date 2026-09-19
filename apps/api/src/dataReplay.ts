// P4 回放数据桥（2026-09-19）：
//   把服务端已有数据（数据集最近 N 行 / DataEventBus retained latest）构建成
//   { revision, entries } 时序负载，供前端 TimelineReplay 直接消费
//   （entries 与 web TimelineEntry 结构一致：at 为毫秒时间戳，values 为有限数值信号）。
//   revision 是数据版本声明（G06 语义）：数据集路径取 id@updatedAt，事件路径取末条事件 id。
//   纯读端点，不新建存储；告警引擎自产事件（alert-engine）是派生数据，不进回放时间轴。

import type { DataConnectionRecord, DataDatasetRecord, DataEvent } from "@bim-studio/contracts";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { ALERT_EVENT_SOURCE } from "./alertRules.js";
import { previewDataset } from "./dataIntegration.js";
import type { DataEventBus } from "./dataEvents.js";
import type { MetadataStore } from "./store.js";

export interface ReplayTimelineEntry {
  at: number;
  values: Record<string, number>;
}

export interface DataReplayPayload {
  revision: string;
  entries: ReplayTimelineEntry[];
}

export type ReplayRowsReader = (
  config: AppConfig,
  connection: DataConnectionRecord,
  dataset: DataDatasetRecord,
) => Promise<Array<Record<string, unknown>>>;

export interface DataReplayRouteDependencies {
  store: MetadataStore;
  bus: DataEventBus;
  config: AppConfig;
  readRows?: ReplayRowsReader;
  /** 单次回放返回的最大条数，超出时保留最近的一段。 */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 500;
const TIME_KEY_PATTERN = /^(timestamp|time|ts|recorded_at|created_at|date|时间)$/i;

async function defaultRowsReader(
  config: AppConfig,
  connection: DataConnectionRecord,
  dataset: DataDatasetRecord,
): Promise<Array<Record<string, unknown>>> {
  const preview = await previewDataset(config, connection, dataset);
  return preview.rows;
}

export async function registerDataReplayRoutes(app: FastifyInstance, dependencies: DataReplayRouteDependencies): Promise<void> {
  const readRows = dependencies.readRows ?? defaultRowsReader;
  const maxEntries = dependencies.maxEntries ?? DEFAULT_MAX_ENTRIES;

  app.get<{ Params: { projectId: string }; Querystring: { datasetId?: string; windowMs?: string } }>(
    "/api/projects/:projectId/data/replay",
    async (request, reply) => {
      const projectId = request.params.projectId;
      if (!dependencies.store.getProject(projectId)) return reply.code(404).send({ message: "项目不存在" });
      const windowMs = parseWindowMs(request.query.windowMs);
      if (windowMs === null) return reply.code(400).send({ message: "windowMs 必须是正数毫秒，例如 windowMs=3600000 表示只回放最近一小时" });

      const datasetId = request.query.datasetId?.trim();
      if (datasetId) {
        const dataset = dependencies.store.listDatasets(projectId).find((item) => item.id === datasetId);
        if (!dataset) return reply.code(400).send({ message: `数据集不存在：${datasetId}` });
        const connection = dependencies.store.listDataConnections(projectId).find((item) => item.id === dataset.connectionId);
        if (!connection) return reply.code(400).send({ message: `数据集 ${dataset.name} 的数据连接不存在或已删除` });
        const timeKey = resolveTimeKey(dataset);
        if (!timeKey) {
          return reply.code(400).send({
            message: "数据集缺少时间列：请将一个字段标记为 datetime 类型，或命名为 timestamp/time/recorded_at，才能构建回放时间轴",
          });
        }
        let rows: Array<Record<string, unknown>>;
        try {
          rows = await readRows(dependencies.config, connection, dataset);
        } catch (error) {
          return reply.code(502).send({ message: `读取数据集失败：${error instanceof Error ? error.message : String(error)}` });
        }
        const entries = finalizeEntries(
          rows.flatMap((row) => toEntry(row, timeKey) ?? []),
          windowMs,
          maxEntries,
        );
        if (entries.length === 0) {
          return reply.code(400).send({ message: "数据集没有可回放的时间序列数值行：请检查时间列取值与数值字段" });
        }
        return { revision: `dataset:${dataset.id}@${dataset.updatedAt}`, entries } satisfies DataReplayPayload;
      }

      const events = dependencies.bus.latest(projectId);
      const entries = finalizeEntries(entriesFromEvents(events), windowMs, maxEntries);
      if (entries.length === 0) {
        return reply.code(400).send({ message: "项目暂无可回放的数据事件：请先通过数据事件 API 或 MQTT 持续摄取产生数据" });
      }
      return {
        revision: `events:${events.length}:${events[events.length - 1]?.id ?? ""}`,
        entries,
      } satisfies DataReplayPayload;
    },
  );
}

function parseWindowMs(value: string | undefined): number | undefined | null {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveTimeKey(dataset: DataDatasetRecord): string | undefined {
  return dataset.fields.find((field) => field.type === "datetime")?.key
    ?? dataset.fields.find((field) => TIME_KEY_PATTERN.test(field.key))?.key;
}

/** 一行 → 一个时间轴条目；时间列无法解析或没有数值列的行如实跳过。 */
function toEntry(row: Record<string, unknown>, timeKey: string): ReplayTimelineEntry | undefined {
  const at = Date.parse(String(row[timeKey]));
  if (!Number.isFinite(at)) return undefined;
  const values: Record<string, number> = {};
  for (const [key, item] of Object.entries(row)) {
    if (key !== timeKey && typeof item === "number" && Number.isFinite(item)) values[key] = item;
  }
  return Object.keys(values).length > 0 ? { at, values } : undefined;
}

function entriesFromEvents(events: DataEvent[]): ReplayTimelineEntry[] {
  const byAt = new Map<number, ReplayTimelineEntry>();
  for (const event of events) {
    if (event.source === ALERT_EVENT_SOURCE) continue;
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at)) continue;
    const entry = byAt.get(at) ?? { at, values: {} };
    const value = event.value;
    if (typeof value === "number" && Number.isFinite(value)) {
      entry.values[event.key] = value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [name, item] of Object.entries(value)) {
        if (typeof item === "number" && Number.isFinite(item)) entry.values[`${event.key}.${name}`] = item;
      }
    }
    byAt.set(at, entry);
  }
  return [...byAt.values()];
}

/** 排序、同刻保留最后写入（与前端 normalizeTimeline 语义一致）、按窗口截取、封顶最近 maxEntries 条。 */
function finalizeEntries(entries: ReplayTimelineEntry[], windowMs: number | undefined, maxEntries: number): ReplayTimelineEntry[] {
  const byAt = new Map<number, ReplayTimelineEntry>();
  for (const entry of entries) byAt.set(entry.at, entry);
  const sorted = [...byAt.values()].sort((left, right) => left.at - right.at);
  if (sorted.length === 0) return sorted;
  const windowed = windowMs === undefined ? sorted : sorted.filter((entry) => entry.at >= sorted[sorted.length - 1]!.at - windowMs);
  return windowed.slice(-maxEntries);
}
