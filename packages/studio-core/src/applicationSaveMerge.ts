import type { ApplicationDocument } from "@bim-studio/contracts";

/** 外部三维快照不一定先写入 Store；以发送前的 Store 文档作基线，只合入没有被后续编辑覆盖的回声。 */
export function mergeApplicationSave(
  current: ApplicationDocument,
  baseline: ApplicationDocument,
  saved: ApplicationDocument,
): ApplicationDocument {
  return mergeValue(current, baseline, saved) as ApplicationDocument;
}

function same(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identity(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  if (typeof value.id === "string") return `id:${value.id}`;
  if (typeof value.modelId === "string") return `model:${value.modelId}`;
  return undefined;
}

function keyed(values: unknown[]): Map<string, unknown> | undefined {
  const entries = new Map<string, unknown>();
  for (const value of values) {
    const key = identity(value);
    if (!key || entries.has(key)) return undefined;
    entries.set(key, value);
  }
  return entries;
}

function mergeValue(current: unknown, baseline: unknown, saved: unknown): unknown {
  if (same(current, baseline)) return saved;
  if (same(saved, baseline) || same(current, saved)) return current;
  if (Array.isArray(current) && Array.isArray(baseline) && Array.isArray(saved)) {
    const local = keyed(current), original = keyed(baseline), remote = keyed(saved);
    // 对象集合按业务身份合并；几何/数值等无身份数组发生冲突时保留本地，不猜索引语义。
    if (!local || !original || !remote) return current;
    const result: unknown[] = [];
    for (const key of new Set([...local.keys(), ...remote.keys()])) {
      const value = mergeValue(local.get(key), original.get(key), remote.get(key));
      if (value !== undefined) result.push(value);
    }
    return result;
  }
  if (record(current) && record(baseline) && record(saved)) {
    const entries = new Set([...Object.keys(current), ...Object.keys(baseline), ...Object.keys(saved)]);
    return Object.fromEntries([...entries].flatMap(key => {
      const value = mergeValue(current[key], baseline[key], saved[key]);
      return value === undefined ? [] : [[key, value]];
    }));
  }
  // 同一值、删除或新建发生竞争时，本地后续编辑优先。
  return current;
}
