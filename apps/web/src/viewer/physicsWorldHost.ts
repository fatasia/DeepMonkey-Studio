import type { ScenePhysicsState } from "@bim-studio/contracts";

export interface PhysicsWorldBackend {
  setGravity(gravity: ScenePhysicsState["gravity"]): void;
  step(timestep: number): void;
  dispose(): void;
}

export interface PhysicsStepResult {
  steps: number;
  simulatedSeconds: number;
}

const FIXED_TIMESTEP = 1 / 60;
const MAX_CATCH_UP_SECONDS = 0.2;

/**
 * Owns the renderer-independent PhysicsWorld clock and backend lifetime.
 * Scene/model translation stays in the Viewer adapter; deterministic stepping
 * and teardown semantics stay identical for WebGL and WebGPU renderers.
 */
export class PhysicsWorldHost {
  private backend: PhysicsWorldBackend | undefined;
  private accumulator = 0;
  private enabled = false;
  private playing = false;
  private disposed = false;
  private gravity: ScenePhysicsState["gravity"] = { x: 0, y: -9.81, z: 0 };

  configure(state: ScenePhysicsState): void {
    const wasAdvancing = this.enabled && this.playing;
    this.enabled = state.enabled;
    this.playing = state.enabled && state.playing;
    this.gravity = { ...state.gravity };
    if (wasAdvancing !== (this.enabled && this.playing)) this.accumulator = 0;
    this.backend?.setGravity(this.gravity);
  }

  attach(backend: PhysicsWorldBackend): boolean {
    if (this.disposed) return false;
    this.backend?.dispose();
    this.backend = backend;
    this.accumulator = 0;
    backend.setGravity(this.gravity);
    return true;
  }

  advance(deltaSeconds: number): PhysicsStepResult {
    if (!this.backend || !this.enabled || !this.playing || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      return { steps: 0, simulatedSeconds: 0 };
    }
    this.accumulator = Math.min(this.accumulator + deltaSeconds, MAX_CATCH_UP_SECONDS);
    let steps = 0;
    while (this.accumulator >= FIXED_TIMESTEP) {
      this.backend.step(FIXED_TIMESTEP);
      this.accumulator -= FIXED_TIMESTEP;
      steps += 1;
    }
    return { steps, simulatedSeconds: steps * FIXED_TIMESTEP };
  }

  resetClock(): void {
    this.accumulator = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.accumulator = 0;
    this.backend?.dispose();
    this.backend = undefined;
  }
}
