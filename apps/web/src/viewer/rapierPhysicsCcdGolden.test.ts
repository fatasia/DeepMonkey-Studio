import { describe, expect, it } from "vitest";
import { PhysicsWorldHost } from "./physicsWorldHost";

/** 10 cm projectile crosses a 2 cm wall within one 1/60 s step at 80 m/s. */
describe("Rapier Web CCD thin-wall golden", () => {
  it("stops a fast body before the wall, unlike the non-CCD control", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const run = (ccd: boolean): number => {
      const world = new rapier.World({ x: 0, y: 0, z: 0 });
      const wall = world.createRigidBody(rapier.RigidBodyDesc.fixed());
      world.createCollider(rapier.ColliderDesc.cuboid(0.01, 1, 1), wall);
      const projectile = world.createRigidBody(rapier.RigidBodyDesc.dynamic()
        .setTranslation(-0.6, 0, 0).setCcdEnabled(ccd));
      world.createCollider(rapier.ColliderDesc.cuboid(0.05, 0.05, 0.05), projectile);
      projectile.setLinvel({ x: 80, y: 0, z: 0 }, true);
      const host = new PhysicsWorldHost();
      host.attach({ setGravity: (gravity) => { world.gravity = { ...gravity }; },
        step: (timestep) => { world.timestep = timestep; world.step(); }, dispose: () => world.free() });
      host.configure({ enabled: true, playing: true, gravity: { x: 0, y: 0, z: 0 } });
      expect(host.advance(1 / 60).steps).toBe(1);
      const x = projectile.translation().x;
      host.dispose();
      return x;
    };

    const first = run(true), repeat = run(true), withoutCcd = run(false);
    expect(first).toBeLessThanOrEqual(-0.05);
    expect(repeat).toBeCloseTo(first, 6);
    expect(withoutCcd).toBeGreaterThan(0.5);
  });
});
