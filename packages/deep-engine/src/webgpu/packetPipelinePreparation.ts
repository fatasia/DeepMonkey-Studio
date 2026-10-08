import type { PreparedBatch } from "../renderPacket.js";
import { mainPipelineKey, materialMode, rasterMode, type Pipelines } from "./pipelines.js";
import { hasSceneTransmission } from "./packetTransmission.js";

/** Shared with the draw consumer so lazy admission cannot silently choose a different variant. */
export function packetMainPipelineKey(batch: PreparedBatch, advanced: boolean, directDisplay = false): string {
  const transparent = batch.alphaMode === "BLEND" || hasSceneTransmission(batch, advanced);
  return mainPipelineKey(materialMode(batch.textures !== undefined, batch.textures?.normal !== undefined),
    transparent, rasterMode(batch.mirrored, batch.doubleSided),
    !transparent && !directDisplay && batch.alphaToCoverage === true);
}

export function preparePacketMainPipelines(pipelines: Pipelines | undefined,
  batches: readonly PreparedBatch[]): Promise<void> | undefined {
  if (!pipelines) return;
  const pending: Promise<void>[] = [];
  for (const selected of [pipelines, ...(pipelines.textureArrayFallback ? [pipelines.textureArrayFallback] : [])]) {
    const keys = batches.map(batch => packetMainPipelineKey(batch, selected.materialLayout?.advancedMaterials === true));
    const work = selected.prepareMainKeys?.(keys);
    if (work) pending.push(work);
  }
  return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
}
