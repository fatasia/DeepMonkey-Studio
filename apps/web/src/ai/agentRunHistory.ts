import type { AgentRunStatus } from "@bim-studio/industrial-agent-orchestrator";

/**
 * H-C5-K13：工业 Agent 运行历史的本地持久化。
 *
 * 旧实现每项目只存一个 runId（`bim-studio:industrial-agent:<projectId>` 单槽），
 * 后启动的运行会覆盖上一个，用户无法回到更早的运行。这里升级为滚动列表
 * （`bim-studio:industrial-agent-runs:<projectId>`，最多 KEEP_RUNS 条），并对
 * 旧单槽键做一次性迁移与兜底读取——迁移写入失败时保留旧键，下次读取再试，
 * 用户既有状态不丢。
 *
 * 存储不可用（隐私模式/配额满）时全部操作静默降级为内存结果：历史丢失不阻断当前会话。
 */

export interface AgentRunHistoryEntry {
  runId: string;
  objective: string;
  /** 本地记忆时间（ISO）；旧单槽键迁移来的条目以迁移时刻为准。 */
  savedAt: string;
  status?: AgentRunStatus;
}

export const AGENT_RUN_HISTORY_LIMIT = 10;
/** 超过该时长的本地条目在 UI 上标注"陈旧"，不静默当作可信状态。 */
export const AGENT_RUN_STALE_AFTER_MS = 48 * 60 * 60 * 1000;
export const LEGACY_AGENT_RUN_KEY_PREFIX = "bim-studio:industrial-agent:";
export const AGENT_RUN_HISTORY_KEY_PREFIX = "bim-studio:industrial-agent-runs:";

type RunStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface AgentRunHistoryStore {
  /** 记录/更新一次运行（同 runId 置顶去重），返回写后的内存列表。 */
  remember(projectId: string, entry: AgentRunHistoryEntry): AgentRunHistoryEntry[];
  /** 读取历史（最近在前）；旧单槽键存在时迁移，损坏数据 fail-closed 过滤。 */
  list(projectId: string): AgentRunHistoryEntry[];
  forget(projectId: string, runId: string): AgentRunHistoryEntry[];
}

export function createAgentRunHistoryStore(storage: RunStorage): AgentRunHistoryStore {
  return { remember, list, forget };
  function remember(projectId: string, entry: AgentRunHistoryEntry): AgentRunHistoryEntry[] {
    const rest = list(projectId).filter((item) => item.runId !== entry.runId);
    const next = [entry, ...rest].slice(0, AGENT_RUN_HISTORY_LIMIT);
    writeHistory(projectId, next);
    return next;
  }

  function list(projectId: string): AgentRunHistoryEntry[] {
    const raw = readStorage(() => storage.getItem(historyKey(projectId)));
    if (raw !== undefined && raw !== null) return parseHistory(raw);
    return migrateLegacyRun(projectId);
  }

  function forget(projectId: string, runId: string): AgentRunHistoryEntry[] {
    const next = list(projectId).filter((item) => item.runId !== runId);
    writeHistory(projectId, next);
    return next;
  }

  /** 旧单槽键 → 新列表。写新键成功才移除旧键；失败则旧键原样保留（兜底仍可读）。 */
  function migrateLegacyRun(projectId: string): AgentRunHistoryEntry[] {
    const legacy = readStorage(() => storage.getItem(legacyKey(projectId)));
    if (!legacy) return [];
    const entry: AgentRunHistoryEntry = { runId: legacy, objective: "", savedAt: new Date().toISOString() };
    try {
      storage.setItem(historyKey(projectId), JSON.stringify([entry]));
      storage.removeItem(legacyKey(projectId));
    } catch { /* 新键写入失败：旧键保留，下次读取继续兜底。 */ }
    return [entry];
  }

  function writeHistory(projectId: string, entries: AgentRunHistoryEntry[]): void {
    try { storage.setItem(historyKey(projectId), JSON.stringify(entries)); } catch { /* 存储不可用时放弃持久化，内存结果仍返回。 */ }
  }
}

function readStorage(read: () => string | null): string | null | undefined {
  try { return read(); } catch { return undefined; }
}

/** 浏览器默认入口：localStorage 不可用（隐私模式等）时回退进程内记忆，会话内历史仍可用。 */
export function browserRunHistoryStore(): AgentRunHistoryStore {
  try { return createAgentRunHistoryStore(window.localStorage); } catch { return createAgentRunHistoryStore(memoryStorage()); }
}

function memoryStorage(): RunStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

/** 检查点状态全集（与 @bim-studio/industrial-agent-orchestrator 的 AgentRunStatus 一致）；本地数据校验防渲染空白。 */
const AGENT_RUN_STATUSES = new Set([
  "running", "awaiting-approval", "awaiting-input", "completed", "blocked", "failed", "cancelled", "budget-exhausted",
]);

/** 非数组/缺 runId/非法 status 的损坏数据逐条丢弃，不让一条坏数据拖垮整个历史。 */
function parseHistory(raw: string): AgentRunHistoryEntry[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    const entry = item as Partial<AgentRunHistoryEntry> | null;
    if (!entry || typeof entry.runId !== "string" || !entry.runId) return [];
    return [{
      runId: entry.runId,
      objective: typeof entry.objective === "string" ? entry.objective : "",
      savedAt: typeof entry.savedAt === "string" ? entry.savedAt : new Date(0).toISOString(),
      ...(typeof entry.status === "string" && AGENT_RUN_STATUSES.has(entry.status)
        ? { status: entry.status as AgentRunStatus }
        : {}),
    }];
  });
}

/** 旧单槽键的兼容读取：迁移完成后不再被组件依赖，仅测试与故障排查使用。 */
export function readLegacyRunId(storage: RunStorage, projectId: string): string | undefined {
  const raw = readStorage(() => storage.getItem(legacyKey(projectId)));
  return raw || undefined;
}

/** 本地条目超过陈旧阈值（默认 48h）→ UI 必须显式标注而非当作可信状态。 */
export function isStaleAgentRunEntry(entry: Pick<AgentRunHistoryEntry, "savedAt">, now: Date = new Date()): boolean {
  const savedAt = Date.parse(entry.savedAt);
  return Number.isFinite(savedAt) && now.getTime() - savedAt > AGENT_RUN_STALE_AFTER_MS;
}

/** 恢复得到的检查点距服务端最后更新超过阈值 → 提示"状态可能陈旧"。 */
export function isStaleCheckpoint(checkpoint: { updatedAt: string }, now: Date = new Date()): boolean {
  const updatedAt = Date.parse(checkpoint.updatedAt);
  return Number.isFinite(updatedAt) && now.getTime() - updatedAt > AGENT_RUN_STALE_AFTER_MS;
}

function historyKey(projectId: string): string {
  return `${AGENT_RUN_HISTORY_KEY_PREFIX}${projectId}`;
}

function legacyKey(projectId: string): string {
  return `${LEGACY_AGENT_RUN_KEY_PREFIX}${projectId}`;
}
