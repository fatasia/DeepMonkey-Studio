import type { DeformationPose, DeformationSnapshot } from "../deformation/types.js";

/** Compare owned snapshots, not caller identity: mutation without a revision is invalid. */
export function assertRevision(next: { readonly revision: number }, old: { readonly revision: number } | undefined): void {
  if (!old) return;
  if (next.revision < old.revision) throw new Error("Stale deformation revision.");
  if (next.revision === old.revision && !sameContent(next, old)) throw new Error("Deformation changed without a revision.");
}

export function assertSnapshotRevisions(next: DeformationSnapshot, old?: DeformationSnapshot): void {
  if (!old) return;
  for (const source of next.sources) {
    const previous = old.sources.find(item => item.id === source.id);
    assertRevision(source, previous);
    if (source.morph && previous?.morph) assertRevision(source.morph, previous.morph);
    if (source.skinning && previous?.skinning) assertRevision(source.skinning, previous.skinning);
  }
  for (const pose of next.poses) {
    const previous = old.poses.find(item => item.id === pose.id);
    assertRevision(pose, previous);
    if (pose.source === previous?.source) canonicalPose(pose, previous);
  }
}

export function canonicalPose(next: DeformationPose, old: DeformationPose): DeformationPose {
  assertRevision(next, old);
  if (next.source !== old.source) throw new Error("Pose source changes require prepare.");
  if (next.morphWeights && old.morphWeights) assertRevision(next.morphWeights, old.morphWeights);
  if (next.palette && old.palette) assertRevision(next.palette, old.palette);
  return Object.freeze({ ...next,
    ...(next.morphWeights ? { morphWeights: next.morphWeights.revision === old.morphWeights?.revision ? old.morphWeights : next.morphWeights } : {}),
    ...(next.palette ? { palette: next.palette.revision === old.palette?.revision ? old.palette : next.palette } : {}),
  });
}

function sameContent(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(key => Object.hasOwn(b, key)
    && sameContent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
