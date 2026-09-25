import type { CameraState } from "@bim-studio/contracts";

export interface CameraInfoPublisher {
  push(state: CameraState): void;
  dispose(): void;
}

interface CameraInfoPublisherClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancel(handle: ReturnType<typeof setTimeout>): void;
}

const browserClock: CameraInfoPublisherClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle),
};

/** Coalesces informational camera UI without delaying the engine camera/render path. */
export function createCameraInfoPublisher(
  publish: (state: CameraState) => void,
  intervalMs = 50,
  clock: CameraInfoPublisherClock = browserClock,
): CameraInfoPublisher {
  let pending: CameraState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPublish = Number.NEGATIVE_INFINITY;
  let disposed = false;
  const flush = () => {
    timer = undefined;
    const state = pending;
    pending = undefined;
    if (disposed || !state) return;
    lastPublish = clock.now();
    publish(state);
  };
  return {
    push(state) {
      if (disposed) return;
      pending = state;
      const delay = Math.max(0, intervalMs - (clock.now() - lastPublish));
      if (delay === 0) flush();
      else if (timer === undefined) timer = clock.schedule(flush, delay);
    },
    dispose() {
      disposed = true;
      pending = undefined;
      if (timer !== undefined) clock.cancel(timer);
      timer = undefined;
    },
  };
}
