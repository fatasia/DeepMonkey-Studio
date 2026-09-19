import { useCallback, useEffect, useState } from "react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { TimelineReplay } from "../alerting/timelineReplay";

// P4 UI 呈现切片:时序回放面板。数据源 = API /data/replay(结构即 TimelineEntry);
// 播放头/倍速/阶跃语义全部复用 TimelineReplay 核心,不另建第二套回放逻辑。

export interface ReplayPanelSignal {
  key: string;
  label: string;
}

export function DataReplayPanel({ projectId, apiOrigin, authHeaders, signals, locale, initialWindowMs = 3600_000 }: {
  projectId: string;
  apiOrigin: string;
  authHeaders: Record<string, string>;
  /** 展示哪些信号(key 与标签);空数组 = 展示回放里的全部 key。 */
  signals: ReplayPanelSignal[];
  locale: AppLocale;
  initialWindowMs?: number;
}) {
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState<string | undefined>();
  const [entries, setEntries] = useState<Array<{ at: number; values: Record<string, number> }>>([]);
  const [replay, setReplay] = useState<TimelineReplay | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${apiOrigin}/api/projects/${projectId}/data/replay?windowMs=${initialWindowMs}`, { headers: authHeaders });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `回放数据加载失败(${response.status})`);
      }
      const body = (await response.json()) as { revision: string; entries: Array<{ at: number; values: Record<string, number> }> };
      const instance = new TimelineReplay({ revision: body.revision, entries: body.entries });
      instance.play(1);
      setRevision(body.revision);
      setEntries(body.entries);
      setReplay(instance);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [apiOrigin, projectId, authHeaders, initialWindowMs]);

  useEffect(() => { void load(); }, [load]);

  // 播放头推进:真实时钟,每 250ms 步进一次(回放语义,非渲染帧)。
  useEffect(() => {
    if (!replay?.clock.playing) return;
    const handle = window.setInterval(() => setTick((value) => value + 1), 250);
    return () => window.clearInterval(handle);
  }, [replay?.clock.playing, replay]);

  void tick; // 播放头推进后强制重渲染。
  const sample = replay ? replay.advance(replay.clock.playing ? 250 : 0) : null;
  const displayKeys = signals.length > 0
    ? signals
    : Object.keys(sample?.values ?? {}).map((key) => ({ key, label: key }));

  return <section className="data-replay-panel" aria-label={tr(locale, "时序回放", "Timeline replay")}>
    <header className="data-replay-panel__header">
      <h3>{tr(locale, "时序回放", "Timeline replay")}</h3>
      {revision && <span className="data-replay-panel__revision">{revision}</span>}
      <button type="button" onClick={() => void load()} disabled={loading}>{loading ? tr(locale, "加载中…", "Loading…") : tr(locale, "重载", "Reload")}</button>
    </header>
    {error && <p role="alert" className="data-replay-panel__error">{error}</p>}
    {!replay || replay.isEmpty
      ? <p className="data-replay-panel__empty">{tr(locale, "暂无可回放数据。", "No replay data.")}</p>
      : <div className="data-replay-panel__body">
        <div className="data-replay-panel__controls">
          <button type="button" onClick={() => replay.clock.playing ? replay.pause() : replay.play(1)}>
            {replay.clock.playing ? tr(locale, "暂停", "Pause") : tr(locale, "播放", "Play")}
          </button>
          {[1, 4, 16].map((speed) => (
            <button key={speed} type="button" data-active={replay.clock.speed === speed || undefined}
              onClick={() => replay.play(speed)}>{speed}×</button>
          ))}
          <span className="data-replay-panel__clock">{new Date(replay.clock.playheadMs).toLocaleString()}</span>
        </div>
        <ul className="data-replay-panel__values">
          {displayKeys.map(({ key, label }) => (
            <li key={key}><small>{label}</small><strong>{sample?.values[key] ?? "—"}</strong></li>
          ))}
        </ul>
      </div>}
  </section>;
}

/** 从 TimelineEntry 序列构建面板所需的信号清单(供调用方传入 signals)。 */
export function signalsFromEntries(entries: Array<{ at: number; values: Record<string, number> }>): Array<{ key: string; label: string }> {
  const keys = new Set<string>();
  for (const entry of entries) for (const key of Object.keys(entry.values)) keys.add(key);
  return [...keys].map((key) => ({ key, label: key }));
}
