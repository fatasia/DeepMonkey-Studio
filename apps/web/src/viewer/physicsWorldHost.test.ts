import { describe, expect, it, vi } from "vitest";
import { PhysicsWorldHost, type PhysicsWorldBackend } from "./physicsWorldHost";

function backend() {
  return {
    setGravity: vi.fn<PhysicsWorldBackend["setGravity"]>(),
    step: vi.fn<PhysicsWorldBackend["step"]>(),
    dispose: vi.fn<PhysicsWorldBackend["dispose"]>(),
  } satisfies PhysicsWorldBackend;
}

const running = { enabled: true, playing: true, gravity: { x: 0, y: -9.81, z: 0 } };

describe("PhysicsWorldHost", () => {
  it("uses a fixed clock and caps a stalled frame without renderer coupling", () => {
    const host = new PhysicsWorldHost();
    const world = backend();
    host.attach(world);
    host.configure(running);

    expect(host.advance(1 / 180)).toEqual({ steps: 0, simulatedSeconds: 0 });
    expect(host.advance(1 / 180).steps).toBe(1);
    expect(host.advance(10).steps).toBe(12);
    expect(world.step).toHaveBeenCalledTimes(13);
    expect(world.step).toHaveBeenLastCalledWith(1 / 60);
    expect(host.fixedTick).toBe(13);
    expect(host.droppedTicks).toBe(588);
  });

  it("drops partial time across pause and resume and applies gravity updates", () => {
    const host = new PhysicsWorldHost();
    const world = backend();
    host.attach(world);
    host.configure(running);
    host.advance(1 / 180);
    host.configure({ ...running, playing: false });
    host.configure({ ...running, gravity: { x: 1, y: -3, z: 2 } });

    expect(host.advance(1 / 180).steps).toBe(0);
    expect(host.advance(1 / 180).steps).toBe(1);
    expect(world.setGravity).toHaveBeenLastCalledWith({ x: 1, y: -3, z: 2 });
  });

  it("applies configuration that arrived before an async backend", () => {
    const host = new PhysicsWorldHost();
    const world = backend();
    host.configure({ ...running, gravity: { x: 2, y: -4, z: 6 } });

    host.attach(world);

    expect(world.setGravity).toHaveBeenCalledWith({ x: 2, y: -4, z: 6 });
    expect(host.advance(1 / 60).steps).toBe(1);
  });

  it("owns backend disposal and rejects a late async attachment", () => {
    const host = new PhysicsWorldHost();
    const first = backend();
    const late = backend();
    expect(host.attach(first)).toBe(true);

    host.dispose();
    host.dispose();

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(host.attach(late)).toBe(false);
    expect(late.dispose).not.toHaveBeenCalled();
  });

  it("ignores invalid and negative frame deltas", () => {
    const host = new PhysicsWorldHost();
    const world = backend();
    host.attach(world);
    host.configure(running);

    expect(host.advance(Number.NaN).steps).toBe(0);
    expect(host.advance(Number.POSITIVE_INFINITY).steps).toBe(0);
    expect(host.advance(-1).steps).toBe(0);
    expect(world.step).not.toHaveBeenCalled();
  });

  it("drives the product Rapier backend through the same host contract", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(0, 2, 0));
    world.createCollider(rapier.ColliderDesc.ball(0.25), body);
    const host = new PhysicsWorldHost();
    host.attach({
      setGravity: (gravity) => { world.gravity = { ...gravity }; },
      step: (timestep) => { world.timestep = timestep; world.step(); },
      dispose: () => world.free(),
    });
    host.configure(running);

    for (let frame = 0; frame < 60; frame += 1) host.advance(1 / 60);

    expect(body.translation().y).toBeLessThan(-2);
    host.dispose();
  });

  describe("fixed-step determinism (FixedStepClock host wiring)", () => {
    // mulberry32:确定性帧时间抖动,同 seed 同序列。
    function jitterSeries(seed: number, frames: number, minDt: number, maxDt: number): number[] {
      let state = seed >>> 0;
      const out: number[] = [];
      for (let index = 0; index < frames; index += 1) {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        out.push(minDt + (((t ^ (t >>> 14)) >>> 0) / 4294967296) * (maxDt - minDt));
      }
      return out;
    }

    /** 半隐式积分的纯函数"物理":每个固定步一次,记录逐 tick 状态。 */
    function run(frameDts: readonly number[], untilTick: number) {
      const host = new PhysicsWorldHost();
      let y = 10, vy = 0;
      const states: number[] = [];
      const stepCounts: number[] = [];
      host.attach({ setGravity: () => undefined, dispose: () => undefined,
        step: dt => { vy += -9.81 * dt; y += vy * dt; states.push(y); } });
      host.configure(running);
      for (const dt of frameDts) {
        if (host.fixedTick >= untilTick) break;
        stepCounts.push(host.advance(dt).steps);
      }
      return { states, stepCounts, tick: host.fixedTick };
    }

    it("same seed ⇒ identical per-frame step series and bitwise-identical state", () => {
      const first = run(jitterSeries(20261003, 900, 1 / 144, 1 / 40), 600);
      const second = run(jitterSeries(20261003, 900, 1 / 144, 1 / 40), 600);
      expect(second.stepCounts).toEqual(first.stepCounts);
      expect(second.states).toEqual(first.states);
      expect(first.tick).toBeGreaterThanOrEqual(600);
    });

    it("variable frame rates change only the frame partition, never the tick-indexed trajectory", () => {
      const rates = [30, 59.94, 60, 75, 120, 144].map(fps => run(Array.from({ length: 4000 }, () => 1 / fps), 600));
      const jittered = run(jitterSeries(7, 4000, 1 / 144, 1 / 30), 600);
      const reference = rates[2]!;
      for (const result of [...rates, jittered]) {
        expect(result.tick).toBeGreaterThanOrEqual(600);
        expect(result.tick).toBeLessThanOrEqual(601 + 1);
        const common = Math.min(result.states.length, reference.states.length);
        expect(result.states.slice(0, common)).toEqual(reference.states.slice(0, common));
      }
    });

    it("exact multiples never drift: 3600 frames of 1/60 s are exactly 3600 ticks, one per frame", () => {
      const result = run(Array.from({ length: 3600 }, () => 1 / 60), Infinity);
      expect(result.stepCounts.every(steps => steps === 1)).toBe(true);
      expect(result.tick).toBe(3600);
    });

    it("keeps Rapier trajectories bitwise-equal across frame partitions at the same tick", async () => {
      const rapier = (await import("@dimforge/rapier3d-compat")).default;
      await rapier.init();
      async function simulate(frameDts: readonly number[]): Promise<number[]> {
        const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
        const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(0.3, 6, -0.2).setLinvel(1, 0, 0.5));
        world.createCollider(rapier.ColliderDesc.cuboid(0.4, 0.4, 0.4).setRestitution(0.4), body);
        world.createCollider(rapier.ColliderDesc.cuboid(50, 0.1, 50).setTranslation(0, -0.1, 0), world.createRigidBody(rapier.RigidBodyDesc.fixed()));
        const host = new PhysicsWorldHost();
        const trace: number[] = [];
        host.attach({ setGravity: () => undefined, dispose: () => world.free(),
          step: dt => { world.timestep = dt; world.step(); const p = body.translation(); trace.push(p.x, p.y, p.z); } });
        host.configure(running);
        for (const dt of frameDts) { if (host.fixedTick >= 240) break; host.advance(dt); }
        host.dispose();
        return trace;
      }
      const steady = await simulate(Array.from({ length: 1000 }, () => 1 / 60));
      const jittered = await simulate(jitterSeries(99, 1000, 1 / 144, 1 / 35));
      const common = Math.min(steady.length, jittered.length);
      expect(common).toBeGreaterThanOrEqual(240 * 3);
      expect(jittered.slice(0, common)).toEqual(steady.slice(0, common));
    });
  });});
