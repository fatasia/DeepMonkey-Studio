import type { BehaviorTraceEntry } from "./behaviorTraceLog";

/**
 * S2d Play 会话行为轨迹仓(T31 日志的会话级聚合)。
 *
 * restrictedPlayConsumer 的 onTrace 每次 回调 给出「单个脚本的运行时全量快照」
 * (环形缓冲 snapshot(),旧→新)。本仓按 scriptId 收纳各脚本的最新快照,展开成
 * 一条确定性总序(atMs → scriptId → seq),供行为轨迹回放审阅器只读消费。
 *
 * 口径纪律:
 * - 本仓只是聚合视图,不生产、不改写条目;真值仍是各运行时的 BehaviorTraceLog。
 * - 展开排序只用条目自身的确定性字段,不读墙钟;同输入 → 同展开(可逐字段比对)。
 * - 版本号节流通知(尾沿合并):Play 高频派发下审阅器不会被每次快照打爆。
 */

/** 单脚本轨迹源:entries 是该脚本运行时的全量快照(旧→新)。 */
export interface PlayTraceSource {
  readonly scriptId: string;
  readonly entries: readonly BehaviorTraceEntry[];
}

/** 轨迹仓状态:不可变,apply/reset 返回新状态。 */
export interface PlayTraceState {
  /** 会话标识(进入 Play 时刻由宿主给定;undefined = 尚无会话)。 */
  readonly sessionId: string | undefined;
  /** 按 scriptId 收纳的最新快照;数组保持首次出现序(展示稳定)。 */
  readonly sources: readonly PlayTraceSource[];
  /** 全部条目的确定性总序(atMs → scriptId → seq)。 */
  readonly flattened: readonly BehaviorTraceEntry[];
  /** 单调版本号:任何状态变化 +1。 */
  readonly version: number;
}

export const PLAY_TRACE_FORMAT = "bim-studio/behavior-trace/v1";

export function emptyPlayTraceState(): PlayTraceState {
  return { sessionId: undefined, sources: [], flattened: [], version: 0 };
}

/** 确定性展开:同一组源,任意收纳顺序 → 同一条总序。 */
export function flattenTraceSources(sources: readonly PlayTraceSource[]): BehaviorTraceEntry[] {
  const flat: BehaviorTraceEntry[] = [];
  for (const source of sources) flat.push(...source.entries);
  return flat.sort((a, b) => a.atMs - b.atMs || (a.graphId < b.graphId ? -1 : a.graphId > b.graphId ? 1 : a.seq - b.seq));
}

/** 收纳一个脚本的全量快照(同脚本替换,不追加);源序保持首次出现序。 */
export function applyTraceSnapshot(
  state: PlayTraceState,
  scriptId: string,
  entries: readonly BehaviorTraceEntry[],
): PlayTraceState {
  const sources = state.sources.some((source) => source.scriptId === scriptId)
    ? state.sources.map((source) => (source.scriptId === scriptId ? { scriptId, entries } : source))
    : [...state.sources, { scriptId, entries }];
  return { ...state, sources, flattened: flattenTraceSources(sources), version: state.version + 1 };
}

/** 开启新会话:清空全部脚本源,换会话标识(版本号仍单调,订阅者据此重渲染)。 */
export function resetTraceSession(state: PlayTraceState, sessionId: string): PlayTraceState {
  return { sessionId, sources: [], flattened: [], version: state.version + 1 };
}

/**
 * 轨迹 JSON 导出文档。字段按字典序排列的确定性序列化(T17/T28 导出纪律):
 * 体内容不含导出时刻墙钟;sessionId 是被审计会话的进入标识,属于会话事实。
 */
export function exportPlayTraceDocument(state: PlayTraceState, extraSources?: readonly PlayTraceSource[]): string {
  const sources = extraSources?.length ? [...state.sources, ...extraSources] : state.sources;
  return stableTraceStringify({
    entryCount: sources.reduce((total, source) => total + source.entries.length, 0),
    format: PLAY_TRACE_FORMAT,
    sessionId: state.sessionId ?? null,
    sourceCount: sources.length,
    sources: sources.map((source) => ({ entries: source.entries, scriptId: source.scriptId })),
  });
}

/** 键字典序确定性序列化(与 behaviorTraceLog 的摘要口径同族,独立导出用)。 */
export function stableTraceStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableTraceStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableTraceStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 通知节流间隔:Play 高频派发下,审阅器重渲染上限 ≈4 次/秒(尾沿合并,不丢最终态)。 */
export const TRACE_NOTIFY_INTERVAL_MS = 250;

interface PlayTraceStore {
  /** 开启新会话(进入 Play 时调用;清空上一会话轨迹)。 */
  resetPlayTrace(sessionId: string): void;
  /** 收纳一个脚本的全量快照(onTrace 回调直连)。 */
  recordPlayTrace(scriptId: string, entries: readonly BehaviorTraceEntry[]): void;
  getPlayTraceState(): PlayTraceState;
  subscribePlayTrace(listener: () => void): () => void;
}

/** 模块级单例:App(生产者,onTrace)与审阅器(消费者)零 prop 穿透共享。 */
export function createPlayTraceStore(notifyIntervalMs = TRACE_NOTIFY_INTERVAL_MS): PlayTraceStore {
  let state: PlayTraceState = emptyPlayTraceState();
  const listeners = new Set<() => void>();
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;

  function flushNotify(): void {
    notifyTimer = undefined;
    for (const listener of listeners) listener();
  }

  function scheduleNotify(): void {
    // 尾沿节流:窗口内的任意多次快照合并为一次通知(≤4 次/秒),最终态必达。
    // 无订阅者时不排程(生产者在 Play 中持续写,审阅器挂载后再见最新状态)。
    if (notifyTimer !== undefined || listeners.size === 0) return;
    notifyTimer = setTimeout(flushNotify, notifyIntervalMs);
  }

  return {
    resetPlayTrace(sessionId) {
      state = resetTraceSession(state, sessionId);
      scheduleNotify();
    },
    recordPlayTrace(scriptId, entries) {
      state = applyTraceSnapshot(state, scriptId, entries);
      scheduleNotify();
    },
    getPlayTraceState() {
      return state;
    },
    subscribePlayTrace(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && notifyTimer !== undefined) {
          clearTimeout(notifyTimer);
          notifyTimer = undefined;
        }
      };
    },
  };
}

/** 生产单例:App 进入 Play 时 reset,onTrace 时 record;审阅器 useSyncExternalStore 消费。 */
export const playTraceStore = createPlayTraceStore();
