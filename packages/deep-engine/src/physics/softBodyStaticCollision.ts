import type { DynamicPhysicsBodyRuntime } from "../runtimePackage/dynamicSceneRuntime.js";

/** Fixed primitive, frictionless point contact. No moving-body impulse or CCD. */
export interface SoftBodyContactProjector {
  project(px: Float64Array, py: Float64Array, pz: Float64Array, inverseMass: Float64Array, groundY?: number): void;
}

interface Obstacle {
  id: string;
  center: readonly number[];
  rotation: readonly number[];
  radius: number | null;
  half: readonly number[] | null;
}

/** Explicit selection prevents accidentally approximating an unsupported collider. */
export function createSoftBodyStaticCollision(
  bodies: readonly DynamicPhysicsBodyRuntime[], ids: readonly string[],
): SoftBodyContactProjector | undefined {
  if (!ids.length) return undefined;
  if (ids.length > 64) throw new Error("Soft-body collision exceeds 64 fixed obstacles.");
  if (new Set(ids).size !== ids.length) throw new Error("Soft-body collision ids must be unique.");
  const obstacles: Obstacle[] = [...ids].sort().map(id => {
    const matches = bodies.filter(body => body.id === id);
    if (matches.length !== 1) throw new Error(`Soft-body obstacle ${id} must identify exactly one body.`);
    const body = matches[0]!;
    if (body.type !== "fixed" || body.collider.kind !== "primitive") {
      throw new Error(`Soft-body obstacle ${id} requires a fixed primitive collider.`);
    }
    if ("scale" in body || "scale" in body.initialPose) throw new Error(`Soft-body obstacle ${id} has unsupported scale.`);
    const center = [...body.initialPose.translation];
    const q = body.initialPose.rotation;
    if (center.length !== 3 || !center.every(Number.isFinite) || q.length !== 4 || !q.every(Number.isFinite)) {
      throw new Error(`Soft-body obstacle ${id} pose must be finite.`);
    }
    const length = Math.hypot(...q);
    if (!(length > 0) || !Number.isFinite(length)) throw new Error(`Soft-body obstacle ${id} quaternion must be nonzero.`);
    const [x, y, z, w] = q.map(value => value / length) as [number, number, number, number];
    // Row-major rotation. Its transpose maps world delta into the actual OBB.
    const rotation = [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w),
      2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w),
      2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)];
    const p = body.collider.primitive;
    if (p.shape === "sphere") {
      if (!(p.radius! > 0) || !Number.isFinite(p.radius)) throw new Error(`Soft-body obstacle ${id} radius must be positive finite.`);
      return { id, center, rotation, radius: p.radius!, half: null };
    }
    if (p.shape !== "cuboid" || p.halfExtents?.length !== 3 || !p.halfExtents.every(v => Number.isFinite(v) && v > 0)) {
      throw new Error(`Soft-body obstacle ${id} requires sphere or positive finite cuboid halfExtents.`);
    }
    return { id, center, rotation, radius: null, half: [...p.halfExtents] };
  });
  // Reused scratch; no arrays or contact objects allocated per particle/tick.
  const local = new Float64Array(3);
  const toLocal = (o: Obstacle, x: number, y: number, z: number): void => {
    const dx = x-o.center[0]!, dy = y-o.center[1]!, dz = z-o.center[2]!;
    const r = o.rotation;
    local[0] = r[0]!*dx+r[3]!*dy+r[6]!*dz;
    local[1] = r[1]!*dx+r[4]!*dy+r[7]!*dz;
    local[2] = r[2]!*dx+r[5]!*dy+r[8]!*dz;
  };
  const penetration = (o: Obstacle): number => o.radius !== null
    ? o.radius-Math.hypot(local[0]!, local[1]!, local[2]!)
    : Math.min(o.half![0]!-Math.abs(local[0]!), o.half![1]!-Math.abs(local[1]!), o.half![2]!-Math.abs(local[2]!));
  return { project(px, py, pz, inverseMass, groundY): void {
    for (let i = 0; i < px.length; i++) {
      if (inverseMass[i] === 0) continue;
      for (let sweep = 0; sweep < 4; sweep++) {
        let changed = false;
        if (groundY !== undefined && py[i]! < groundY) { py[i] = groundY; changed = true; }
        for (const o of obstacles) {
          toLocal(o, px[i]!, py[i]!, pz[i]!);
          if (!(penetration(o) > 0)) continue;
          if (o.radius !== null) {
            const length = Math.hypot(local[0]!, local[1]!, local[2]!);
            if (length === 0) { local[0] = o.radius; local[1] = 0; local[2] = 0; }
            else for (let axis = 0; axis < 3; axis++) local[axis] = local[axis]! * (o.radius/length);
          } else {
            let axis = 0;
            for (let candidate = 1; candidate < 3; candidate++) {
              if (o.half![candidate]!-Math.abs(local[candidate]!) < o.half![axis]!-Math.abs(local[axis]!)) axis = candidate;
            }
            local[axis] = (local[axis]! < 0 ? -1 : 1)*o.half![axis]!;
          }
          const r = o.rotation, x = local[0]!, y = local[1]!, z = local[2]!;
          px[i] = o.center[0]!+r[0]!*x+r[1]!*y+r[2]!*z;
          py[i] = o.center[1]!+r[3]!*x+r[4]!*y+r[5]!*z;
          pz[i] = o.center[2]!+r[6]!*x+r[7]!*y+r[8]!*z;
          changed = true;
        }
        if (!changed) break;
      }
      if (groundY !== undefined && py[i]! < groundY) throw new Error(`Soft-body contact particle ${i} could not preserve groundY in four sweeps.`);
      for (const o of obstacles) {
        toLocal(o, px[i]!, py[i]!, pz[i]!);
        // 32 binary64 eps bounds the two 3-term rotations, translation and norm.
        // This is rounding at the scale of the operands, not a contact thickness.
        const scale = Math.max(1, Math.abs(px[i]!), Math.abs(py[i]!), Math.abs(pz[i]!),
          Math.abs(o.center[0]!), Math.abs(o.center[1]!), Math.abs(o.center[2]!),
          o.radius ?? Math.max(o.half![0]!, o.half![1]!, o.half![2]!));
        if (penetration(o) > 32*Number.EPSILON*scale) {
          throw new Error(`Soft-body contact particle ${i} could not resolve obstacle ${o.id} in four sweeps.`);
        }
      }
    }
  } };
}
