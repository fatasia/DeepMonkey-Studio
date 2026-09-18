import type { RenderView } from "@bim-studio/deep-engine/webgpu";

type Lights = NonNullable<RenderView["lights"]>;
interface PendingShadow {
  readonly controller: AbortController;
  readonly mapSize: number;
  readonly timer: ReturnType<typeof setTimeout>;
}
export interface StudioDeepShadowSessionOptions {
  readonly initialMapSize: number;
  readonly stage: (mapSize: number, signal: AbortSignal) => Promise<"staged" | "superseded">;
  readonly onReady: () => void;
  readonly onFailure: (error: Error) => void;
}

/** While allocating a new map, use the current map's sampling size and current author light pose. */
export class StudioDeepShadowSession {
  private activeMapSize: number;
  private pending: PendingShadow | undefined;
  private stagedController: AbortController | undefined;
  private preparedMapSize: number | undefined;
  private closed = false;
  constructor(private readonly options: StudioDeepShadowSessionOptions) {
    this.activeMapSize = options.initialMapSize;
  }

  lights(source: Lights): Lights {
    const primary = source.directional?.[0];
    const requested = primary?.castShadow && primary.shadow ? primary.shadow.mapSize : undefined;
    if (this.pending && this.pending.mapSize !== requested) this.cancel();
    if (this.preparedMapSize !== undefined && this.preparedMapSize !== requested) {
      this.stagedController?.abort(); this.stagedController = undefined; this.preparedMapSize = undefined;
    }
    if (requested === undefined || requested === this.activeMapSize || requested === this.preparedMapSize || this.closed) return source;
    if (!this.pending) {
      const controller = new AbortController();
      const pending: PendingShadow = { controller, mapSize: requested,
        timer: setTimeout(() => this.fail(pending, new Error("作者阴影资源准备超时。")), 30_000) };
      this.pending = pending;
      void this.prepare(pending);
    }
    return { ...source, directional: [{ ...primary!, shadow: { ...primary!.shadow!, mapSize: this.activeMapSize } },
      ...source.directional!.slice(1)] };
  }

  /** Only a successfully submitted frame proves which allocation is active. */
  acknowledgeMapSize(mapSize: number | undefined): void {
    if (this.closed || mapSize === undefined) return;
    this.activeMapSize = mapSize;
    if (this.preparedMapSize === mapSize) {
      this.preparedMapSize = undefined;
      this.stagedController = undefined;
    }
  }

  dispose(): void {
    this.closed = true;
    this.cancel();
    this.stagedController?.abort();
    this.stagedController = undefined;
  }

  private cancel(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.controller.abort(); }
  }

  private async prepare(pending: PendingShadow): Promise<void> {
    try {
      const result = await this.options.stage(pending.mapSize, pending.controller.signal);
      if (this.closed || this.pending !== pending) return;
      if (result !== "staged") throw new Error("作者阴影候选已被替换，未发布。");
      clearTimeout(pending.timer);
      this.pending = undefined;
      this.stagedController?.abort();
      this.stagedController = pending.controller;
      this.preparedMapSize = pending.mapSize;
      try { this.options.onReady(); }
      catch (reason) { this.options.onFailure(reason instanceof Error ? reason : new Error(String(reason))); }
    } catch (reason) {
      this.fail(pending, reason instanceof Error ? reason : new Error(String(reason)));
    }
  }

  private fail(pending: PendingShadow, error: Error): void {
    if (this.closed || this.pending !== pending) return;
    this.cancel();
    this.options.onFailure(error);
  }
}
