import type { PreparedBatch } from "../renderPacket.js";
export function snapshotPreparedLod(source: NonNullable<PreparedBatch["lod"]>): NonNullable<PreparedBatch["lod"]> {
  if (source.strategy === "author-selected") return Object.freeze({ ...source,
    levels: Object.freeze(source.levels.map(level => Object.freeze({ ...level }))), selectedLevels: Object.freeze([...source.selectedLevels]) });
  return Object.freeze({ ...source, levels: Object.freeze(source.levels.map(level => Object.freeze({ ...level }))) });
}
