import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ViewerEngineRendering } from "./viewerEngineRendering";
import { createModelFireEffect } from "./modelFireEffect";
import { SCENE_FIRE_PARTICLE_BUDGET } from "./modelFireParticles";
import type { ModelEffectRuntime } from "./viewerEngineTypes";

type Harness = {
  modelEffectRuntimes: Map<string, ModelEffectRuntime>;
  fireBudgetDirty: boolean;
  rebalanceFireBudget(): void;
  getParticleBudgetReport: ViewerEngineRendering["getParticleBudgetReport"];
  updateModelEffects(delta: number): void;
  camera: THREE.Camera;
};

function harness(emitters: number, density: number): Harness {
  const engine = Object.create(ViewerEngineRendering.prototype) as Harness;
  engine.modelEffectRuntimes = new Map();
  engine.fireBudgetDirty = false;
  engine.camera = new THREE.PerspectiveCamera();
  for (let index = 0; index < emitters; index += 1) {
    const model = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
    const fire = createModelFireEffect(model, { enabled: true, color: "#ff5500", intensity: 2, height: 2, density })!;
    engine.modelEffectRuntimes.set(`m${index}`, { originals: new Map(), generated: [], fire });
  }
  return engine;
}

describe("viewer engine fire particle budget", () => {
  it("keeps every emitter at its request while the scene is within budget", () => {
    const engine = harness(4, 1);
    engine.rebalanceFireBudget();
    const report = engine.getParticleBudgetReport();
    expect(report.degraded).toBe(false);
    for (const runtime of engine.modelEffectRuntimes.values()) expect(runtime.fire!.allocatedCount).toBe(80);
  });

  it("degrades all emitters proportionally past the scene budget and recovers when emitters leave", () => {
    const engine = harness(10, 2);
    engine.fireBudgetDirty = true;
    engine.updateModelEffects(0.016);
    const report = engine.getParticleBudgetReport();
    expect(report.degraded).toBe(true);
    const allocated = [...engine.modelEffectRuntimes.values()].reduce((sum, runtime) => sum + runtime.fire!.allocatedCount, 0);
    expect(allocated).toBe(SCENE_FIRE_PARTICLE_BUDGET);
    for (const runtime of engine.modelEffectRuntimes.values()) {
      expect(runtime.fire!.points.geometry.drawRange.count).toBe(runtime.fire!.allocatedCount);
    }
    for (let index = 3; index < 10; index += 1) engine.modelEffectRuntimes.delete(`m${index}`);
    engine.fireBudgetDirty = true;
    engine.updateModelEffects(0.016);
    for (const runtime of engine.modelEffectRuntimes.values()) expect(runtime.fire!.allocatedCount).toBe(160);
    expect(engine.getParticleBudgetReport().degraded).toBe(false);
  });
});
