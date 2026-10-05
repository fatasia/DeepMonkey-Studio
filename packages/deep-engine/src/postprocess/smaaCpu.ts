/**
 * SMAA CPU mirror — formula-for-formula TS mirror of the three-pass WGSL chain
 * (smaaEdgeDetectionWgsl / smaaBlendWeightsWgsl / smaaNeighborhoodBlendingWgsl, which
 * port Three r185 SMAAShader.js, iryoku/smaa v2.8 SMAA 1x Medium, MIT; license in
 * spatialAa.LICENSE.md). This module is the CPU authority the GPU probes are validated
 * against. Storage semantics match the GPU targets: edges rg8unorm (8-bit quantized),
 * weights float (rgba16float), source float display-encoded RGBA in [0,1] (same host
 * contract as resolveSpatialAaCpu).
 */
import { decodeSmaaAreaLut, decodeSmaaSearchLut } from "./smaaLuts.js";
import { smaaArea, smaaRoundHalfAway, smaaSampleEdges, smaaSearchXLeft, smaaSearchXRight, smaaSearchYDown, smaaSearchYUp } from "./smaaCpuWeights.js";
import { smaaCalculateDiagWeights, smaaDetectHorizontalCornerPattern, smaaDetectVerticalCornerPattern } from "./smaaCpuDiag.js";

export interface SmaaCpuImage { readonly width: number; readonly height: number; readonly color: ArrayLike<number> }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** 源纹理(display-encoded float RGBA)双线性采样,镜像 fn smaaSampleColor。 */
function sampleColor(image: SmaaCpuImage, u: number, v: number): number[] {
  const { width, height, color } = image;
  const tx = u * width - 0.5, ty = v * height - 0.5;
  const x0 = Math.floor(tx), y0 = Math.floor(ty), fx = tx - x0, fy = ty - y0;
  const result = [0, 0, 0, 0];
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const px = (clamp(y0 + j, 0, height - 1) * width + clamp(x0 + i, 0, width - 1)) * 4;
    const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
    for (let c = 0; c < 4; c++) result[c]! += color[px + c]! * weight;
  }
  return result;
}

/** SMAAColorEdgeDetectionPS — 色彩边缘检测 + 局部对比度自适应(SMAA_THRESHOLD 0.1)。 */
export function smaaColorEdgeDetectionPS(image: SmaaCpuImage, texcoordU: number, texcoordV: number,
  out: Uint8Array, offset: number): void {
  const resolutionX = 1 / image.width, resolutionY = 1 / image.height;
  const threshold = 0.1;
  // Calculate color deltas:
  let delta = [0, 0, 0, 0];
  const C = sampleColor(image, texcoordU, texcoordV);
  const maxChannel = (a: number[], b: number[]) => Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
  // offset[0]!.xy / offset[0]!.zw (SMAAEdgeDetectionVS):
  delta[0] = maxChannel(C, sampleColor(image, texcoordU - resolutionX, texcoordV));
  delta[1] = maxChannel(C, sampleColor(image, texcoordU, texcoordV + resolutionY));
  // We do the usual threshold:
  let edges = [Number(threshold <= delta[0]!), Number(threshold <= delta[1]!)];
  // Then discard if there is no edge (write zero; the edges target is cleared to zero):
  if (edges[0]! + edges[1]! === 0) return;
  // Calculate right and bottom deltas (offset[1]!.xy / offset[1]!.zw):
  delta[2] = maxChannel(C, sampleColor(image, texcoordU + resolutionX, texcoordV));
  delta[3] = maxChannel(C, sampleColor(image, texcoordU, texcoordV - resolutionY));
  // Calculate the maximum delta in the direct neighborhood:
  let maxDelta = Math.max(delta[0]!, delta[1]!, delta[2]!, delta[3]!);
  // Calculate left-left and top-top deltas (offset[2]!.xy / offset[2]!.zw):
  delta[2] = maxChannel(C, sampleColor(image, texcoordU - 2 * resolutionX, texcoordV));
  delta[3] = maxChannel(C, sampleColor(image, texcoordU, texcoordV + 2 * resolutionY));
  // Calculate the final maximum delta:
  maxDelta = Math.max(maxDelta, delta[2]!, delta[3]!);
  // Local contrast adaptation in action:
  edges = edges.map((value, index) => value * Number(0.5 * maxDelta <= delta[index]!));
  out[offset] = Math.round(edges[0]! * 255); // rg8unorm storage semantics
  out[offset + 1] = Math.round(edges[1]! * 255);
}

/**
 * SMAABlendingWeightCalculationPS — 搜索 + 交叉边缘 + AreaTex 权重(官方 PRESET_HIGH:
 * 对角线优先 + 转角检测;对角线命中即跳过正交处理)。edges 为 rg8unorm 存储(0..255);
 * 返回 float RGBA(rgba16float 语义)。
 */
