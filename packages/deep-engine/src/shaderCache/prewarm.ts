import { abortable, combinedAbort } from "./async.js";
import type {
  ShaderPrewarmItemResult, ShaderPrewarmOptions, ShaderPrewarmResult,
} from "./types.js";

const MAX_PREWARM_KEYS = 512;

function message(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 512);
}

function validateList(name: string, values: readonly string[]): void {
  if (!Array.isArray(values) || values.length > MAX_PREWARM_KEYS) {
    throw new RangeError(`${name} must contain at most ${MAX_PREWARM_KEYS} keys.`);
  }
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length < 1 || value.length > 256) {
      throw new TypeError(`${name} contains an invalid key.`);
    }
    if (unique.has(value)) throw new TypeError(`${name} must not contain duplicate keys.`);
    unique.add(value);
  }
}

export async function runAllowlistedPrewarm(
  requested: readonly string[],
  options: ShaderPrewarmOptions,
  load: (key: string, signal: AbortSignal) => Promise<boolean>,
): Promise<ShaderPrewarmResult> {
  validateList("Shader prewarm request", requested);
  validateList("Shader prewarm allowlist", options.allowlist);
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new RangeError("Shader prewarm concurrency must be an integer from 1 through 16.");
  }
  const timeout = combinedAbort(options.signal, options.timeoutMs ?? 15_000);
  const allowed = new Set(options.allowlist);
  const items: ShaderPrewarmItemResult[] = new Array(requested.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= requested.length) return;
      const key = requested[index]!;
      if (!allowed.has(key)) {
        items[index] = Object.freeze({ key, status: "denied" });
        continue;
      }
      if (timeout.signal.aborted) {
        items[index] = Object.freeze({ key, status: "aborted" });
        continue;
      }
      try {
        const found = await abortable(load(key, timeout.signal), timeout.signal);
        items[index] = Object.freeze({ key, status: found ? "warmed" : "missing" });
      } catch (error) {
        items[index] = timeout.signal.aborted
          ? Object.freeze({ key, status: "aborted" })
          : Object.freeze({ key, status: "failed", message: message(error) });
      }
    }
  };

  try {
    await Promise.all(Array.from(
      { length: Math.min(concurrency, Math.max(1, requested.length)) },
      worker,
    ));
    return Object.freeze({
      items: Object.freeze(items),
      timedOut: timeout.timedOut(),
      aborted: timeout.signal.aborted,
    });
  } finally {
    timeout.dispose();
  }
}
