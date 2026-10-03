interface RecoveryEvent { readonly type: string; readonly code?: string }
interface RecoverySession {
  readonly device?: { readonly lost: Promise<unknown> };
  readonly recoveryEvents?: readonly RecoveryEvent[];
}
interface RecoveryBackend {
  readonly runtime: { readonly session?: RecoverySession };
  onDeviceRecreated?(listener: (epoch: number) => void): () => void;
  onFatalLoss?(listener: (reason: { readonly message: string }) => void): () => void;
}
/** Failed request events exclude the final successful request, which counts once. */
export function recoveredAttemptCount(backend: RecoveryBackend): number {
  const events = backend.runtime.session?.recoveryEvents ?? [];
  let classified = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type === "classified") { classified = index; break; }
  }
  return 1 + events.slice(classified + 1).filter(event => event.type === "attempt").length;
}
/** Observes only this candidate; never rehydrates owners on its replacement device. */
export function observeRecoveryCandidate(backend: RecoveryBackend, signal: AbortSignal) {
  let unknown = false, disposed = false;
  let settle!: (result: "recovered" | "fatal" | "cancelled") => void;
  const recovered = new Promise<"recovered" | "fatal" | "cancelled">(resolve => { settle = resolve; });
  const unsubscribeRecreated = backend.onDeviceRecreated?.(() => settle("recovered"));
  const unsubscribeFatal = backend.onFatalLoss?.(() => settle("fatal"));
  const cancel = (): void => settle("cancelled");
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  void backend.runtime.session?.device?.lost.then(info => {
    if (!disposed && (info as { readonly reason?: unknown } | undefined)?.reason === "unknown") unknown = true;
  }, () => undefined);
  return {
    async retryAfter(error: unknown): Promise<number | undefined> {
      // Observe the same microtask checkpoint used by DeviceSession.device.lost.
      await Promise.resolve();
      const readiness = error instanceof Error && ["Renderer is not ready.",
        "GPU session is not ready for candidate admission.", "GPU session is not ready."].includes(error.message);
      if (!unknown || !readiness || signal.aborted || disposed) return undefined;
      if (await recovered !== "recovered" || signal.aborted || disposed) return undefined;
      return recoveredAttemptCount(backend);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; cancel(); unsubscribeRecreated?.(); unsubscribeFatal?.();
      signal.removeEventListener("abort", cancel);
    },
  };
}
