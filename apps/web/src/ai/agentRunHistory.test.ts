import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_HISTORY_LIMIT,
  AGENT_RUN_STALE_AFTER_MS,
  AGENT_RUN_HISTORY_KEY_PREFIX,
  LEGACY_AGENT_RUN_KEY_PREFIX,
  createAgentRunHistoryStore,
  isStaleAgentRunEntry,
  isStaleCheckpoint,
  readLegacyRunId,
  type AgentRunHistoryEntry,
} from "./agentRunHistory";

function memoryStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    peek: (key: string) => map.get(key),
  };
}

const PROJECT = "project-1";
const HISTORY_KEY = `${AGENT_RUN_HISTORY_KEY_PREFIX}${PROJECT}`;
const LEGACY_KEY = `${LEGACY_AGENT_RUN_KEY_PREFIX}${PROJECT}`;

function entry(runId: string, overrides: Partial<AgentRunHistoryEntry> = {}): AgentRunHistoryEntry {
  return { runId, objective: `目标 ${runId}`, savedAt: "2026-10-01T10:00:00.000Z", ...overrides };
}

describe("agentRunHistory（H-C5-K13 多运行本地历史）", () => {
  it("空存储读取得到空列表", () => {
    expect(createAgentRunHistoryStore(memoryStorage()).list(PROJECT)).toEqual([]);
  });

  it("remember 最近在前；超出上限滚动逐出最旧", () => {
    const storage = memoryStorage();
    const store = createAgentRunHistoryStore(storage);
    for (let i = 0; i < AGENT_RUN_HISTORY_LIMIT + 2; i += 1) {
      store.remember(PROJECT, entry(`run-${i}`));
    }
    const runs = store.list(PROJECT);
    expect(runs).toHaveLength(AGENT_RUN_HISTORY_LIMIT);
    expect(runs[0]!.runId).toBe(`run-${AGENT_RUN_HISTORY_LIMIT + 1}`);
    expect(runs.at(-1)!.runId).toBe(`run-2`);
  });

  it("同 runId 再次 remember 是置顶更新而非重复条目", () => {
    const store = createAgentRunHistoryStore(memoryStorage());
    store.remember(PROJECT, entry("run-a"));
    store.remember(PROJECT, entry("run-b"));
    store.remember(PROJECT, entry("run-a", { objective: "更新后的目标", status: "completed" }));
    const runs = store.list(PROJECT);
    expect(runs.map((item) => item.runId)).toEqual(["run-a", "run-b"]);
    expect(runs[0]).toMatchObject({ objective: "更新后的目标", status: "completed" });
  });

  it("旧单槽键在读取时迁移为新列表并移除旧键（不丢既有状态）", () => {
    const storage = memoryStorage({ [LEGACY_KEY]: "legacy-run-1" });
    const store = createAgentRunHistoryStore(storage);
    const runs = store.list(PROJECT);
    expect(runs).toEqual([expect.objectContaining({ runId: "legacy-run-1" })]);
    expect(readLegacyRunId(storage, PROJECT)).toBeUndefined();
    expect(JSON.parse(storage.peek(HISTORY_KEY)!)).toHaveLength(1);
    // 迁移后新 remember 追加在旧条目之前。
    store.remember(PROJECT, entry("run-new"));
    expect(store.list(PROJECT).map((item) => item.runId)).toEqual(["run-new", "legacy-run-1"]);
  });

  it("新键写入失败时兜底保留旧键，读取仍返回迁移结果", () => {
    const storage = memoryStorage({ [LEGACY_KEY]: "legacy-run-1" });
    const failing = {
      getItem: storage.getItem,
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => { throw new Error("QuotaExceededError"); },
    };
    const store = createAgentRunHistoryStore(failing);
    expect(store.list(PROJECT).map((item) => item.runId)).toEqual(["legacy-run-1"]);
    expect(readLegacyRunId(storage, PROJECT)).toBe("legacy-run-1");
  });

  it("损坏数据 fail-closed：坏 JSON/非数组/缺 runId 逐条丢弃且不抛", () => {
    const storage = memoryStorage({ [HISTORY_KEY]: "not-json" });
    expect(createAgentRunHistoryStore(storage).list(PROJECT)).toEqual([]);
    storage.setItem(HISTORY_KEY, JSON.stringify({ a: 1 }));
    expect(createAgentRunHistoryStore(storage).list(PROJECT)).toEqual([]);
    storage.setItem(HISTORY_KEY, JSON.stringify([{ objective: "缺 runId" }, entry("run-ok"), null]));
    expect(createAgentRunHistoryStore(storage).list(PROJECT)).toEqual([expect.objectContaining({ runId: "run-ok" })]);
    storage.setItem(HISTORY_KEY, JSON.stringify([entry("run-bad-status", { status: "exploded" as never })]));
    expect(createAgentRunHistoryStore(storage).list(PROJECT)).toEqual([expect.not.objectContaining({ status: expect.anything() })]);
  });

  it("存储读取抛异常时静默降级为空列表，不阻断调用方", () => {
    const store = createAgentRunHistoryStore({
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    });
    expect(store.list(PROJECT)).toEqual([]);
    expect(() => store.remember(PROJECT, entry("run-x"))).not.toThrow();
  });

  it("forget 移除指定条目，其余保留", () => {
    const store = createAgentRunHistoryStore(memoryStorage());
    store.remember(PROJECT, entry("run-a"));
    store.remember(PROJECT, entry("run-b"));
    expect(store.forget(PROJECT, "run-a").map((item) => item.runId)).toEqual(["run-b"]);
  });

  it("forget 后空列表写回为空数组，不会复活旧单槽键", () => {
    const storage = memoryStorage({ [LEGACY_KEY]: "legacy-run-1" });
    const store = createAgentRunHistoryStore(storage);
    store.forget(PROJECT, "legacy-run-1");
    expect(store.list(PROJECT)).toEqual([]);
    expect(storage.peek(HISTORY_KEY)).toBe("[]");
  });
});

describe("陈旧判定（K11：陈旧状态明示而非静默）", () => {
  const now = new Date("2026-10-02T10:00:00.000Z");
  it("本地条目 48h 内不陈旧，超过阈值陈旧", () => {
    expect(isStaleAgentRunEntry({ savedAt: "2026-10-01T09:00:00.000Z" }, now)).toBe(false);
    expect(isStaleAgentRunEntry({ savedAt: "2026-09-30T09:00:00.000Z" }, now)).toBe(true);
  });
  it("无效时间戳不误报陈旧", () => {
    expect(isStaleAgentRunEntry({ savedAt: "not-a-date" }, now)).toBe(false);
  });
  it("checkpoint 以服务端 updatedAt 判定，阈值与条目一致", () => {
    expect(isStaleCheckpoint({ updatedAt: new Date(now.getTime() - AGENT_RUN_STALE_AFTER_MS + 1000).toISOString() }, now)).toBe(false);
    expect(isStaleCheckpoint({ updatedAt: new Date(now.getTime() - AGENT_RUN_STALE_AFTER_MS - 1000).toISOString() }, now)).toBe(true);
  });
});