export function smaaBlendingWeightCalculationPS(image: SmaaCpuImage, edges: Uint8Array, area: Uint8Array,
  search: Uint8Array, texcoordU: number, texcoordV: number): [number, number, number, number] {
  const width = image.width, height = image.height;
  const resolutionX = 1 / width, resolutionY = 1 / height;
  const pixcoordX = texcoordU / resolutionX, pixcoordY = texcoordV / resolutionY;

  // SMAABlendingWeightCalculationVS (computed per-fragment):
  const offset0 = [texcoordU - 0.25 * resolutionX, texcoordV + 0.125 * resolutionY,
    texcoordU + 1.25 * resolutionX, texcoordV + 0.125 * resolutionY];
  const offset1 = [texcoordU - 0.125 * resolutionX, texcoordV + 0.25 * resolutionY,
    texcoordU - 0.125 * resolutionX, texcoordV - 1.25 * resolutionY];
  // And these for the searches, they indicate the ends of the loops:
  const offset2 = [offset0[0]! - 2 * resolutionX * 16, offset0[2]! + 2 * resolutionX * 16,
    offset1[1]! - 2 * resolutionY * 16, offset1[3]! + 2 * resolutionY * 16];

  const weights: [number, number, number, number] = [0, 0, 0, 0];
  const e = smaaSampleEdges(edges, width, height, texcoordU, texcoordV);

  if (e[1]! > 0) { // Edge at north
    // Diagonals have both north and west edges, so searching for them in one of the
    // boundaries is enough; a found diagonal gets priority over orthogonal processing.
    const diag = smaaCalculateDiagWeights(edges, area, width, height, [texcoordU, texcoordV], e);
    weights[0] = diag[0]!; weights[1]! = diag[1]!;
    if (diag[0]! + diag[1]! === 0) { // weights.r == -weights.g (no diagonal found)
      // Find the distance to the left:
      const coords = [0, 0];
      coords[0] = smaaSearchXLeft(edges, search, width, height, [offset0[0]!, offset0[1]!], offset2[0]!);
      coords[1] = offset1[1]!; // offset[1]!.y = texcoord.y - 0.25 * resolution.y (@CROSSING_OFFSET)
      let d0 = coords[0]!;
      const leftX = coords[0]!;
      // Now fetch the left crossing edges (bilinear at the @CROSSING_OFFSET sample point):
      const e1 = smaaSampleEdges(edges, width, height, coords[0]!, coords[1]!)[0];
      // Find the distance to the right:
      coords[0] = smaaSearchXRight(edges, search, width, height, [offset0[2]!, offset0[3]!], offset2[1]!);
      const rightX = coords[0]!;
      let d1 = coords[0]!;
      // We want the distances to be in pixel units (official variant: rounded + absolute):
      d0 = Math.abs(smaaRoundHalfAway(d0 / resolutionX - pixcoordX));
      d1 = Math.abs(smaaRoundHalfAway(d1 / resolutionX - pixcoordX));
      // SMAAArea below needs a sqrt, as the areas texture is compressed quadratically:
      const sqrtD = [Math.sqrt(d0), Math.sqrt(d1)];
      // Fetch the right crossing edges (WebGL port note: Added; ivec2(1, 0) offset):
      const shiftedY = coords[1]! - resolutionY;
      const e2 = smaaSampleEdges(edges, width, height, coords[0]! + resolutionX, shiftedY)[0]!;
      const blended = smaaArea(area, sqrtD, e1, e2, 0); // float(subsampleIndices.y)
      const cornered = smaaDetectHorizontalCornerPattern(edges, width, height, blended,
        [leftX, texcoordV, rightX, texcoordV], [d0, d1]);
      weights[0] = cornered[0]!; weights[1]! = cornered[1]!;
    } else {
      e[0] = 0; // Skip vertical processing (diagonal found).
    }
  }

  if (e[0]! > 0) { // Edge at west
    // Find the distance to the top:
    const coords = [0, 0];
    coords[1] = smaaSearchYUp(edges, search, width, height, [offset1[0]!, offset1[1]!], offset2[2]!);
    coords[0] = offset0[0]!; // offset[1]!.x = texcoord.x - 0.25 * resolution.x;
    let d0 = coords[1]!;
    const topY = coords[1]!;
    // Fetch the top crossing edges:
    const e1 = smaaSampleEdges(edges, width, height, coords[0]!, coords[1]!)[1];
    // Find the distance to the bottom:
    coords[1] = smaaSearchYDown(edges, search, width, height, [offset1[2]!, offset1[3]!], offset2[3]!);
    const bottomY = coords[1]!;
    let d1 = coords[1]!;
    // We want the distances to be in pixel units:
    d0 = Math.abs(smaaRoundHalfAway(d0 / resolutionY - pixcoordY));
    d1 = Math.abs(smaaRoundHalfAway(d1 / resolutionY - pixcoordY));
    const sqrtD = [Math.sqrt(d0), Math.sqrt(d1)];
    // Fetch the bottom crossing edges (WebGL port note: Added; ivec2(0, 1) offset):
    const shiftedY = coords[1]! - resolutionY;
    const e2 = smaaSampleEdges(edges, width, height, coords[0]!, shiftedY + resolutionY)[1]!;
    const blended = smaaArea(area, sqrtD, e1, e2, 0); // float(subsampleIndices.x)
    const cornered = smaaDetectVerticalCornerPattern(edges, width, height, blended,
      [texcoordU, topY, texcoordU, bottomY], [d0, d1]);
    weights[2] = cornered[0]!; weights[3]! = cornered[1]!;
  }

  return weights;
}

