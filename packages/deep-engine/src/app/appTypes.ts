import type { FrameLoopAdvanceResult, FrameLoopDiagnostics, FrameLoopMode, FrameLoopStage } from "../frameLoop.js";

export type DeepAppStatus = "initializing" | "ready" | "disposing" | "disposed" | "failed";
export type DeepAppCleanup = () => void | Promise<void>;

/** Identity-based key for a typed application resource. Export one key and share it with consumers. */
export interface DeepAppResource<T> {
  readonly id: string;
  readonly __value?: T;
}

export function createDeepAppResource<T>(id: string): DeepAppResource<T> {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new TypeError("Application resource id must be a non-empty string.");
  }
  return Object.freeze({ id: id.trim() });
}

export interface DeepAppAccess<TState> {
  readonly state: TState;
  readonly status: DeepAppStatus;
  getResource<T>(key: DeepAppResource<T>): T | undefined;
  requireResource<T>(key: DeepAppResource<T>): T;
  invalidate(reason: string): boolean;
}

export type DeepAppFrameStage<TState> = FrameLoopStage<DeepAppAccess<TState>>;

export interface DeepAppPluginContext<TState> extends DeepAppAccess<TState> {
  readonly pluginId: string;
  hasPlugin(id: string): boolean;
  provide<T>(key: DeepAppResource<T>, value: T): void;
  addFrameStage(stage: DeepAppFrameStage<TState>): void;
  onDispose(cleanup: DeepAppCleanup): void;
}

export interface DeepAppPlugin<TState> {
  readonly id: string;
  readonly dependencies?: readonly string[];
  setup(context: DeepAppPluginContext<TState>): void | DeepAppCleanup | Promise<void | DeepAppCleanup>;
}

export interface DeepAppOptions<TState> {
  readonly state: TState;
  readonly mode?: FrameLoopMode;
  readonly plugins?: readonly DeepAppPlugin<TState>[];
}

export interface DeepAppHost<TState> extends DeepAppAccess<TState> {
  advance(timeMs: number): Promise<FrameLoopAdvanceResult>;
  shouldRequestFrame(): boolean;
  setMode(mode: FrameLoopMode): void;
  diagnostics(): FrameLoopDiagnostics;
  dispose(): Promise<void>;
}
