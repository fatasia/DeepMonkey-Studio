import type { PbrResidencyFrameTarget } from "./pbrResidencyStream.js";
import type { ResidentSceneChunkFrame } from "./sceneChunkResidencyFrame.js";
import type { PreparedBatch } from "../renderPacketTypes.js";
import { reviseSceneChunkProjection } from "./sceneChunkRevision.js";

/** Transfers the entire frame to one validated stage; the renderer publishes at its next frame boundary. */
export async function stageSceneChunkFrame(target: PbrResidencyFrameTarget, frame: ResidentSceneChunkFrame, signal?: AbortSignal,
  updates?: ReadonlyMap<string, PreparedBatch>): Promise<void> {
  let projection = frame.takeProjection();
  try {
    signal?.throwIfAborted();
    if (updates) projection = reviseSceneChunkProjection(projection, updates);
    await target.stageResidentPacketValidated(projection, signal);
  } catch (error) {
    try { if (!projection.released) projection.release(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Scene frame stage rollback failed."); }
    throw error;
  }
}
