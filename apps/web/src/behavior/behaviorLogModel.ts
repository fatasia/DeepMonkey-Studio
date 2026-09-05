import type { JsonValue } from "@bim-studio/contracts";

export interface BehaviorLogEntry {
  id: string;
  moduleId: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
  data?: JsonValue;
  location?: { line: number; column: number };
}

export function filterBehaviorLogs(logs: readonly BehaviorLogEntry[], options: {
  moduleId?: string;
  level: BehaviorLogEntry["level"] | "all";
  search: string;
  collapse: boolean;
}) {
  const search = options.search.trim().toLocaleLowerCase();
  const groups = new Map<string, BehaviorLogEntry & { count: number }>();
  for (const entry of logs) {
    if (options.moduleId && entry.moduleId !== options.moduleId) continue;
    if (options.level !== "all" && options.level !== entry.level) continue;
    if (search && !`${entry.message} ${entry.moduleId} ${JSON.stringify(entry.data) ?? ""}`.toLocaleLowerCase().includes(search)) continue;
    // 不跨文件/等级折叠；保留结构化值与定位差异。
    const key = options.collapse ? JSON.stringify([entry.moduleId, entry.level, entry.message, entry.data, entry.location]) : entry.id;
    const previous = groups.get(key);
    groups.set(key, { ...entry, count: (previous?.count ?? 0) + 1 });
  }
  return [...groups.values()].slice(-80);
}
