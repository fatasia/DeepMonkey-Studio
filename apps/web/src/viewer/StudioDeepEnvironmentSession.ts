import type * as THREE from "three";
import type { PbrEnvironmentSource } from "@bim-studio/deep-engine/webgpu";
import { prepareStudioRendererCandidate } from "./prepareStudioRendererCandidate";
import { prepareStudioDeepEnvironmentSource, isStudioDeepEnvironmentSourceCurrent,
  captureStudioDeepEnvironmentSource, type StudioDeepEnvironmentSourceIdentity,
  type PreparedStudioDeepEnvironment } from "./studioDeepEnvironmentSource";
import type { StudioDeepEnvironmentView } from "./studioDeepEnvironmentView";

export interface StudioDeepEnvironmentSessionOptions {
  readonly scene: THREE.Scene;
  readonly initial: PreparedStudioDeepEnvironment;
  readonly readView: () => StudioDeepEnvironmentView;
  readonly stage: (source: PbrEnvironmentSource, signal: AbortSignal) => Promise<"staged" | "superseded">;
  readonly onReady: () => void;
  readonly onFailure: (error: Error) => void;
}

/** Keeps the last prepared sky visible while replacement pixels and GPU resources are prepared. */
export class StudioDeepEnvironmentSession {
  private active: PreparedStudioDeepEnvironment;
  private lastView: StudioDeepEnvironmentView;
  private pending: AbortController | undefined;
  private pendingSource: StudioDeepEnvironmentSourceIdentity | undefined;
  private closed = false;

  constructor(private readonly options: StudioDeepEnvironmentSessionOptions) {
    this.active = options.initial;
    this.lastView = options.readView();
  }

  view(): StudioDeepEnvironmentView {
    if (this.pendingSource && !isStudioDeepEnvironmentSourceCurrent(this.options.scene, this.pendingSource)) {
      this.pending?.abort();
      this.pending = undefined;
      this.pendingSource = undefined;
    }
    if (isStudioDeepEnvironmentSourceCurrent(this.options.scene, this.active)) {
      this.lastView = this.options.readView();
    } else if (!this.pending && !this.closed) {
      const controller = new AbortController();
      this.pending = controller;
      this.pendingSource = captureStudioDeepEnvironmentSource(this.options.scene);
      void this.prepare(controller);
    }
    return this.lastView;
  }

  dispose(): void {
    this.closed = true;
    this.pending?.abort();
    this.pending = undefined;
    this.pendingSource = undefined;
  }

  private async prepare(controller: AbortController): Promise<void> {
    const result = await prepareStudioRendererCandidate({
      signal: controller.signal, timeoutMs: 30_000, loadModule: async () => undefined,
      create: (_, signal) => prepareStudioDeepEnvironmentSource(this.options.scene, signal),
      prepare: async (candidate, signal) => {
        this.options.readView();
        const status = await this.options.stage(candidate.source, signal);
        if (status !== "staged" || !isStudioDeepEnvironmentSourceCurrent(this.options.scene, candidate)) {
          throw new Error("作者环境在 GPU 准备期间已改变，候选未发布。");
        }
      },
      dispose: () => {}, removeCanvas: () => {},
    });
    if (this.closed || controller.signal.aborted || this.pending !== controller) return;
    const changed = this.pendingSource && !isStudioDeepEnvironmentSourceCurrent(this.options.scene, this.pendingSource);
    this.pending = undefined;
    this.pendingSource = undefined;
    if (changed) { this.view(); return; }
    if (result.status === "ready") {
      try {
        this.lastView = this.options.readView();
        this.active = result.value;
        this.options.onReady();
      } catch (reason) {
        this.options.onFailure(reason instanceof Error ? reason : new Error(String(reason)));
      }
    } else if (result.status === "failed") this.options.onFailure(result.error);
  }
}
