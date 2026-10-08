import type { RenderPacket } from "@bim-studio/deep-engine";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";

interface Target {
  prepareRenderPacket(packet: RenderPacket, view: RenderView, signal?: AbortSignal): Promise<unknown>;
  prepareInstanceTransforms?(instances: RenderPacket["instances"], poses: NonNullable<RenderPacket["deformation"]>["poses"] | undefined,
    view: RenderView, signal?: AbortSignal): Promise<unknown>;
}

/** Compiler-owned resource objects are immutable. Check fresh resource contents too:
 * generated grids/primitives have new objects even when their data is unchanged. */
export function sameImmutableAuthorResources(before: RenderPacket, after: RenderPacket): boolean {
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
    (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((entry, index) => sameResource(entry, b?.[index]));
  if (!same(before.geometries, after.geometries) || !same(before.textures, after.textures)
    || !same(before.deformation?.sources, after.deformation?.sources)
    || JSON.stringify(before.materials) !== JSON.stringify(after.materials)
    || JSON.stringify(before.objectBindings) !== JSON.stringify(after.objectBindings)
    || before.instances.length !== after.instances.length) return false;
  return before.instances.every((instance, index) => {
    const { transform: a, ...left } = instance, { transform: b, ...right } = after.instances[index]!;
    return handedness(a) === handedness(b) && JSON.stringify(left) === JSON.stringify(right);
  });
}

export async function prepareStudioAuthorPacket(target: Target, before: RenderPacket | undefined,
  after: RenderPacket, view: RenderView, signal: AbortSignal): Promise<void> {
  if (before && target.prepareInstanceTransforms && sameImmutableAuthorResources(before, after)) {
    const frame = await target.prepareInstanceTransforms(after.instances, after.deformation?.poses, view, signal);
    if (frame !== undefined) return;
  }
  await target.prepareRenderPacket(after, view, signal);
}

function handedness(m: ArrayLike<number>): number {
  return Math.sign(m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!)
    - m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) + m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!));
}

function sameResource(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor || a.byteLength !== b.byteLength) return false;
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return left.every((value, index) => value === right[index]);
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key)
    && sameResource((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
