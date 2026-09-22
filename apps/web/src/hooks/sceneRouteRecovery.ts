import { networkStatusMonitor } from "../appStatus/networkStatusMonitor";

function isTransientReadFailure(reason: unknown): boolean {
  if (reason instanceof TypeError) return true;
  if (reason instanceof Error && ["AbortError", "TimeoutError"].includes(reason.name)) return true;
  const status = typeof reason === "object" && reason !== null && "status" in reason ? reason.status : undefined;
  return typeof status === "number" && (status === 408 || status === 429 || status >= 500);
}

/** Retry only the read phase; applying a snapshot is never replayed by recovery. */
export function recoverSceneRouteRead<T>(options: {
  read: () => Promise<T>;
  apply: (value: T) => Promise<void>;
  onError: (reason: unknown) => void;
}): () => void {
  let cancelled = false;
  let completed = false;
  let inFlight = false;
  let attempts = 0;
  let recoveryAttemptUsed = false;
  let retryable = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delays = [1000, 2000, 4000];
  const run = async () => {
    if (cancelled || completed || inFlight) return;
    inFlight = true;
    attempts += 1;
    let value: T;
    try {
      value = await options.read();
    } catch (reason) {
      inFlight = false;
      if (cancelled) return;
      retryable = isTransientReadFailure(reason);
      const delay = delays[attempts - 1];
      if (retryable && delay !== undefined) timer = setTimeout(() => { timer = undefined; void run(); }, delay);
      else options.onError(reason);
      return;
    }
    if (cancelled) return;
    // Mark completed before apply: store updates and connection events cannot apply twice.
    completed = true;
    try { await options.apply(value); }
    catch (reason) { if (!cancelled) options.onError(reason); }
    finally { inFlight = false; }
  };
  const recover = () => {
    if (cancelled || completed || inFlight || !retryable || recoveryAttemptUsed || attempts < 4) return;
    recoveryAttemptUsed = true;
    void run();
  };
  const unsubscribe = networkStatusMonitor.subscribe(() => {
    if (networkStatusMonitor.getSnapshot().phase === "recovered") recover();
  });
  window.addEventListener("online", recover);
  void run();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    window.removeEventListener("online", recover);
  };
}
