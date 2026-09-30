export const PLAY_RESTORE_MEASURE = "deep-studio:play-restore";
export type PlayRestoreStage = "capture" | "plan" | "apply-full" | "apply-incremental" | "verify";
export type PlayRestoreTimeline = Pick<Performance, "now" | "measure" | "clearMeasures">;
export interface PlayRestoreTimingReceipt {
  readonly sceneId: string;
  readonly path: "none" | "full" | "incremental";
  readonly status: "passed" | "failed";
  readonly degraded: boolean;
  readonly durationMs: number;
  readonly stages: Readonly<Partial<Record<PlayRestoreStage, number>>>;
  readonly failedStage?: PlayRestoreStage;
}

/** Uses the existing browser Performance clock/timeline, once per restore. */
export function beginPlayRestoreTiming(sceneId: string, timeline: PlayRestoreTimeline = performance) {
  const started = timeline.now();
  const stages: Partial<Record<PlayRestoreStage, number>> = {};
  let failedStage: PlayRestoreStage | undefined;
  const sync = <T>(stage: PlayRestoreStage, action: () => T): T => {
    const begin = timeline.now();
    try { return action(); }
    catch (error) { failedStage = stage; throw error; }
    finally { stages[stage] = Math.max(0, timeline.now() - begin); }
  };
  const asyncStage = async <T>(stage: PlayRestoreStage, action: () => Promise<T>): Promise<T> => {
    const begin = timeline.now();
    try { return await action(); }
    catch (error) { failedStage = stage; throw error; }
    finally { stages[stage] = Math.max(0, timeline.now() - begin); }
  };
  const finish = (path: PlayRestoreTimingReceipt["path"], status: PlayRestoreTimingReceipt["status"], degraded: boolean) => {
    const ended = timeline.now();
    const receipt: PlayRestoreTimingReceipt = Object.freeze({ sceneId, path, status, degraded,
      durationMs: Math.max(0, ended - started), stages: Object.freeze({ ...stages }),
      ...(failedStage === undefined ? {} : { failedStage }) });
    try {
      // Only this diagnostic's previous entry is replaced; other app spans stay intact.
      timeline.clearMeasures(PLAY_RESTORE_MEASURE);
      timeline.measure(PLAY_RESTORE_MEASURE, { start: started, end: ended, detail: receipt });
    } catch { /* Browser diagnostics must not reject scene recovery. */ }
    return receipt;
  };
  return { sync, async: asyncStage, finish };
}
