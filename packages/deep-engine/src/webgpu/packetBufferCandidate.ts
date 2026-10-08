import type { PacketPreparationWork } from "../packetPreparationWork.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import { yieldProbePlan } from "../lighting/probeClipmapPlanYield.js";
import { gpuValidatedStage } from "./gpuValidatedStage.js";
import { stagePacketBufferSteps, discardPacketBufferStage, type PacketBufferStagingContext, type StagedPacketBuffers } from "./packetBufferStaging.js";
import type { TextureResources } from "./textureResources.js";
import type { PacketTextureArrayConsumer, PacketTextureArrayStage } from "./packetTextureArrayConsumer.js";

export type TextureArrayPacketStage = StagedPacketBuffers & { readonly arrayStage?: PacketTextureArrayStage };

/** Each allocation step owns its GPU scopes; old frame scopes never overlap a yielded task. */
export async function stagePacketBufferCandidate(context: PacketBufferStagingContext,
  work: PacketPreparationWork, signal: AbortSignal, arrays?: PacketTextureArrayConsumer,
  textures: TextureResources = context.textures, cooperative = true): Promise<{ staged: TextureArrayPacketStage; checked: Promise<void> }> {
  let arrayStage: PacketTextureArrayStage | undefined, staged: StagedPacketBuffers | undefined;
  const steps = stagePacketBufferSteps(context, work.prepared,
    arrays ? (set, batches) => { arrayStage = arrays.stage(textures, set, batches); return arrayStage.batches; } : undefined,
    arrays ? (set, id) => arrays.stagedBinding(arrayStage!, textures, set, id) : undefined,
    arrays?.plannedTextureIds(work.prepared.textures), work);
  const checks: Promise<void>[] = [];
  try {
    for (;;) {
      signal.throwIfAborted();
      if (context.session.state !== "ready") throw new Error("Packet GPU session is not ready.");
      const step = gpuValidatedStage(context.session.device, () => steps.next(), "GPU packet preparation failed");
      checks.push(step.checked); void step.checked.catch(() => {});
      if (step.value.done) { staged = step.value.value; break; }
      if (cooperative) await yieldProbePlan();
    }
    signal.throwIfAborted();
    const batches = arrayStage ? new Map(Array.from(staged.batches, ([key, batch]) => {
      const arrayMaterial = arrayStage!.rows.get(key); return [key, arrayMaterial ? { ...batch, arrayMaterial } : batch];
    })) : staged.batches;
    return { staged: { ...staged, batches, ...(arrayStage ? { arrayStage } : {}) }, checked: Promise.all(checks).then(() => {}) };
  } catch (error) {
    runResourceCleanup("Cooperative packet staging rollback failed.", [
      () => { if (arrayStage) arrays!.rollback(arrayStage); },
      () => { if (staged) discardPacketBufferStage(context, staged); },
    ]);
    throw error;
  } finally { steps.return(undefined as never); }
}
