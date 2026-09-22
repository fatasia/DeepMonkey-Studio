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

    expect(host.advance(1 / 120)).toEqual({ steps: 0, simulatedSeconds: 0 });
    expect(host.advance(1 / 120).steps).toBe(1);
    expect(host.advance(10).steps).toBe(12);
    expect(world.step).toHaveBeenCalledTimes(13);
    expect(world.step).toHaveBeenLastCalledWith(1 / 60);
  });

  it("drops partial time across pause and resume and applies gravity updates", () => {
    const host = new PhysicsWorldHost();
    const world = backend();
    host.attach(world);
    host.configure(running);
    host.advance(1 / 120);
    host.configure({ ...running, playing: false });
    host.configure({ ...running, gravity: { x: 1, y: -3, z: 2 } });

    expect(host.advance(1 / 120).steps).toBe(0);
    expect(host.advance(1 / 120).steps).toBe(1);
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
});
