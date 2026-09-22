import { RUNTIME_COORDINATE_PROFILE } from "../runtimePackage/coordinates.js";
import type { RenderPacket } from "../renderPacketTypes.js";
import type { RenderView } from "../webgpu/pbrRendererTypes.js";

export interface CameraRelativeCoordinateSnapshot {
  readonly profile: typeof RUNTIME_COORDINATE_PROFILE;
  readonly revision: number;
  readonly chunkId: string;
  readonly origin: readonly [number, number, number];
}

const REBASE_DISTANCE = RUNTIME_COORDINATE_PROFILE.originGrid * 0.75;

/** GPU-only floating origin. Author world numbers remain JavaScript doubles. */
export class CameraRelativeCoordinates {
  private value: CameraRelativeCoordinateSnapshot = snapshot(0, [0, 0, 0]);
  get current(): CameraRelativeCoordinateSnapshot { return this.value; }
  candidate(eye: readonly [number, number, number]): CameraRelativeCoordinateSnapshot {
    finite(eye, "camera eye");
    if (eye.every((value, axis) => Math.abs(value - this.value.origin[axis]!) <= REBASE_DISTANCE)) return this.value;
    const grid = RUNTIME_COORDINATE_PROFILE.originGrid;
    const origin = eye.map(value => clean(Math.round(value / grid) * grid)) as [number, number, number];
    if (origin.every((value, axis) => value === this.value.origin[axis])) return this.value;
    return snapshot(this.value.revision + 1, origin);
  }
  commit(candidate: CameraRelativeCoordinateSnapshot): void {
    if (candidate.revision < this.value.revision || candidate.revision > this.value.revision + 1) throw new Error("Coordinate frame revision is stale.");
    this.value = candidate;
  }
  localizeView(view: RenderView, frame = this.value): RenderView {
    return Object.freeze({ ...view, eye: this.worldToLocal(view.eye, frame), target: this.worldToLocal(view.target, frame) });
  }
  localizePacket(packet: RenderPacket, frame = this.value): RenderPacket {
    const [x, y, z] = frame.origin;
    return Object.freeze({ ...packet, instances: Object.freeze(packet.instances.map(instance => {
      if (instance.transform.length !== 16) throw new Error("Camera-relative instance transform must be a 4x4 matrix.");
      const transform = Array.from(instance.transform, Number);
      transform[12] = localFloat(transform[12]! - x); transform[13] = localFloat(transform[13]! - y);
      transform[14] = localFloat(transform[14]! - z);
      return Object.freeze({ ...instance, transform });
    })) });
  }
  worldToLocal(world: readonly [number, number, number], frame = this.value): readonly [number, number, number] {
    finite(world, "world coordinate");
    return world.map((value, axis) => localFloat(value - frame.origin[axis]!)) as [number, number, number];
  }
  localToWorld(local: readonly [number, number, number], frame = this.value): readonly [number, number, number] {
    finite(local, "local coordinate");
    return local.map((value, axis) => clean(value + frame.origin[axis]!)) as [number, number, number];
  }
}

function snapshot(revision: number, origin: readonly [number, number, number]): CameraRelativeCoordinateSnapshot {
  const key = origin.map(value => value.toString(36)).join(".");
  return Object.freeze({ profile: RUNTIME_COORDINATE_PROFILE, revision,
    chunkId: `scene-local-coordinates-v1:${key}`, origin: Object.freeze([...origin]) as unknown as readonly [number, number, number] });
}
function localFloat(value: number): number {
  const result = Math.fround(value);
  if (!Number.isFinite(result) || Math.abs(result - value) > RUNTIME_COORDINATE_PROFILE.maxFloat32CoordinateError) {
    throw new Error("Camera-relative coordinate exceeds the scene-local-coordinates-v1 precision budget.");
  }
  return clean(result);
}
function finite(value: readonly number[], label: string): void {
  if (value.length !== 3 || value.some(item => !Number.isFinite(item))) throw new TypeError(`${label} is invalid.`);
}
function clean(value: number): number { return Object.is(value, -0) ? 0 : value; }
