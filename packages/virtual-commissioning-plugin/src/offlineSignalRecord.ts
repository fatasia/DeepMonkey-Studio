import type { DataSubscriptionGapReport, DataSubscriptionStatus, VirtualDebugCommand, VirtualDebugScenario } from "@bim-studio/contracts";

/** dataReplay 的只读结构投影；不保存第二份数据、不修改确定性仿真内核。 */
export interface OfflineReplaySource {
  revision: string;
  entries: readonly { at: number; values: Readonly<Record<string, number>> }[];
}

export interface OfflineSignalRecord {
  revision: string;
  origin: "dataset" | "retained-events";
  /** 数据集预览和总线最近 200 条都不保证全量；本字段永不伪造 complete。 */
  coverage: "unknown" | "gap-detected";
  sequenceSemantics: "source" | "estimated" | "unknown";
  /** 既有 DataEvent/数据集回放未携带 OPC UA 质量码，不推断 Good。 */
  signalQuality: "unknown";
  samples: readonly { at: number; values: Readonly<Record<string, number>>; quality: "unknown" }[];
  gaps: readonly DataSubscriptionGapReport[];
  checkpoint: null | Pick<DataSubscriptionStatus, "connectionId" | "generation" | "lastSequence" | "lastTimestamp" | "lifecycle">;
}

export function describeOfflineReplay(input: {
  timeline: OfflineReplaySource;
  origin: OfflineSignalRecord["origin"];
  /** MQTT 已验证源序列用 source，OPC UA 时间戳推导用 estimated；不明来源用 unknown。 */
  sequenceSemantics?: OfflineSignalRecord["sequenceSemantics"];
  status?: DataSubscriptionStatus | null;
}): OfflineSignalRecord {
  const { timeline, status } = input;
  if (!timeline.revision.trim()) throw new Error("离线记录缺少回放 revision，请重新读取数据源");
  const sorted = new Map<number, { at: number; values: Record<string, number>; quality: "unknown" }>();
  let previousAt = -1;
  for (const entry of timeline.entries) {
    if (!Number.isSafeInteger(entry.at) || entry.at < 0) throw new Error("离线记录包含非法时间戳，请修复源时间列");
    if (entry.at < previousAt) throw new Error("离线记录时间倒退，请先按源时间排序并核对时钟");
    previousAt = entry.at;
    if (!entry.values || Object.keys(entry.values).length === 0) throw new Error("离线记录包含空信号帧，请检查数据集数值列");
    if (sorted.has(entry.at)) throw new Error("离线记录包含同刻重复帧，请先明确合并规则再回放");
    const values: Record<string, number> = {};
    for (const [key, value] of Object.entries(entry.values)) {
      if (!key.trim() || !Number.isFinite(value)) throw new Error("离线记录包含非法信号值，请检查数据集数值列");
      values[key] = value;
    }
    sorted.set(entry.at, { at: entry.at, values, quality: "unknown" });
  }
  const gaps = status?.gapReports.map((gap) => ({ ...gap })) ?? [];
  return {
    revision: timeline.revision,
    origin: input.origin,
    coverage: gaps.length > 0 || (status?.gapReportsTruncated ?? 0) > 0 ? "gap-detected" : "unknown",
    sequenceSemantics: input.sequenceSemantics ?? "unknown",
    signalQuality: "unknown",
    samples: [...sorted.values()],
    gaps,
    checkpoint: status ? {
      connectionId: status.connectionId,
      generation: status.generation,
      lastSequence: status.lastSequence,
      lastTimestamp: status.lastTimestamp,
      lifecycle: status.lifecycle,
    } : null,
  };
}

/** 仅转换信号输入；场景仍由既有 runVirtualDebugScenario 运行，缺口/未知质量留在 record 证据中。 */
export function offlineReplayToScenario(record: OfflineSignalRecord, scenarioId: string, tickMs = 50): VirtualDebugScenario {
  if (!scenarioId.trim()) throw new Error("虚拟调试场景 id 不能为空");
  if (!Number.isSafeInteger(tickMs) || tickMs < 1 || tickMs > 10_000) throw new Error("虚拟调试 tickMs 必须在 1 至 10000 之间");
  const first = record.samples[0];
  if (!first) throw new Error("离线记录没有可回放信号，请先取得带时间列的数值数据");
  const last = record.samples.at(-1)!;
  const durationMs = Math.max(tickMs, last.at - first.at);
  if (durationMs > 86_400_000 || durationMs % tickMs !== 0) throw new Error("记录跨度超过 24 小时或信号时间未对齐 tickMs；请按源时间分段/重采样，不得静默舍弃样本");
  const commands: VirtualDebugCommand[] = [];
  for (const frame of record.samples.slice(1)) {
    const atMs = frame.at - first.at;
    if (atMs % tickMs !== 0) throw new Error("信号时间未对齐 tickMs；请显式重采样，不得静默舍弃样本");
    for (const [key, value] of Object.entries(frame.values)) commands.push({ atMs, type: "set", key, value });
  }
  return { id: scenarioId, durationMs, tickMs, initialSignals: { ...first.values }, commands };
}
