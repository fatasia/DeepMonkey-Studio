import type { PacketPreparationWork } from "./packetPreparationWork.js";
import type { PreparedSkinningInput, SkinningSource, SkinningPalette } from "./webgpu/gpuSkinningTypes.js";

const skinInputs = new WeakMap<PreparedSkinningInput, { source: SkinningSource; palette: SkinningPalette }>();

/** Only the exact validator worker result may open the private prepacked GPU seam. */
export function retainPacketSkinningInputs(work: PacketPreparationWork): PacketPreparationWork {
  const sources = new Map(work.prepared.deformation?.sources.map(source => [source.id, source]) ?? []);
  for (const pose of work.prepared.deformation?.poses ?? []) {
    const source = sources.get(pose.source), packed = work.skinInputs.get(pose.id);
    if (packed && source?.skinning && pose.palette) skinInputs.set(packed, { source: source.skinning, palette: pose.palette });
  }
  return work;
}
export function assertOwnedSkinningInput(input: PreparedSkinningInput, source: SkinningSource, palette: SkinningPalette): void {
  const owned = skinInputs.get(input);
  if (owned?.source !== source || owned.palette !== palette) throw new Error("Skinning input is not owned by the validated packet candidate.");
}
