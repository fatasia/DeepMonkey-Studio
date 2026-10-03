import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight, Download } from "lucide-react";
import type { BehaviorTraceEntry } from "../scripting/behaviorTraceLog";
import { exportPlayTraceDocument, playTraceStore, type PlayTraceSource } from "../scripting/playTraceStore";
import { translate as tr, type AppLocale } from "../i18n";
import type { ViewerEngine } from "../viewer/ViewerEngine";

/**
 * S2d 确定性回放审阅器(§2.4:回放面板 = 审阅器,不是第二运行时)。
 *
 * 真值 = T31 行为轨迹(Play 会话 restrictedPlayConsumer.onTrace 聚合于 playTraceStore,
 * 以及引擎动画事件轨迹 snapshotModelAnimationEventTrace)。本组件只读:时间轴 scrub、
 * 逐条步进、before/after 摘要、outcome 徽标、轨迹 JSON 导出(T17/T28 纪律)。
 * 回放不写场景状态;「重演」语义是重开 Play 会话,不经本面板。
 */

/** 单轨道标记显示上限:超出按均匀步长抽稀(数据完整,仅显示采样),4k 条也不卡。 */
const MAX_MARKERS_PER_TRACK = 160;

interface TraceKey {
  scriptId: string;
  seq: number;
}

interface DisplaySource {
  readonly scriptId: string;
  readonly label: string;
  readonly entries: BehaviorTraceEntry[];
}

const OUTCOME_CLASS = { applied: "is-applied", skipped: "is-skipped", rejected: "is-rejected" } as const;

const OUTCOME_LABEL = {
  applied: { zh: "已执行", en: "applied" },
  skipped: { zh: "已跳过", en: "skipped" },
  rejected: { zh: "已拒绝", en: "rejected" },
} as const;

