import type { StudioEnvironment } from "./studioEnvironment.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";

export type EnvironmentStageResult = "staged" | "superseded";
export type EnvironmentFactory = (signal: AbortSignal) => Promise<StudioEnvironment>;

function abortError(message: string): Error {
  const error = new Error(message); error.name = "AbortError"; return error;
}

function relayAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = (): void => target.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

/** Owns one active environment and publishes prepared replacements only at a frame boundary. */
export class PbrEnvironmentState {
  private pending: StudioEnvironment | undefined;
  private unlinkPendingAbort: (() => void) | undefined;
  private request: AbortController | undefined;
  private revision = 0;
  private disposed = false;
  private framePrevious: StudioEnvironment | undefined;

  constructor(private active: StudioEnvironment) {}

  get current(): StudioEnvironment { return this.active; }

  async stage(factory: EnvironmentFactory, signal?: AbortSignal): Promise<EnvironmentStageResult> {
    if (this.disposed) throw new Error("PBR environment state is disposed.");
    if (typeof factory !== "function") throw new TypeError("PBR environment factory must be a function.");
    if (signal?.aborted) throw abortError("PBR environment request cancelled");
    this.request?.abort(abortError("Superseded PBR environment request"));
    this.clearPending(true);
    const controller = new AbortController(), revision = ++this.revision;
    this.request = controller;
    const unlink = signal ? relayAbort(signal, controller) : () => {};
    let candidate: StudioEnvironment;
    try { candidate = await factory(controller.signal); }
    catch (error) {
      if (controller.signal.aborted && (this.disposed || revision !== this.revision)) return "superseded";
      throw error;
    }
    finally { unlink(); if (this.request === controller) this.request = undefined; }
    if (this.disposed || revision !== this.revision || controller.signal.aborted) {
      candidate.dispose();
      return "superseded";
    }
    this.pending = candidate;
    // Preparation is not publication: cancellation remains effective until the frame boundary.
    if (signal) {
      const cancel = (): void => {
        if (this.pending === candidate && revision === this.revision) this.clearPending(true);
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.unlinkPendingAbort = () => signal.removeEventListener("abort", cancel);
    }
    return "staged";
  }

  /** Returns a new active environment only when a complete candidate was staged. */
  publish(activate?: (environment: StudioEnvironment) => void): StudioEnvironment | undefined {
    const candidate = this.beginFrame(activate);
    this.commitFrame(); return candidate;
  }

  /** Keep the last submitted environment alive while a candidate frame is encoded. */
  beginFrame(activate?: (environment: StudioEnvironment) => void): StudioEnvironment | undefined {
    if (this.framePrevious) throw new Error("PBR environment frame is already pending.");
    if (this.disposed || !this.pending) return undefined;
    const candidate = this.pending;
    this.clearPending(false);
    try { activate?.(candidate); }
    catch (error) { candidate.dispose(); throw error; }
    if (this.disposed) { candidate.dispose(); return undefined; }
    this.framePrevious = this.active;
    this.active = candidate;
    return this.active;
  }

  runFrame<T>(render: () => T | undefined, restore: (environment: StudioEnvironment) => void): T | undefined {
    try {
      const result = render();
      if (result === undefined) this.rollbackFrame(restore); else this.commitFrame();
      return result;
    } catch (error) {
      failWithResourceCleanup(error, "PBR environment frame failed.", [() => this.rollbackFrame(restore)]);
    }
  }

  private commitFrame(): void {
    const previous = this.framePrevious; this.framePrevious = undefined; previous?.dispose();
  }

  private rollbackFrame(restore: (environment: StudioEnvironment) => void): void {
    const previous = this.framePrevious;
    if (!previous) return;
    const candidate = this.active; this.framePrevious = undefined; this.active = previous;
    runResourceCleanup("PBR environment rollback failed.", [() => restore(previous), () => candidate.dispose()]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    this.request?.abort(abortError("PBR environment state disposed"));
    this.request = undefined;
    const errors: unknown[] = [];
    const previous = this.framePrevious; this.framePrevious = undefined;
    for (const cleanup of [() => this.clearPending(true), () => this.active.dispose(), () => previous?.dispose()]) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "PBR environment cleanup failed.");
  }

  private clearPending(dispose: boolean): void {
    const candidate = this.pending;
    this.pending = undefined;
    this.unlinkPendingAbort?.();
    this.unlinkPendingAbort = undefined;
    if (dispose) candidate?.dispose();
  }
}
