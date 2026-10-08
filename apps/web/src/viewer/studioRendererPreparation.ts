import { useSyncExternalStore } from "react";

export type PreparedBackend = "webgpu" | "wasm";
export interface StudioRendererPreparation {
  readonly phase: "preparing" | "ready" | "failed";
  readonly key: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly error?: string;
}
type Snapshot = Readonly<Partial<Record<PreparedBackend, StudioRendererPreparation>>>;
let snapshot: Snapshot = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function readStudioRendererPreparation(): Snapshot { return snapshot; }
export function publishStudioRendererPreparation(backend: PreparedBackend, value: StudioRendererPreparation): void {
  snapshot = { ...snapshot, [backend]: value };
  listeners.forEach(listener => listener());
}
export function clearStudioRendererPreparation(): void {
  snapshot = {};
  listeners.forEach(listener => listener());
}
export function useStudioRendererPreparation(): Snapshot {
  return useSyncExternalStore(subscribe, readStudioRendererPreparation, readStudioRendererPreparation);
}

/** Scene loading and edits invalidate preparation; camera/selection changes do not.
 * A stable key starts one owned task. Superseding it cancels the old worker and
 * hidden GPU candidate. Foreground switches join that work through each bridge. */
export function startStudioRendererPrewarm(readKey: () => string | undefined,
  prepare: (key: string, signal: AbortSignal) => Promise<boolean>, intervalMs = 500): () => void {
  let key: string | undefined, done = false, running = false, closed = false;
  let controller: AbortController | undefined;
  const poll = () => {
    if (closed) return;
    const current = readKey();
    if (current !== key) {
      controller?.abort(); controller = undefined;
      key = current; done = false; running = false;
      return; // One interval of stability avoids compiling partially restored scenes.
    }
    if (!key || done || running) return;
    const owner = new AbortController();
    controller = owner; running = true;
    void prepare(key, owner.signal).then(ready => {
      if (controller === owner && !owner.signal.aborted) done = ready;
    }).catch(() => {
      if (controller === owner && !owner.signal.aborted) done = true;
    }).finally(() => { if (controller === owner) running = false; });
  };
  const timer = setInterval(poll, intervalMs);
  poll();
  return () => { closed = true; clearInterval(timer); controller?.abort(); };
}