export function BehaviorTraceReplay({ locale, engine }: { locale: AppLocale; engine?: ViewerEngine | undefined }) {
  const traceState = useSyncExternalStore(playTraceStore.subscribePlayTrace, playTraceStore.getPlayTraceState, playTraceStore.getPlayTraceState);
  // 引擎动画事件轨迹不是订阅式:随轨迹仓版本与 1s 心跳刷新(Play 中持续产生时保持新鲜)。
  const [animationTick, setAnimationTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setAnimationTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const animationEntries = useMemo<BehaviorTraceEntry[]>(
    () => engine?.snapshotModelAnimationEventTrace() ?? [],
    // engine 是稳定引用;动画事件快照随会话推进,以轨迹版本与心跳为刷新依赖。
    [engine, traceState.version, animationTick],
  );

  const sources = useMemo<DisplaySource[]>(() => {
    const list: DisplaySource[] = traceState.sources.map((source: PlayTraceSource) => ({
      scriptId: source.scriptId,
      label: source.entries[0]?.graphId ?? source.scriptId,
      entries: [...source.entries],
    }));
    if (animationEntries.length > 0) {
      list.push({ scriptId: animationEntries[0]!.graphId, label: animationEntries[0]!.graphId, entries: animationEntries });
    }
    return list;
  }, [traceState.sources, animationEntries]);

  const flattened = useMemo(() => sources.flatMap((source) => source.entries).sort(compareEntries), [sources]);

  const timeDomain = useMemo(() => {
    if (flattened.length === 0) return { min: 0, max: 0, degenerate: true };
    const times = flattened.map((entry) => entry.atMs);
    const min = Math.min(...times);
    const max = Math.max(...times);
    // 全零/等值时间域(纯交互驱动、无 tick 的会话):退化为按总序定位,scrub/步进仍可用。
    return { min, max, degenerate: max - min <= 0 };
  }, [flattened]);

  const [selected, setSelected] = useState<TraceKey | undefined>(undefined);
  const [followLatest, setFollowLatest] = useState(true);
  const selectedIndex = selected ? flattened.findIndex((entry) => entry.graphId === selected.scriptId && entry.seq === selected.seq) : -1;
  const effectiveIndex = selectedIndex >= 0 ? selectedIndex : flattened.length - 1;
  // 跟随最新:未手动选择(或重新开启跟随)时审阅头始终停在最新一条。
  useEffect(() => {
    if (!followLatest || flattened.length === 0) return;
    const last = flattened[flattened.length - 1]!;
    setSelected({ scriptId: last.graphId, seq: last.seq });
  }, [followLatest, flattened]);

  const selectedEntry = effectiveIndex >= 0 ? flattened[effectiveIndex] : undefined;

  function pick(key: TraceKey): void {
    setFollowLatest(false);
    setSelected(key);
  }

  function step(delta: 1 | -1): void {
    const next = Math.min(flattened.length - 1, Math.max(0, effectiveIndex + delta));
    const entry = flattened[next];
    if (!entry) return;
    setFollowLatest(false);
    setSelected({ scriptId: entry.graphId, seq: entry.seq });
  }

  function jumpToLatest(): void {
    setFollowLatest(true);
    const last = flattened[flattened.length - 1];
    if (last) setSelected({ scriptId: last.graphId, seq: last.seq });
  }

  function scrubTo(fraction: number): void {
    if (flattened.length === 0) return;
    const clamped = Math.min(1, Math.max(0, fraction));
    let index: number;
    if (timeDomain.degenerate) {
      index = Math.round(clamped * (flattened.length - 1));
    } else {
      const target = timeDomain.min + clamped * (timeDomain.max - timeDomain.min);
      index = nearestIndexByTime(flattened, target);
    }
    const entry = flattened[index];
    if (!entry) return;
    setFollowLatest(false);
    setSelected({ scriptId: entry.graphId, seq: entry.seq });
  }

  function exportTraceJson(): void {
    const extra: PlayTraceSource[] | undefined = animationEntries.length > 0
      ? [{ scriptId: animationEntries[0]!.graphId, entries: animationEntries }]
      : undefined;
    const blob = new Blob([exportPlayTraceDocument(traceState, extra)], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `behavior-trace-${(traceState.sessionId ?? "session").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 22)}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  const entryRatio = (entry: BehaviorTraceEntry): number => {
    if (timeDomain.degenerate || flattened.length <= 1) {
      const index = flattened.indexOf(entry);
      return flattened.length <= 1 ? 0 : index / (flattened.length - 1);
    }
    return (entry.atMs - timeDomain.min) / (timeDomain.max - timeDomain.min);
  };
  const playheadPercent = selectedEntry ? `${(entryRatio(selectedEntry) * 100).toFixed(3)}%` : undefined;

  return (
    <div className="trace-replay" aria-label={tr(locale, "行为轨迹回放", "Behavior trace replay")}>
      <div className="trace-replay-summary">
        <span>{tr(locale, `条目 ${flattened.length}`, `${flattened.length} entries`)}</span>
        <span>{tr(locale, `来源 ${sources.length}`, `${sources.length} sources`)}</span>
        <span>{timeDomain.degenerate ? tr(locale, "顺序域", "seq order") : `${(timeDomain.max / 1000).toFixed(2)}s`}</span>
        <button
          type="button"
          className={`trace-replay-follow ${followLatest ? "active" : ""}`}
          onClick={jumpToLatest}
          title={tr(locale, "审阅头跟随最新条目", "Playhead follows the latest entry")}
        >
          {tr(locale, "跟随最新", "Follow latest")}
        </button>
        <button type="button" className="trace-replay-export" disabled={flattened.length === 0} onClick={exportTraceJson}>
          <Download size={12} />
          {tr(locale, "导出 JSON", "Export JSON")}
        </button>
      </div>

      {flattened.length === 0 ? (
        <div className="trace-replay-empty">
          <strong>{tr(locale, "尚未产生行为轨迹", "No behavior trace yet")}</strong>
          <small>{tr(locale, "进入播放并触发行为（定时 tick、数据变化、交互事件）后，本面板成为只读审阅器；回放不写场景状态。", "Enter Play and trigger behaviors (timer tick, data change, interaction) to review; replay never writes scene state.")}</small>
        </div>
      ) : (
        <>
          <div className="trace-replay-body">
            <div className="trace-replay-tracks">
              <div className="trace-replay-ruler" aria-hidden="true">
                <span>{tr(locale, "来源", "Source")}</span>
                <div className="trace-replay-ruler-rail">
                  {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
                    <i key={ratio} style={{ left: `${ratio * 100}%` }}>
                      {timeDomain.degenerate ? "" : `${((timeDomain.max - timeDomain.min) * ratio / 1000).toFixed(1)}s`}
                    </i>
                  ))}
                </div>
              </div>
              {sources.map((source) => {
                const sampled = sampleEntries(source.entries, MAX_MARKERS_PER_TRACK);
                return (
                  <div className="trace-replay-track" key={source.scriptId}>
                    <span className="trace-replay-track-label" title={source.scriptId}>
                      {source.label}
                      <small>{source.entries.length}</small>
                    </span>
                    <div
                      className="trace-replay-rail"
                      role="slider"
                      aria-label={tr(locale, `拖动定位行为轨迹:${source.label}`, `Scrub behavior trace: ${source.label}`)}
                      aria-valuemin={0}
                      aria-valuemax={flattened.length - 1}
                      aria-valuenow={effectiveIndex}
                      tabIndex={0}
                      onPointerDown={(event) => {
                        const rail = event.currentTarget.getBoundingClientRect();
                        if (rail.width <= 0) return;
                        scrubTo((event.clientX - rail.left) / rail.width);
                        const move = (pointer: PointerEvent) => scrubTo((pointer.clientX - rail.left) / rail.width);
                        const stop = () => {
                          window.removeEventListener("pointermove", move);
                          window.removeEventListener("pointerup", stop);
                          window.removeEventListener("pointercancel", stop);
                        };
                        window.addEventListener("pointermove", move);
                        window.addEventListener("pointerup", stop, { once: true });
                        window.addEventListener("pointercancel", stop, { once: true });
                      }}
                    >
                      <i className="trace-replay-line" />
                      {sampled.decimated && <small className="trace-replay-sampled">{tr(locale, `按 1/${sampled.stride} 采样显示`, `1/${sampled.stride} sampled view`)}</small>}
                      {sampled.entries.map((entry) => {
                        const isSelected = selected?.scriptId === source.scriptId && selected?.seq === entry.seq;
                        return (
                          <button
                            key={entry.seq}
                            type="button"
                            className={`trace-replay-marker is-${entry.outcome} ${isSelected ? "selected" : ""}`}
                            style={{ left: `${(entryRatio(entry) * 100).toFixed(3)}%` }}
                            title={`${entryLabel(locale, entry)}`}
                            aria-label={entryLabel(locale, entry)}
                            onClick={(event) => {
                              event.stopPropagation();
                              pick({ scriptId: source.scriptId, seq: entry.seq });
                            }}
                          />
                        );
                      })}
                      {playheadPercent && source.entries.some((entry) => entry.graphId === selectedEntry?.graphId) && (
                        <i className="trace-replay-playhead" style={{ left: playheadPercent }} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <aside className="trace-replay-detail" aria-label={tr(locale, "轨迹条目详情", "Trace entry detail")}>
              {selectedEntry ? (
                <>
                  <header>
                    <span className={`trace-replay-outcome ${OUTCOME_CLASS[selectedEntry.outcome]}`}>{tr(locale, OUTCOME_LABEL[selectedEntry.outcome].zh, OUTCOME_LABEL[selectedEntry.outcome].en)}</span>
                    <small>
                      {tr(locale, "序号", "seq")} {selectedEntry.seq} · {(selectedEntry.atMs / 1000).toFixed(3)}s
                      {selected !== undefined && selectedIndex < 0 ? tr(locale, "（已被溢出丢弃，按最新审阅）", " (dropped by overflow, reviewing latest)") : ""}
                    </small>
                  </header>
                  <dl>
                    <div><dt>{tr(locale, "行为图", "graph")}</dt><dd>{selectedEntry.graphId}</dd></div>
                    <div><dt>{tr(locale, "事件节点", "event node")}</dt><dd>{selectedEntry.eventNodeId}</dd></div>
                    {selectedEntry.actionNodeId && <div><dt>{tr(locale, "动作节点", "action node")}</dt><dd>{selectedEntry.actionNodeId}</dd></div>}
                    {selectedEntry.action && <div><dt>{tr(locale, "动作", "action")}</dt><dd>{selectedEntry.action}</dd></div>}
                    {selectedEntry.target && <div><dt>{tr(locale, "目标", "target")}</dt><dd>{selectedEntry.target}</dd></div>}
                    {selectedEntry.before !== undefined && <div><dt>{tr(locale, "前值", "before")}</dt><dd><code>{selectedEntry.before}</code></dd></div>}
                    {selectedEntry.after !== undefined && <div><dt>{tr(locale, "后值", "after")}</dt><dd><code>{selectedEntry.after}</code></dd></div>}
                    {selectedEntry.reason && <div><dt>{tr(locale, "原因", "reason")}</dt><dd>{selectedEntry.reason}</dd></div>}
                  </dl>
                </>
              ) : (
                <p>{tr(locale, "选择或步进任意条目查看前后值与裁决。", "Select or step through entries to inspect before/after and outcome.")}</p>
              )}
            </aside>
          </div>
          <footer className="trace-replay-transport">
            <button type="button" className="trace-replay-step" aria-label={tr(locale, "第一条", "First entry")} disabled={effectiveIndex <= 0} onClick={() => { setFollowLatest(false); const entry = flattened[0]; if (entry) setSelected({ scriptId: entry.graphId, seq: entry.seq }); }}>
              <ChevronsLeft size={13} />
            </button>
            <button type="button" className="trace-replay-step" aria-label={tr(locale, "上一条", "Previous entry")} disabled={effectiveIndex <= 0} onClick={() => step(-1)}>
              <ChevronLeft size={13} />
            </button>
            <span className="trace-replay-position">{effectiveIndex + 1}/{flattened.length}</span>
            <button type="button" className="trace-replay-step" aria-label={tr(locale, "下一条", "Next entry")} disabled={effectiveIndex >= flattened.length - 1} onClick={() => step(1)}>
              <ChevronRight size={13} />
            </button>
            <button type="button" className="trace-replay-step" aria-label={tr(locale, "最后一条", "Last entry")} disabled={effectiveIndex >= flattened.length - 1} onClick={jumpToLatest}>
              <ChevronsRight size={13} />
            </button>
            <small>{tr(locale, "回放为只读审阅；重演请重新进入播放会话。", "Read-only review; to replay, start a new Play session.")}</small>
          </footer>
        </>
      )}
    </div>
  );
}

const EMPTY: BehaviorTraceEntry[] = [];

function compareEntries(a: BehaviorTraceEntry, b: BehaviorTraceEntry): number {
  return a.atMs - b.atMs || (a.graphId < b.graphId ? -1 : a.graphId > b.graphId ? 1 : a.seq - b.seq);
}

function nearestIndexByTime(entries: BehaviorTraceEntry[], target: number): number {
  let low = 0;
  let high = entries.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (entries[mid]!.atMs < target) low = mid + 1;
    else high = mid;
  }
  const before = entries[Math.max(0, low - 1)]!;
  const at = entries[low]!;
  return Math.abs(before.atMs - target) <= Math.abs(at.atMs - target) ? low - 1 : low;
}

/** 均匀步长抽稀:保留首尾条目,中间按 stride 取样;数据不删,只省 DOM。 */
function sampleEntries(entries: readonly BehaviorTraceEntry[], limit: number): { entries: BehaviorTraceEntry[]; stride: number; decimated: boolean } {
  if (entries.length <= limit) return { entries: [...entries], stride: 1, decimated: false };
  const stride = Math.ceil(entries.length / limit);
  const sampled: BehaviorTraceEntry[] = [];
  for (let index = 0; index < entries.length; index += stride) sampled.push(entries[index]!);
  const last = entries[entries.length - 1]!;
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return { entries: sampled, stride, decimated: true };
}

function entryLabel(locale: AppLocale, entry: BehaviorTraceEntry): string {
  const outcome = tr(locale, OUTCOME_LABEL[entry.outcome].zh, OUTCOME_LABEL[entry.outcome].en);
  const parts = [`#${entry.seq}`, `${(entry.atMs / 1000).toFixed(3)}s`, entry.action ?? "condition", outcome];
  if (entry.reason) parts.push(entry.reason);
  return parts.join(" · ");
}
