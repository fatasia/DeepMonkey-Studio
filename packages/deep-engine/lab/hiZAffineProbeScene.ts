import type { CullingInstance } from "../src/webgpu/gpuFrustumCulling.js";

export const HI_Z_AFFINE_REPEATS = 16;
export const HI_Z_AFFINE_DEPTH_REGION = [24, 24, 16, 16] as const;
export const HI_Z_AFFINE_VIEW = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
export interface HiZAffineCase {
  readonly name: string;
  readonly instance: CullingInstance;
  readonly visible: boolean;
  readonly invalid?: "nan-model" | "infinite-bound" | "negative-bound";
}

export function hiZAffineProbeCases(): readonly HiZAffineCase[] {
  const matrix = (rows: readonly number[], x = 0, z = .6) => [rows[0]!, rows[3]!, rows[6]!, 0,
    rows[1]!, rows[4]!, rows[7]!, 0, rows[2]!, rows[5]!, rows[8]!, 0, x, 0, z, 1];
  const candidate = (name: string, rows: readonly number[], visible: boolean, x = 0, z = .6): HiZAffineCase => ({
    name, instance: { modelMatrix: matrix(rows, x, z), bounds: [0, 0, 0, .1] }, visible,
  });
  const r = Math.SQRT1_2, identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return [
    candidate("identity-hidden", identity, false),
    candidate("rotation-hidden", [r, -r, 0, r, r, 0, 0, 0, 1], false),
    candidate("reflected-rotation-hidden", [-r, -r, 0, -r, r, 0, 0, 0, 1], false),
    candidate("rotated-nonuniform-hidden", [.8 * r, -r, 0, .8 * r, r, 0, 0, 0, .6], false),
    candidate("shear-visible", [1, 1, 0, 0, 1, 0, 0, 0, 1], true, .45),
    candidate("reflected-shear-visible", [-1, 1, 0, 0, 1, 0, 0, 0, 1], true, .45),
    candidate("nonuniform-visible", [3, 0, 0, 0, .4, 0, 0, 0, .6], true),
    candidate("near-clip-visible", identity, true, 0, .05),
    { ...candidate("nan-model-visible", identity, true), invalid: "nan-model" },
    { ...candidate("infinite-bound-visible", identity, true), invalid: "infinite-bound" },
    { ...candidate("negative-bound-visible", identity, true), invalid: "negative-bound" },
  ];
}

/** Independent depth oracle for the rasterized 16×16 occluder and max-reduced mips. */
export function hiZAffineDepthSamples(uvRect: readonly [number, number, number, number], mip: number): number[] {
  const size = Math.max(1, 64 >> mip), span = 64 / size;
  const [left, top, width, height] = HI_Z_AFFINE_DEPTH_REGION;
  return [[uvRect[0], uvRect[1]], [uvRect[2], uvRect[1]], [uvRect[0], uvRect[3]], [uvRect[2], uvRect[3]]]
    .map(([u, v]) => {
      const x = Math.min(size - 1, Math.floor(u! * size)) * span;
      const y = Math.min(size - 1, Math.floor(v! * size)) * span;
      return x >= left && x + span <= left + width && y >= top && y + span <= top + height ? .3 : 1;
    });
}
