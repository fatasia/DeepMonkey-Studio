import { describe, expect, it } from "vitest";
import type { DynamicPhysicsBodyRuntime, DynamicPhysicsRuntime, DynamicSoftBodyRuntime } from "../runtimePackage/dynamicSceneRuntime.js";
import { ClothSolver } from "./clothSolver.js";
import { SoftBodySolver } from "./softBodySolver.js";
import { createSoftBodyRuntimeSession } from "./softBodyRuntimeHost.js";
import { fingerprintFloat64 } from "./physicsTypes.js";
import { createSoftBodyStaticCollision } from "./softBodyStaticCollision.js";

const obstacle = (shape: "sphere" | "cuboid" = "cuboid"): DynamicPhysicsBodyRuntime => ({
  id: "obstacle", type: "fixed", mass: 1, friction: 0, restitution: 0,
  initialPose: { translation: shape === "sphere" ? [0, -10, 0] : [0, -0.25, 0], rotation: [0, 0, 0, 1] },
  collider: { kind: "primitive", instanceIds: [], primitive: shape === "sphere"
    ? { shape: "sphere", radius: 10 } : { shape: "cuboid", halfExtents: [10, 0.25, 10] } },
});
const cloth = (): DynamicSoftBodyRuntime => ({
  kind: "cloth", id: "cloth", columns: 9, rows: 8, spacing: 0.1, mass: 0.2,
  compliance: 0, damping: 0.01, substeps: 16, perturbation: 0.001, seed: 7,
  origin: [-0.4, 0, 0], pinned: [63, 71],
  wind: { direction: [0, 0, -1], baseSpeed: 0.2, gustFrequency: 0.7, spatialScale: 1.5, seed: 11 },
});
const ball = (): DynamicSoftBodyRuntime => ({
  kind: "soft-body", id: "ball", mass: 0.2, damping: 0.02, substeps: 4, pinned: [],
  positions: [[0, 2, 0], [0.1, 2, 0], [0, 2.1, 0], [0, 2, 0.1], [0.05, 2.12, 0.05]],
  tets: [[0, 1, 2, 4], [0, 1, 3, 4], [0, 2, 3, 4], [1, 2, 3, 4]],
  complianceDistance: 0, complianceVolume: 0,
});
const runtime = (softBodies: DynamicSoftBodyRuntime[], body = obstacle()): DynamicPhysicsRuntime => ({
  schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: true,
  gravity: [0, -9.81, 0], bodies: [body], joints: [], softBodies,
});
const project = (body: DynamicPhysicsBodyRuntime, point: readonly number[], pinned = false) => {
  const px = new Float64Array([point[0]!]), py = new Float64Array([point[1]!]), pz = new Float64Array([point[2]!]);
  createSoftBodyStaticCollision([body], [body.id])!.project(px, py, pz, new Float64Array([pinned ? 0 : 1]));
  return [px[0]!, py[0]!, pz[0]!];
};
const assertOutside = (positions: Float64Array, shape: "sphere" | "cuboid") => {
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = [positions[i]!, positions[i+1]!, positions[i+2]!];
    if (shape === "sphere") expect(Math.hypot(x, y+10, z)).toBeGreaterThanOrEqual(10-32*Number.EPSILON*10);
    else expect(y).toBeGreaterThanOrEqual(0);
  }
};

