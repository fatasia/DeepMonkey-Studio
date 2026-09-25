export interface TemporalFrameSettlerOptions {
  onError: (error: unknown) => void;
  onSettled?: () => void;
  frames?: number;
  initialDelayFrames?: number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  isVisible?: () => boolean;
  subscribeVisibility?: (callback: () => void) => () => void;
}

/** Return false when the caller is applying GPU back-pressure and wants to retry
 * the same settle budget on a later browser frame. */
export type TemporalSettleRender = () => void | boolean;

interface SettleRun {
  render: TemporalSettleRender;
  remaining: number;
  delay: number;
  frame?: number | undefined;
  ticket?: object | undefined;
  unsubscribe?: () => void;
}

/** 有限重绘已提交画面；不推进作者状态、脚本或资源同步。 */
export class TemporalFrameSettler {
  private run: SettleRun | undefined;
  private readonly options: Required<TemporalFrameSettlerOptions>;

  constructor(options: TemporalFrameSettlerOptions) {
    const frames = options.frames ?? 16;
    const initialDelayFrames = options.initialDelayFrames ?? 0;
    if (!Number.isSafeInteger(frames) || frames < 1 || frames > 120) {
      throw new RangeError("temporal settle frames must be an integer between 1 and 120");
    }
    if (!Number.isSafeInteger(initialDelayFrames) || initialDelayFrames < 0 || initialDelayFrames > 4) {
      throw new RangeError("temporal initial delay must be an integer between 0 and 4");
    }
    this.options = {
      ...options,
      onSettled: options.onSettled ?? (() => {}),
      frames,
      initialDelayFrames,
      requestFrame: options.requestFrame ?? ((callback) => requestAnimationFrame(callback)),
      cancelFrame: options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle)),
      isVisible: options.isVisible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden"),
      subscribeVisibility: options.subscribeVisibility ?? ((callback) => {
        if (typeof document === "undefined") return () => {};
        document.addEventListener("visibilitychange", callback);
        return () => document.removeEventListener("visibilitychange", callback);
      }),
    };
  }

  restart(render: TemporalSettleRender): void {
    this.cancel();
    const run: SettleRun = { render, remaining: this.options.frames, delay: this.options.initialDelayFrames };
    this.run = run;
    try {
      const unsubscribe = this.options.subscribeVisibility(() => this.visibilityChanged(run));
      if (this.run !== run) { unsubscribe(); return; }
      run.unsubscribe = unsubscribe;
      this.schedule(run);
    } catch (error) { this.fail(run, error); }
  }

  cancel(): void {
    const run = this.run;
    this.run = undefined;
    if (!run) return;
    if (run.frame !== undefined) this.options.cancelFrame(run.frame);
    run.unsubscribe?.();
  }

  private visibilityChanged(run: SettleRun): void {
    if (this.run !== run) return;
    try {
      if (!this.options.isVisible()) {
        if (run.frame !== undefined) this.options.cancelFrame(run.frame);
        run.frame = undefined;
        run.ticket = undefined;
      } else this.schedule(run);
    } catch (error) { this.fail(run, error); }
  }

  private schedule(run: SettleRun): void {
    if (this.run !== run || run.frame !== undefined || !this.options.isVisible()) return;
    const ticket = {};
    run.ticket = ticket;
    run.frame = this.options.requestFrame(() => this.tick(run, ticket));
  }

  private tick(run: SettleRun, ticket: object): void {
    if (this.run !== run || run.ticket !== ticket) return;
    run.frame = undefined;
    run.ticket = undefined;
    try {
      if (!this.options.isVisible()) return;
      if (run.delay > 0) {
        run.delay--;
        this.schedule(run);
        return;
      }
      const rendered = run.render();
      if (this.run !== run) return;
      if (rendered === false) { this.schedule(run); return; }
      run.remaining--;
      if (run.remaining === 0) { this.cancel(); this.options.onSettled(); }
      else this.schedule(run);
    } catch (error) { this.fail(run, error); }
  }

  private fail(run: SettleRun, error: unknown): void {
    if (this.run !== run) return;
    this.cancel();
    this.options.onError(error);
  }
}
