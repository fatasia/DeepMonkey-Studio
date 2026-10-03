import type { ScenePhysicsState } from "@bim-studio/contracts";
import { FixedStepClock } from "@bim-studio/deep-engine/physics";

export interface PhysicsWorldBackend {
  setGravity(gravity: ScenePhysicsState["gravity"]): void;
  step(timestep: number): void;
  dispose(): void;
}

export interface PhysicsStepResult {
  steps: number;
  simulatedSeconds: number;
}

const FIXED_HZ = 60;
const FIXED_TIMESTEP = 1 / FIXED_HZ;
/** 0.2 s 的追赶预算:长帧/断点后最多补 12 步,超出部分计入 droppedTicks 而非静默吞没。 */
const MAX_CATCH_UP_TICKS = 12;

/**
 * Owns the renderer-independent PhysicsWorld clock and backend lifetime.
 * Scene/model translation stays in the Viewer adapter; deterministic stepping
 * and teardown semantics stay identical for WebGL and WebGPU renderers.
 *
 * Step counts come from the engine FixedStepClock (round-quantised, remainder-carrying):
 * the same frame-time series always yields the same integer tick series, so a 59.9/60.1 Hz
 * jittering display no longer produces 0/2-step stutter and replays are tick-exact.
 * The loop only touches plain fields — never React state.
 */
export class PhysicsWorldHost {
  private backend: PhysicsWorldBackend | undefined;
  private readonly clock = new FixedStepClock({ hz: FIXED_HZ, maxCatchUpTicks: MAX_CATCH_UP_TICKS });
  private enabled = false;
  private playing = false;
  private disposed = false;
  private gravity: ScenePhysicsState["gravity"] = { x: 0, y: -9.81, z: 0 };

  configure(state: ScenePhysicsState): void {
    const wasAdvancing = this.enabled && this.playing;
    this.enabled = state.enabled;
    this.playing = state.enabled && state.playing;
    this.gravity = { ...state.gravity };
    if (wasAdvancing !== (this.enabled && this.playing)) this.clock.discardRemainder();
    this.backend?.setGravity(this.gravity);
  }

  attach(backend: PhysicsWorldBackend): boolean {
    if (this.disposed) return false;
    this.backend?.dispose();
    this.backend = backend;
    this.clock.discardRemainder();
    backend.setGravity(this.gravity);
    return true;
  }

  advance(deltaSeconds: number): PhysicsStepResult {
    if (!this.backend || !this.enabled || !this.playing || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      return { steps: 0, simulatedSeconds: 0 };
    }
    const steps = this.clock.advanceSeconds(deltaSeconds);
    for (let index = 0; index < steps; index += 1) this.backend.step(FIXED_TIMESTEP);
    return { steps, simulatedSeconds: steps * FIXED_TIMESTEP };
  }

  /** 宿主累计固定步数(权威 tick 轴;resetClock 不清零,仅丢弃亚 tick 余量)。 */
  get fixedTick(): number {
    return this.clock.tick;
  }

  /** 因追赶预算被截断丢弃的积压步数(诊断)。 */
  get droppedTicks(): number {
    return this.clock.droppedTicks;
  }

  resetClock(): void {
    this.clock.discardRemainder();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clock.discardRemainder();
    this.backend?.dispose();
    this.backend = undefined;
  }
}
