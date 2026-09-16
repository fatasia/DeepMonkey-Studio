import type { DeformationSource } from "../deformation/types.js";
import { validateDeformationSnapshot } from "../deformation/validation.js";

export interface DeformationBoundsProfile {
  readonly source: DeformationSource;
  readonly revision: number;
  readonly morphRevision: number | undefined;
  readonly skinRevision: number | undefined;
  readonly morphRadii: readonly number[];
  readonly maximumWeightSum: number;
  readonly maximumWeightDeviation: number;
  readonly maximumJoint: number;
}

/** Cold source preparation; subsequent bounds queries only inspect pose-sized arrays. */
export function prepareDeformationBounds(source: DeformationSource): DeformationBoundsProfile {
  validateDeformationSnapshot({ sources: [source], poses: [] });
  const morphRadii = (source.morph?.primitive.targets ?? []).map(target => {
    let maximum = 0;
    const delta = target.positionDeltas;
    if (delta) for (let vertex = 0; vertex < delta.length; vertex += 3)
      maximum = Math.max(maximum, Math.hypot(delta[vertex]!, delta[vertex + 1]!, delta[vertex + 2]!));
    return maximum;
  });
  let maximumWeightSum = 0, maximumWeightDeviation = 0, maximumJoint = -1;
  if (source.skinning) {
    const { weights, joints, weightMode } = source.skinning;
    for (let vertex = 0; vertex < weights.length; vertex += 4) {
      let rawSum = 0, packedSum = 0;
      for (let lane = 0; lane < 4; lane++) rawSum += weights[vertex + lane]!;
      const divisor = weightMode === "preserve" ? 1 : rawSum;
      for (let lane = 0; lane < 4; lane++) {
        packedSum += Math.fround(weights[vertex + lane]! / divisor);
        maximumJoint = Math.max(maximumJoint, joints[vertex + lane]!);
      }
      maximumWeightSum = Math.max(maximumWeightSum, packedSum);
      maximumWeightDeviation = Math.max(maximumWeightDeviation, Math.abs(packedSum - 1));
    }
  }
  return Object.freeze({ source, revision: source.revision, morphRevision: source.morph?.revision,
    skinRevision: source.skinning?.revision, morphRadii: Object.freeze(morphRadii),
    maximumWeightSum, maximumWeightDeviation, maximumJoint });
}
