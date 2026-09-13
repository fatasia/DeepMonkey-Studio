/** Attempts every cleanup in order and reports all failures after ownership is detached. */
export function runResourceCleanup(label: string, operations: readonly (() => void)[]): void {
  const failures: unknown[] = [];
  for (const operation of operations) {
    try { operation(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, label);
}

/** Preserves the triggering failure while still attempting every rollback operation. */
export function failWithResourceCleanup(
  error: unknown,
  label: string,
  operations: readonly (() => void)[],
): never {
  try { runResourceCleanup(`${label} cleanup failed.`, operations); }
  catch (cleanupError) { throw new AggregateError([error, cleanupError], label); }
  throw error;
}
