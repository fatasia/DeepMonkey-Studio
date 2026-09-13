import type { StudioEnvironment } from "./studioEnvironment.js";

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
  private request: AbortController | undefined;
  private revision = 0;
  private disposed = false;

  constructor(private active: StudioEnvironment) {}

  get current(): StudioEnvironment { return this.active; }

  async stage(factory: EnvironmentFactory, signal?: AbortSignal): Promise<EnvironmentStageResult> {
    if (this.disposed) throw new Error("PBR environment state is disposed.");
    if (typeof factory !== "function") throw new TypeError("PBR environment factory must be a function.");
    this.request?.abort(abortError("Superseded PBR environment request"));
    this.pending?.dispose();
    this.pending = undefined;
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
    return "staged";
  }

  /** Returns a new active environment only when a complete candidate was staged. */
  publish(activate?: (environment: StudioEnvironment) => void): StudioEnvironment | undefined {
    if (this.disposed || !this.pending) return undefined;
    const candidate = this.pending;
    try { activate?.(candidate); }
    catch (error) { this.pending = undefined; candidate.dispose(); throw error; }
    const previous = this.active;
    this.active = candidate;
    this.pending = undefined;
    previous.dispose();
    return this.active;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    this.request?.abort(abortError("PBR environment state disposed"));
    this.request = undefined;
    this.pending?.dispose();
    this.pending = undefined;
    this.active.dispose();
  }
}
