import type { SceneBehaviorRuntimeSettings, SceneBehaviorTick } from "./protocol.js";

export const DEFAULT_SCENE_BEHAVIOR_RUNTIME_SETTINGS: SceneBehaviorRuntimeSettings = {
  fixedStepMs: 1000 / 60,
  maxFixedStepsPerFrame: 5,
  timeScale: 1,
  updateEnabled: true
};

export interface SceneBehaviorSchedulerDiagnostics {
  state: "running" | "paused" | "disposed";
  elapsedMs: number;
  fixedElapsedMs: number;
  frame: number;
  sequence: number;
  pendingFixedMs: number;
  droppedFixedSteps: number;
  lastFrameDeltaMs: number;
  timeScale: number;
}

/**
 * Pure deterministic clock used by browser Workers, Tauri WebViews and server
 * worker_threads. It never executes user code and never depends on a renderer.
 */
export class SceneBehaviorScheduler {
  private settings: SceneBehaviorRuntimeSettings;
  private state: SceneBehaviorSchedulerDiagnostics["state"] = "running";
  private elapsedMs = 0;
  private fixedElapsedMs = 0;
  private frame = 0;
  private sequence = 0;
  private fixedAccumulatorMs = 0;
  private droppedFixedSteps = 0;
  private lastFrameDeltaMs = 0;

  constructor(settings: Partial<SceneBehaviorRuntimeSettings> = {}) {
    this.settings = normalizeSceneBehaviorRuntimeSettings(settings);
  }

  advance(realDeltaMs: number): SceneBehaviorTick[] {
    if (this.state !== "running") return [];
    const safeRealDelta = finiteRange(realDeltaMs, 0, 250, 0);
    const deltaMs = safeRealDelta * this.settings.timeScale;
    this.lastFrameDeltaMs = deltaMs;
    this.elapsedMs += deltaMs;
    this.frame += 1;
    const ticks: SceneBehaviorTick[] = [];
    if (this.settings.updateEnabled) ticks.push(this.tick("onUpdate", deltaMs, this.elapsedMs));

    this.fixedAccumulatorMs += deltaMs;
    let fixedSteps = 0;
    while (this.fixedAccumulatorMs + Number.EPSILON >= this.settings.fixedStepMs && fixedSteps < this.settings.maxFixedStepsPerFrame) {
      this.fixedAccumulatorMs -= this.settings.fixedStepMs;
      this.fixedElapsedMs += this.settings.fixedStepMs;
      ticks.push(this.tick("onFixedUpdate", this.settings.fixedStepMs, this.fixedElapsedMs));
      fixedSteps += 1;
    }
    if (this.fixedAccumulatorMs >= this.settings.fixedStepMs) {
      const dropped = Math.floor(this.fixedAccumulatorMs / this.settings.fixedStepMs);
      this.fixedAccumulatorMs -= dropped * this.settings.fixedStepMs;
      this.droppedFixedSteps += dropped;
      this.fixedElapsedMs += dropped * this.settings.fixedStepMs;
    }
    return ticks;
  }

  pause(): void {
    if (this.state === "running") this.state = "paused";
  }

  resume(): void {
    if (this.state === "paused") this.state = "running";
  }

  reset(): void {
    if (this.state === "disposed") return;
    this.elapsedMs = 0;
    this.fixedElapsedMs = 0;
    this.frame = 0;
    this.sequence = 0;
    this.fixedAccumulatorMs = 0;
    this.droppedFixedSteps = 0;
    this.lastFrameDeltaMs = 0;
  }

  dispose(): void {
    this.state = "disposed";
    this.fixedAccumulatorMs = 0;
  }

  configure(patch: Partial<SceneBehaviorRuntimeSettings>): void {
    if (this.state === "disposed") return;
    this.settings = normalizeSceneBehaviorRuntimeSettings({ ...this.settings, ...patch });
    this.fixedAccumulatorMs %= this.settings.fixedStepMs;
  }

  diagnostics(): SceneBehaviorSchedulerDiagnostics {
    return {
      state: this.state,
      elapsedMs: this.elapsedMs,
      fixedElapsedMs: this.fixedElapsedMs,
      frame: this.frame,
      sequence: this.sequence,
      pendingFixedMs: this.fixedAccumulatorMs,
      droppedFixedSteps: this.droppedFixedSteps,
      lastFrameDeltaMs: this.lastFrameDeltaMs,
      timeScale: this.settings.timeScale
    };
  }

  private tick(lifecycle: SceneBehaviorTick["lifecycle"], deltaMs: number, elapsedMs: number): SceneBehaviorTick {
    this.sequence += 1;
    return { sequence: this.sequence, lifecycle, deltaMs, elapsedMs, frame: this.frame };
  }
}

export function normalizeSceneBehaviorRuntimeSettings(settings: Partial<SceneBehaviorRuntimeSettings> = {}): SceneBehaviorRuntimeSettings {
  return {
    fixedStepMs: finiteRange(settings.fixedStepMs, 1, 1000, DEFAULT_SCENE_BEHAVIOR_RUNTIME_SETTINGS.fixedStepMs),
    maxFixedStepsPerFrame: Math.round(finiteRange(settings.maxFixedStepsPerFrame, 1, 120, DEFAULT_SCENE_BEHAVIOR_RUNTIME_SETTINGS.maxFixedStepsPerFrame)),
    timeScale: finiteRange(settings.timeScale, 0.01, 100, DEFAULT_SCENE_BEHAVIOR_RUNTIME_SETTINGS.timeScale),
    updateEnabled: settings.updateEnabled ?? DEFAULT_SCENE_BEHAVIOR_RUNTIME_SETTINGS.updateEnabled
  };
}

function finiteRange(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