describe("F6 fixed primitive contacts, actual solver/session consumption", () => {
  it("uses rotated OBB closest face rather than a world AABB", () => {
    const angle = Math.PI/4, s = Math.sin(angle/2), c = Math.cos(angle/2);
    const body = obstacle();
    const rotated = { ...body, initialPose: { translation: [2, 3, 4] as const, rotation: [0, 0, s, c] as const },
      collider: { kind: "primitive" as const, instanceIds: [], primitive: { shape: "cuboid" as const, halfExtents: [1, 0.2, 0.3] as const } } };
    // local (0.8,0.1,0) -> nearest local +Y face; world AABB projection would differ.
    const p = project(rotated, [2+(0.8-0.1)/Math.SQRT2, 3+(0.8+0.1)/Math.SQRT2, 4]);
    expect(p[0]).toBeCloseTo(2+(0.8-0.2)/Math.SQRT2, 14);
    expect(p[1]).toBeCloseTo(3+(0.8+0.2)/Math.SQRT2, 14);
    expect(project(rotated, [2, 3.7, 4])).toEqual([2, 3.7, 4]); // AABB inside, OBB outside
    expect(project(rotated, [2, 3, 4], true)).toEqual([2, 3, 4]);
  });
  it("sphere center tie is deterministic and finite, exterior is unchanged", () => {
    expect(project(obstacle("sphere"), [0, -10, 0])).toEqual([10, -10, 0]);
    expect(project(obstacle("sphere"), [0, 1, 0])).toEqual([0, 1, 0]);
  });
  it("rejects unknown/dynamic/duplicate/unsupported/invalid geometry without approximation", () => {
    const b = obstacle();
    const make = (value: DynamicPhysicsBodyRuntime) => createSoftBodyStaticCollision([value], [value.id]);
    expect(() => createSoftBodyStaticCollision([b], ["missing"])).toThrow(/exactly one/);
    expect(() => createSoftBodyStaticCollision([b], [b.id, b.id])).toThrow(/unique/);
    expect(() => createSoftBodyStaticCollision([b], Array.from({ length: 65 }, (_, i) => String(i)))).toThrow(/64/);
    expect(() => make({ ...b, type: "dynamic" })).toThrow(/fixed/);
    expect(() => make({ ...b, initialPose: { ...b.initialPose, rotation: [0, 0, 0, 0] } })).toThrow(/nonzero/);
    expect(() => make({ ...b, scale: [2, 1, 1] } as DynamicPhysicsBodyRuntime)).toThrow(/scale/);
    for (const half of [[0, 1, 1], [-1, 1, 1], [1, Infinity, 1]]) {
      expect(() => make({ ...b, collider: { kind: "primitive", instanceIds: [], primitive: { shape: "cuboid", halfExtents: half as [number, number, number] } } })).toThrow(/positive finite/);
    }
    expect(() => make({ ...b, collider: { kind: "primitive", instanceIds: [], primitive: { shape: "cylinder", radius: 1, halfHeight: 1 } } })).toThrow(/sphere/);
    expect(() => make({ ...b, collider: { kind: "primitive", instanceIds: [], primitive: { shape: "sphere", radius: NaN } } })).toThrow(/radius/);
  });
  it("rejects unresolved overlapping obstacles instead of leaving silent penetration", () => {
    const a = { ...obstacle(), initialPose: { translation: [0, 0, 0] as const, rotation: [0, 0, 0, 1] as const },
      collider: { kind: "primitive" as const, instanceIds: [], primitive: { shape: "cuboid" as const, halfExtents: [1, 10, 10] as const } } };
    const b = { ...a, id: "second", initialPose: { ...a.initialPose, translation: [1.5, 0, 0] as const } };
    const contacts = createSoftBodyStaticCollision([a, b], [a.id, b.id])!;
    expect(() => contacts.project(new Float64Array([0.75]), new Float64Array([0]), new Float64Array([0]), new Float64Array([1]))).toThrow(/four sweeps/);
  });
  it("keeps the existing ground constraint, and reports incompatible plane/collider projection", () => {
    const body = { ...obstacle(), initialPose: { translation: [0, 0.4, 0] as const, rotation: [0,0,0,1] as const } };
    const contacts = createSoftBodyStaticCollision([body], [body.id])!;
    const px = new Float64Array([0]), py = new Float64Array([0.18]), pz = new Float64Array([0]);
    expect(() => contacts.project(px, py, pz, new Float64Array([1]), 0.18)).toThrow(/groundY/);
    const good = createSoftBodyStaticCollision([obstacle()], ["obstacle"])!;
    good.project(px, new Float64Array([0.18]), pz, new Float64Array([1]), 0.18);
  });
  it("default and explicit empty selection retain bitwise original trajectories", () => {
    const physics = runtime([cloth(), ball()]);
    const a = createSoftBodyRuntimeSession(physics), b = createSoftBodyRuntimeSession(physics, { collisionBodyIds: [] });
    for (let i = 0; i < 180; i++) { a.step(); b.step(); }
    expect(a.capture()).toEqual(b.capture());
    // Before-source, all six SoA lanes at tick 180, not a candidate-generated golden.
    const golden: Record<string, string> = { cloth: "c9ef041b7e3c41d3", ball: "1b4fc5cb0e159383" };
    for (const [id, state] of a.capture().states) expect(fingerprintFloat64(
      [...state.px,...state.py,...state.pz,...state.vx,...state.vy,...state.vz],
    )).toBe(golden[id]);
    expect(Math.min(...Array.from(a.readout("ball")!.filter((_, i) => i%3 === 1)))).toBeLessThan(-1);
  });
  for (const shape of ["cuboid", "sphere"] as const) {
    it(`${shape}: wind cloth actual XPBD contact/stretch<=5%, pinning, replay`, () => {
      const b = cloth(); if (b.kind !== "cloth") throw new Error("fixture");
      const contacts = createSoftBodyStaticCollision([obstacle(shape)], ["obstacle"])!;
      const make = () => {
        const solver = new ClothSolver({ ...b, gravity: [0, -9.81, 0], dtSeconds: 1/60, contacts });
        for (const pin of b.pinned) solver.setPinnedIndex(pin);
        return solver;
      };
      const a = make(), second = make(), initial = a.capture();
      const control = new ClothSolver({ ...b, gravity: [0, -9.81, 0], dtSeconds: 1/60 });
      for (const pin of b.pinned) control.setPinnedIndex(pin);
      let peakStretch = 0;
      for (let tick = 0; tick < 240; tick++) {
        a.step(); second.step(); control.step(); assertOutside(a.positionsInterleaved(), shape);
        peakStretch = Math.max(peakStretch, a.measureStretch().maxRatio);
      }
      expect(peakStretch).toBeLessThanOrEqual(0.05);
      expect(a.capture()).not.toEqual(control.capture());
      expect(a.capture()).toEqual(second.capture());
      for (const pin of b.pinned) {
        for (const axis of ["px", "py", "pz", "vx", "vy", "vz"] as const) expect(a.capture()[axis][pin]).toBe(initial[axis][pin]);
      }
      const expected = a.capture(); a.restore(initial);
      for (let tick = 0; tick < 240; tick++) a.step();
      expect(a.capture()).toEqual(expected);
      console.log(JSON.stringify({ shape, kind: "cloth", ticks: 240, peakStretch }));
    });
    it(`${shape}: actual soft-body session contact/volume<=5%, velocity and replay`, () => {
      const physics = runtime([ball()], obstacle(shape));
      const make = () => createSoftBodyRuntimeSession(physics, { collisionBodyIds: ["obstacle"] });
      const a = make(), b = make(); let peakVolume = 0;
      const initial = a.capture();
      for (let tick = 0; tick < 180; tick++) {
        a.step(); b.step(); assertOutside(a.readout("ball")!, shape);
        peakVolume = Math.max(peakVolume, a.volumeError("ball")!.totalRatio);
      }
      expect(peakVolume).toBeLessThanOrEqual(0.05);
      expect(a.capture()).toEqual(b.capture());
      const expected = a.capture(); a.restore(initial);
      for (let tick = 0; tick < 180; tick++) a.step();
      expect(a.capture()).toEqual(expected);
      const state = a.capture().states.get("ball")!;
      expect(Array.from(state.vy).every(Number.isFinite)).toBe(true);
      console.log(JSON.stringify({ shape, kind: "soft-body", ticks: 180, peakVolume }));
    });
  }
  it("runtime cloth consumes the same collider and trajectories as its actual solver", () => {
    const b = cloth(); if (b.kind !== "cloth") throw new Error("fixture");
    const body = obstacle(); const contacts = createSoftBodyStaticCollision([body], [body.id])!;
    const solver = new ClothSolver({ ...b, gravity: [0,-9.81,0], dtSeconds: 1/60, contacts });
    for (const pin of b.pinned) solver.setPinnedIndex(pin);
    const session = createSoftBodyRuntimeSession(runtime([b], body), { collisionBodyIds: [body.id] });
    for (let tick = 0; tick < 240; tick++) { solver.step(); session.step(); }
    expect(session.readout(b.id)).toEqual(solver.positionsInterleaved());
  });
  it("velocity uses the contact-corrected displacement and pinned velocities remain zero", () => {
    const body = ball(); if (body.kind !== "soft-body") throw new Error("fixture");
    const solver = new SoftBodySolver({ ...body, gravity: [0,-9.81,0], dtSeconds: 1/60, substeps: 1,
      contacts: createSoftBodyStaticCollision([obstacle()], ["obstacle"])! });
    const state = solver.capture();
    for (let i = 0; i < state.py.length; i++) { state.py[i] = state.py[i]!-1.99; state.vy[i] = -2; }
    solver.restore(state); solver.step(); const after = solver.capture();
    for (let i = 0; i < after.py.length; i++) expect(after.vy[i]).toBe((after.py[i]!-state.py[i]!)*60);
    expect(Math.min(...after.py)).toBeGreaterThanOrEqual(0);
  });
});
