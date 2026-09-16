import { assertMorphWeightRange, packMorphWeights, prepareMorphInput } from "../webgpu/gpuMorphPacking.js";
import { packJointPalette } from "../webgpu/gpuSkinningPacking.js";
import type { DeformationPose, DeformationSnapshot } from "./types.js";
import { validateDeformationObject, validateDeformationSnapshot } from "./validation.js";

interface PoseProfile {
  readonly source: string;
  readonly jointCount?: number;
  readonly morph?: { readonly targetCount: number; readonly maximumBaseMagnitude: number; readonly maximumDeltaMagnitude: number };
}

/** Prepare once per static snapshot; hot validation never scans or repacks vertex streams. */
export class DeformationPoseValidator {
  private readonly profiles = new Map<string, PoseProfile>();

  constructor(snapshot: DeformationSnapshot) {
    validateDeformationSnapshot(snapshot);
    const sources = new Map(snapshot.sources.map(source => [source.id, source]));
    const morphProfiles = new Map<string, NonNullable<PoseProfile["morph"]>>();
    for (const source of snapshot.sources) if (source.morph) {
      const prepared = prepareMorphInput(source.morph,
        { revision: 0, values: new Float32Array(source.morph.primitive.targets.length) });
      morphProfiles.set(source.id, { targetCount: prepared.targetCount,
        maximumBaseMagnitude: prepared.maximumBaseMagnitude, maximumDeltaMagnitude: prepared.maximumDeltaMagnitude });
    }
    for (const pose of snapshot.poses) {
      const source = sources.get(pose.source)!;
      this.profiles.set(pose.id, { source: source.id,
        ...(source.skinning ? { jointCount: pose.palette!.matrices.length / 16 } : {}),
        ...(source.morph ? { morph: morphProfiles.get(source.id)! } : {}),
      });
    }
  }

  validate(poses: readonly DeformationPose[]): void {
    if (!Array.isArray(poses) || poses.length !== this.profiles.size) throw new Error("A complete prepared pose set is required.");
    const seen = new Set<string>();
    for (const pose of poses) {
      validateDeformationObject(pose, ["id", "source", "revision", "morphWeights", "palette"]);
      const profile = this.profiles.get(pose.id);
      if (!profile || seen.has(pose.id) || pose.source !== profile.source) throw new Error("Pose identity or source changed without preparation.");
      seen.add(pose.id);
      if (!Number.isSafeInteger(pose.revision) || pose.revision < 0) throw new Error("Pose revision must be nonnegative.");
      if (Boolean(profile.morph) !== (pose.morphWeights !== undefined)
        || (profile.jointCount !== undefined) !== (pose.palette !== undefined)) throw new Error("Pose fields do not match prepared source.");
      if (pose.morphWeights) {
        validateDeformationObject(pose.morphWeights, ["revision", "values"]);
        const weights = packMorphWeights(pose.morphWeights, profile.morph!.targetCount);
        assertMorphWeightRange(weights, profile.morph!.maximumBaseMagnitude, profile.morph!.maximumDeltaMagnitude);
      }
      if (pose.palette) {
        validateDeformationObject(pose.palette, ["revision", "matrices", "normalMatrices"]);
        const packed = packJointPalette(pose.palette);
        if (packed.length !== profile.jointCount! * 28) throw new Error("Pose joint count changed without preparation.");
      }
    }
  }
}
