import type { PreparedBatch } from "../renderPacket.js";
/** Selection is dynamic metadata, not a reason to rewrite instance vertex buffers. */
export function authorLodMetadataChanged(previous: PreparedBatch | undefined, next: PreparedBatch): boolean {
  const old = previous?.lod, value = next.lod;
  if (old?.strategy !== "author-selected" || value?.strategy !== "author-selected") return false;
  const changed = JSON.stringify(old) !== JSON.stringify(value);
  if (value.revision < old.revision || value.revision === old.revision && changed) throw Error("Author LOD selection changed without a newer revision.");
  return changed;
}
