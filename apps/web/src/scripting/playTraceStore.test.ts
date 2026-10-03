import { afterEach, describe, expect, it, vi } from "vitest";
import type { BehaviorTraceEntry } from "./behaviorTraceLog";
import {
  PLAY_TRACE_FORMAT,
  applyTraceSnapshot,
  createPlayTraceStore,
  emptyPlayTraceState,
  exportPlayTraceDocument,
  flattenTraceSources,
  resetTraceSession,
  stableTraceStringify,
} from "./playTraceStore";

function entry(partial: Partial<BehaviorTraceEntry> & { seq: number }): BehaviorTraceEntry {
  return {
    atMs: 0,
    graphId: "graph-a",
    eventNodeId: "ev-1",
    action: "set-value",
    target: "temperature",
    before: "10",
    after: "80",
    outcome: "applied",
    ...partial,
  };
}

describe("play trace store core (S2d)", () => {
  it("keeps per-script latest snapshots in first-seen order and flattens deterministically", () => {
    let state = emptyPlayTraceState();
    state = applyTraceSnapshot(state, "script-1", [entry({ seq: 2, atMs: 40 }), entry({ seq: 1, atMs: 10 })]);
    state = applyTraceSnapshot(state, "script-2", [entry({ seq: 1, atMs: 20, graphId: "graph-b" })]);
    state = applyTraceSnapshot(state, "script-1", [entry({ seq: 3, atMs: 30 }), entry({ seq: 1, atMs: 10 })]);
    expect(state.sources.map((source) => source.scriptId)).toEqual(["script-1", "script-2"]);
    expect(state.sources[0]!.entries).toHaveLength(2); // 同脚本替换不追加
    // 确定性总序:atMs → graphId → seq;与收纳顺序无关。
    expect(state.flattened.map((item) => `${item.atMs}:${item.graphId}:${item.seq}`)).toEqual([
      "10:graph-a:1",
      "20:graph-b:1",
      "30:graph-a:3",
    ]);
    expect(state.version).toBe(3);
    // 收纳顺序不同 → 展开仍逐字段相等。
    let flipped = emptyPlayTraceState();
    flipped = applyTraceSnapshot(flipped, "script-2", [entry({ seq: 1, atMs: 20, graphId: "graph-b" })]);
    flipped = applyTraceSnapshot(flipped, "script-1", [entry({ seq: 3, atMs: 30 }), entry({ seq: 1, atMs: 10 })]);
    expect(flipped.flattened).toEqual(state.flattened);
  });

  it("reset clears all sources, keeps the version monotonic and records the session id", () => {
    let state = applyTraceSnapshot(emptyPlayTraceState(), "s", [entry({ seq: 1 })]);
    const versionBefore = state.version;
    state = resetTraceSession(state, "session-1");
    expect(state.sources).toEqual([]);
    expect(state.flattened).toEqual([]);
    expect(state.sessionId).toBe("session-1");
    expect(state.version).toBeGreaterThan(versionBefore);
  });

  it("exports a deterministic key-sorted document without wall clock", () => {
    let state = resetTraceSession(emptyPlayTraceState(), "session-1");
    state = applyTraceSnapshot(state, "script-1", [entry({ seq: 1, atMs: 10 }), entry({ seq: 2, atMs: 20, outcome: "rejected", reason: "预算耗尽" })]);
    const first = exportPlayTraceDocument(state);
    const second = exportPlayTraceDocument(applyTraceSnapshot(state, "script-1", [entry({ seq: 1, atMs: 10 }), entry({ seq: 2, atMs: 20, outcome: "rejected", reason: "预算耗尽" })]));
    expect(first).toBe(second); // 同输入同导出(可逐字节比对)
    const parsed = JSON.parse(first) as { format: string; sessionId: string; entryCount: number; sourceCount: number };
    expect(parsed.format).toBe(PLAY_TRACE_FORMAT);
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.entryCount).toBe(2);
    expect(parsed.sourceCount).toBe(1);
    expect(first.indexOf('"format"')).toBeLessThan(first.indexOf('"sources"')); // 键字典序
    // 附加源(动画事件轨迹)只进导出体,不污染仓状态。
    const withExtra = JSON.parse(exportPlayTraceDocument(state, [{ scriptId: "animation:m-1", entries: [entry({ seq: 1, graphId: "animation:m-1" })] }])) as { entryCount: number; sourceCount: number };
    expect(withExtra.entryCount).toBe(3);
    expect(withExtra.sourceCount).toBe(2);
    expect(state.sources).toHaveLength(1);
  });

  it("stableTraceStringify sorts nested object keys and preserves arrays order", () => {
    expect(stableTraceStringify({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  });

  it("notifies subscribers with trailing throttling and keeps the latest state reachable", () => {
    vi.useFakeTimers();
    const store = createPlayTraceStore(250);
    const seen: number[] = [];
    const unsubscribe = store.subscribePlayTrace(() => seen.push(store.getPlayTraceState().version));
    store.resetPlayTrace("session-1");
    store.recordPlayTrace("s", [entry({ seq: 1 })]);
    store.recordPlayTrace("s", [entry({ seq: 1 }), entry({ seq: 2 })]);
    expect(seen).toEqual([]); // 窗口内合并,不逐条打扰
    vi.advanceTimersByTime(260);
    expect(seen).toEqual([3]); // reset+两次收纳合并为尾沿一次,状态是最终态
    // 无订阅者时不排程定时器(Play 高频写不积累回调);onTrace 是全量快照替换语义。
    unsubscribe();
    store.recordPlayTrace("s", [entry({ seq: 1 }), entry({ seq: 2 }), entry({ seq: 3 })]);
    vi.advanceTimersByTime(1_000);
    expect(store.getPlayTraceState().flattened).toHaveLength(3);
    expect(seen).toEqual([3]);
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe("flattenTraceSources pure ordering", () => {
  it("orders by atMs then graphId then seq across sources", () => {
    const flat = flattenTraceSources([
      { scriptId: "b", entries: [entry({ seq: 1, atMs: 5, graphId: "g-b" })] },
      { scriptId: "a", entries: [entry({ seq: 9, atMs: 5, graphId: "g-a" }), entry({ seq: 1, atMs: 1, graphId: "g-a" })] },
    ]);
    expect(flat.map((item) => `${item.atMs}:${item.graphId}:${item.seq}`)).toEqual(["1:g-a:1", "5:g-a:9", "5:g-b:1"]);
  });
});
