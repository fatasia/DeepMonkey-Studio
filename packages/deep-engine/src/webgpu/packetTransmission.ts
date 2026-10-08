import type { PreparedBatch } from "../renderPacket.js";

/** Draw routing is internal; authored alpha and material parameters stay untouched. */
export function hasSceneTransmission(batch: PreparedBatch, advancedMaterials: boolean): boolean {
  return advancedMaterials && (batch.textures?.extendedParameters?.transmission.factor ?? 0) > 0;
}
