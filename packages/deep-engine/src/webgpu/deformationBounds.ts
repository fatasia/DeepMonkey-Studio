import type { DeformationPose, DeformationSource } from "../deformation/types.js";
import { prepareDeformationBounds, type DeformationBoundsProfile } from "./deformationBoundsProfile.js";
export { prepareDeformationBounds, type DeformationBoundsProfile } from "./deformationBoundsProfile.js";

export interface DeformationBoundsEnvelope {
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly conservative: true;
}

const profiles = new WeakMap<DeformationSource, DeformationBoundsProfile>();

/** Base sphere must enclose the source positions. Source edits require a new revision. */
export function deformationBoundsEnvelope(source: DeformationSource, pose: DeformationPose,
  center: readonly [number, number, number], radius: number,
  prepared?: DeformationBoundsProfile): DeformationBoundsEnvelope {
  if (!Number.isFinite(radius) || radius < 0 || center.length !== 3 || center.some(value => !Number.isFinite(value)))
    throw new TypeError("Base deformation bounds must be finite.");
  let profile = prepared ?? profiles.get(source);
  if (!profile || !matches(profile, source)) {
    if (prepared) throw new Error("Deformation bounds profile is stale or belongs to another source.");
    profile = prepareDeformationBounds(source);
    profiles.set(source, profile);
  }
  if (pose.source !== source.id || Boolean(pose.morphWeights) !== Boolean(source.morph)
    || Boolean(pose.palette) !== Boolean(source.skinning)) throw new Error("Bounds pose does not match source.");
  let morphRadius = radius;
  if (pose.morphWeights) {
    const weights = pose.morphWeights.values;
    if (!(weights instanceof Float32Array) || weights.length !== profile.morphRadii.length)
      throw new Error("Bounds morph weight count does not match source.");
    for (let index = 0; index < weights.length; index++) {
      if (!Number.isFinite(weights[index])) throw new Error("Bounds morph weights must be finite.");
      morphRadius += Math.abs(weights[index]!) * profile.morphRadii[index]!;
    }
  }
  let envelopeRadius = morphRadius;
  let arithmeticMagnitude = Math.hypot(...center) + morphRadius;
  if (pose.palette) {
    const matrices = pose.palette.matrices;
    if (!(matrices instanceof Float32Array) || matrices.length % 16 !== 0
      || matrices.length / 16 <= profile.maximumJoint) throw new Error("Bounds palette does not cover source joints.");
    let maximumJointRadius = 0;
    for (let joint = 0; joint < matrices.length; joint += 16) {
      for (let lane = 0; lane < 16; lane++) if (!Number.isFinite(matrices[joint + lane]))
        throw new Error("Bounds palette must be finite.");
      const [x, y, z] = center;
      const displacement = Math.hypot(
        matrices[joint]! * x + matrices[joint + 4]! * y + matrices[joint + 8]! * z + matrices[joint + 12]! - x,
        matrices[joint + 1]! * x + matrices[joint + 5]! * y + matrices[joint + 9]! * z + matrices[joint + 13]! - y,
        matrices[joint + 2]! * x + matrices[joint + 6]! * y + matrices[joint + 10]! * z + matrices[joint + 14]! - z);
      const scale = matrixScale(matrices, joint);
      maximumJointRadius = Math.max(maximumJointRadius, displacement + scale * morphRadius);
      const translation = Math.hypot(matrices[joint + 12]!, matrices[joint + 13]!, matrices[joint + 14]!);
      arithmeticMagnitude = Math.max(arithmeticMagnitude,
        scale * (Math.hypot(...center) + morphRadius) + translation);
    }
    // sum(w*T(p))-c = sum(w*(T(p)-c)) + (sum(w)-1)*c.
    envelopeRadius = profile.maximumWeightSum * maximumJointRadius
      + profile.maximumWeightDeviation * Math.hypot(...center);
    arithmeticMagnitude *= Math.max(1, profile.maximumWeightSum);
  }
  if (!Number.isFinite(Math.fround(envelopeRadius)) || !Number.isFinite(Math.fround(arithmeticMagnitude)))
    throw new Error("Deformation bounds exceed finite float32 range.");
  // 留出 float32 乘加与球体上传舍入空间；有限输出的单测不是 GPU 精度证明。
  envelopeRadius = Math.max(1e-6, envelopeRadius + arithmeticMagnitude * (profile.morphRadii.length + 1) * 2e-6);
  if (!Number.isFinite(Math.fround(envelopeRadius))) throw new Error("Deformation bounds exceed finite float32 range.");
  return Object.freeze({ center: Object.freeze([...center] as [number, number, number]),
    radius: envelopeRadius, conservative: true });
}

function matches(profile: DeformationBoundsProfile, source: DeformationSource): boolean {
  return profile.source === source && profile.revision === source.revision
    && profile.morphRevision === source.morph?.revision && profile.skinRevision === source.skinning?.revision;
}

/** ||A||₂² = spectral radius(AᵀA) <= maximum absolute row sum(AᵀA). */
function matrixScale(matrices: Float32Array, offset: number): number {
  let maximum = 0;
  for (let column = 0; column < 3; column++) {
    let rowSum = 0;
    for (let other = 0; other < 3; other++) {
      let dot = 0;
      for (let row = 0; row < 3; row++) dot += matrices[offset + column * 4 + row]! * matrices[offset + other * 4 + row]!;
      rowSum += Math.abs(dot);
    }
    maximum = Math.max(maximum, rowSum);
  }
  return Math.sqrt(maximum);
}