/**
 * SMAANeighborhoodBlendingPS — 按最强权重向邻域混合。
 * 域适配(与 WGSL 同注):display 域直接混合,省略上游 pow(2.2) 包裹。
 */
export function smaaNeighborhoodBlendingPS(image: SmaaCpuImage, weights: Float32Array, texcoordU: number, texcoordV: number): number[] {
  const resolutionX = 1 / image.width, resolutionY = 1 / image.height;
  const at = (u: number, v: number): number[] => {
    const tx = u * image.width - 0.5, ty = v * image.height - 0.5;
    const x0 = Math.floor(tx), y0 = Math.floor(ty), fx = tx - x0, fy = ty - y0;
    const result = [0, 0, 0, 0];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const px = (clamp(y0 + j, 0, image.height - 1) * image.width + clamp(x0 + i, 0, image.width - 1)) * 4;
      const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      for (let c = 0; c < 4; c++) result[c]! += weights[px + c]! * w;
    }
    return result;
  };
  // Fetch the blending weights for current pixel:
  const center = at(texcoordU, texcoordV);
  const a = [center[0]!, at(texcoordU, texcoordV - resolutionY)[1],
    center[2]!, at(texcoordU + resolutionX, texcoordV)[3]]; // a.xz center, a.y offset[1]!.zw, a.w offset[1]!.xy

  // Is there any blending weight with a value greater than 0.0?
  if (a[0]! + a[1]! + a[2]! + a[3]! < 1e-5) return sampleColor(image, texcoordU, texcoordV);
  // Up to 4 lines can be crossing a pixel; favor the maximum weight per direction:
  // 官方 `offset.x = a.a > a.b ? a.a : -a.b`:右邻的水平权重(a[3])对本像素的水平权重
  // (a[2] = center.b)—— 此前误比 a[1](下方垂直权重,官方 a.y 只用于 offsetY);
  // 2026-10-05 parity 残差排查以 three r185 SMAAShader.js 原文仲裁修正。
  let offsetX = a[3]! > a[2]! ? a[3]! : -a[2]!; // left vs. right
  let offsetY = a[1]! > a[0]! ? -a[1]! : a[0]!; // top vs. bottom // WebGL port note: Changed signs
  if (Math.abs(offsetX) > Math.abs(offsetY)) offsetY = 0; else offsetX = 0; // horizontal vs. vertical
  // Fetch the opposite color and lerp by hand:
  const C = sampleColor(image, texcoordU, texcoordV);
  const signX = Math.sign(offsetX), signY = Math.sign(offsetY);
  const Cop = sampleColor(image, texcoordU + signX * resolutionX, texcoordV + signY * resolutionY);
  const s = Math.abs(offsetX) > Math.abs(offsetY) ? Math.abs(offsetX) : Math.abs(offsetY);
  return C.map((value, index) => value + (Cop[index]! - value) * s);
}

/**
 * SMAA 三 pass CPU 镜像入口:display-encoded RGBA 输入 → 抗锯齿输出(float RGBA)。
 * 校验与 resolveSpatialAaCpu 同契约(fail-closed);中间纹理每次调用重建(测试规模)。
 */
export function resolveSmaaCpu(image: SmaaCpuImage, luts?: { area: Uint8Array; search: Uint8Array }): Float32Array {
  const { width, height, color } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > 16_777_216 || color.length !== width * height * 4) throw new Error("Invalid spatial AA image dimensions.");
  for (let i = 0; i < color.length; i++) if (!Number.isFinite(color[i]!) || color[i]! < 0 || color[i]! > 1) {
    throw new Error("Spatial AA requires finite display-encoded RGBA inside [0, 1].");
  }
  const area = luts?.area ?? decodeSmaaAreaLut(), search = luts?.search ?? decodeSmaaSearchLut();
  // Pass 1: edges (rg8unorm storage).
  const edges = new Uint8Array(width * height * 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    smaaColorEdgeDetectionPS(image, (x + 0.5) / width, (y + 0.5) / height, edges, (y * width + x) * 2);
  }
  // Pass 2: blend weights (float storage).
  const weights = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = smaaBlendingWeightCalculationPS(image, edges, area, search, (x + 0.5) / width, (y + 0.5) / height);
    weights.set(value, (y * width + x) * 4);
  }
  // Pass 3: neighborhood blending.
  const output = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    output.set(smaaNeighborhoodBlendingPS(image, weights, (x + 0.5) / width, (y + 0.5) / height), (y * width + x) * 4);
  }
  return output;
}
