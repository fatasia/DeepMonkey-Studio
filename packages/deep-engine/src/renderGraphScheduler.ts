export interface ParallelGroupTask<T> {
  readonly id: string;
  readonly run: () => Promise<T> | T;
}

export interface ParallelGroupScheduleOptions {
  /** 组内最多同时运行的任务数；默认组大小。 */
  readonly maxConcurrency?: number;
  /** 失败时是否取消后续组；已启动任务不会被强行中断。 */
  readonly stopOnError?: boolean;
}

export interface ParallelGroupScheduleResult<T> {
  readonly values: ReadonlyMap<string, T>;
  readonly completed: readonly string[];
  readonly failed: readonly { id: string; error: unknown }[];
  readonly groupsRun: number;
}

/**
 * R6-3 host-neutral executor for RenderGraph.parallelGroups.
 * Groups retain plan order; tasks within a group use bounded concurrency and
 * deterministic result ordering. It is deliberately callback-based so GPU
 * encoders, worker tasks, and native bridges can provide their own execution.
 */
export async function executeParallelGroups<T>(
  groups: readonly (readonly ParallelGroupTask<T>[])[],
  options: ParallelGroupScheduleOptions = {},
): Promise<ParallelGroupScheduleResult<T>> {
  const stopOnError = options.stopOnError ?? true;
  const allIds = new Set<string>();
  const maxGroupSize = Math.max(1, ...groups.map((group) => group.length));
  const maxConcurrency = options.maxConcurrency ?? maxGroupSize;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 1024) {
    throw new Error("parallel scheduler maxConcurrency must be an integer in [1, 1024].");
  }
  for (const [groupIndex, group] of groups.entries()) {
    if (!Array.isArray(group)) throw new Error(`parallel scheduler group ${groupIndex} must be an array.`);
    for (const task of group) {
      if (!task || typeof task.id !== "string" || task.id.length === 0 || typeof task.run !== "function") {
        throw new Error(`parallel scheduler task ${groupIndex} is invalid.`);
      }
      if (allIds.has(task.id)) throw new Error(`parallel scheduler duplicate task: ${task.id}.`);
      allIds.add(task.id);
    }
  }
  const values = new Map<string, T>();
  const completed: string[] = [];
  const failed: { id: string; error: unknown }[] = [];
  let groupsRun = 0;
  for (const group of groups) {
    const groupResults = await runBounded(group, maxConcurrency);
    for (const result of groupResults) {
      if (result.ok) {
        values.set(result.id, result.value);
        completed.push(result.id);
      } else {
        failed.push({ id: result.id, error: result.error });
      }
    }
    groupsRun += 1;
    if (stopOnError && failed.length > 0) break;
  }
  return Object.freeze({ values, completed: Object.freeze(completed), failed: Object.freeze(failed), groupsRun });
}

type TaskResult<T> = { readonly id: string; readonly ok: true; readonly value: T }
  | { readonly id: string; readonly ok: false; readonly error: unknown };

async function runBounded<T>(tasks: readonly ParallelGroupTask<T>[], limit: number): Promise<readonly TaskResult<T>[]> {
  const results: TaskResult<T>[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index]!;
      try {
        results[index] = { id: task.id, ok: true, value: await task.run() };
      } catch (error) {
        results[index] = { id: task.id, ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}
