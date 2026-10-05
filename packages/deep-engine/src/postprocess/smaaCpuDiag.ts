/**
 * SMAA diagonal + corner CPU mirror — formula-for-formula TS mirror of smaaDiagWgsl.ts
 * (iryoku/smaa v2.8 SMAA.hlsl SMAA_PRESET_HIGH diagonal detection and corner rounding,
 * MIT; license in spatialAa.LICENSE.md). Storage semantics match the GPU targets:
 * edges rg8unorm (8-bit quantized), AreaTex 8-bit LUTs.
 */
import { smaaSampleArea, smaaSampleEdges, smaaSampleEdgesOffset } from "./smaaCpuWeights.js";

const AREA_TEX_MAX_DISTANCE_DIAG = 20; // SMAA_AREATEX_MAX_DISTANCE_DIAG
const CORNER_ROUNDING_NORM = 25 / 100; // SMAA_CORNER_ROUNDING_NORM (SMAA_PRESET_HIGH)

/** SMAASearchDiag1 — diagonal search along dir; returns (step, edgeSum), edge via outEdge. */
export function smaaSearchDiag1(edges: Uint8Array, width: number, height: number, texcoord: [number, number],
  dir: [number, number], outEdge: { value: number[] }): [number, number] {
  let x = texcoord[0]!, y = texcoord[1]!, step = -1, edgeSum = 1;
  while (step < 8 - 1 && edgeSum > 0.9) { // SMAA_MAX_SEARCH_STEPS_DIAG
    x += dir[0]! / width; y += dir[1]! / height; step += 1;
    const e = smaaSampleEdges(edges, width, height, x, y);
    outEdge.value = e;
    edgeSum = 0.5 * e[0]! + 0.5 * e[1]!;
  }
  return [step, edgeSum];
}

/** SMAASearchDiag2 — mirror diagonal search (official non-optimized @SearchDiag2Optimization). */
export function smaaSearchDiag2(edges: Uint8Array, width: number, height: number, texcoord: [number, number],
  dir: [number, number], outEdge: { value: number[] }): [number, number] {
  let x = texcoord[0]! + 0.25 / width, y = texcoord[1]!, step = -1, edgeSum = 1;
  while (step < 8 - 1 && edgeSum > 0.9) {
    x += dir[0]! / width; y += dir[1]! / height; step += 1;
    const e = smaaSampleEdges(edges, width, height, x, y);
    // e.r one texel right, e.g in place (decodes to the same values as the optimized variant):
    const pair = [smaaSampleEdgesOffset(edges, width, height, x, y, 1, 0)[0]!, e[1]!];
    outEdge.value = pair;
    edgeSum = 0.5 * pair[0]! + 0.5 * pair[1]!;
  }
  return [step, edgeSum];
}

/** SMAAAreaDiag — diagonal areas (second half of the AreaTex, no quadratic compression). */
export function smaaAreaDiag(area: Uint8Array, dist: number[], e: number[], offset: number): [number, number] {
  const texcoordX = AREA_TEX_MAX_DISTANCE_DIAG * e[0]! + dist[0]!;
  const texcoordY = AREA_TEX_MAX_DISTANCE_DIAG * e[1]! + dist[1]!;
  const u = (1 / 160) * texcoordX + 0.5 * (1 / 160) + 0.5; // diagonal half of the texture
  const v = (1 / 560) * texcoordY + 0.5 * (1 / 560) + (1 / 7) * offset;
  return smaaSampleArea(area, u, v);
}

/** SMAACalculateDiagWeights — both diagonals; zero result means "no diagonal found". */
export function smaaCalculateDiagWeights(edges: Uint8Array, area: Uint8Array, width: number, height: number,
  texcoord: [number, number], e: number[]): [number, number] {
  let weights: [number, number] = [0, 0];
  const outEdge = { value: [0, 0] as [number, number] };
  // Search for the line ends:
  const d = [0, 0, 0, 0] as [number, number, number, number];
  if (e[0]! > 0) {
    const [step, edgeSum] = smaaSearchDiag1(edges, width, height, texcoord, [-1, 1], outEdge);
    d[0] = step + (outEdge.value[1]! > 0.9 ? 1 : 0); d[2]! = edgeSum;
  }
  {
    const [step, edgeSum] = smaaSearchDiag1(edges, width, height, texcoord, [1, -1], outEdge);
    d[1] = step; d[3]! = edgeSum;
  }
  if (d[0]! + d[1]! > 2) { // d.x + d.y + 1 > 3
    // Fetch the crossing edges (official non-optimized variant):
    // 官方坐标(mad(float4(-d.x + 0.25, d.x, d.y, -d.y - 0.25), RT_METRICS.xyxy, texcoord.xyxy)):
    // 第一对角块(-1,+1)的 x/y 都绑定 d.x,第二对角块(+1,-1)的 x/y 都绑定 d.y ——
    // 此前 cy 误绑 d[1](与 WGSL smaaDiagWgsl 的 `texcoord.y + d.x * resolution.y` 不符;
    // 2026-10-05 parity 残差排查以 iryoku/smaa master SMAA.hlsl 原文仲裁修正)。
    const cx = texcoord[0]! + (-d[0]! + 0.25) / width, cy = texcoord[1]! + d[0]! / height;
    const cz = texcoord[0]! + d[1]! / width, cw = texcoord[1]! + (-d[1]! - 0.25) / height;
    const c0 = smaaSampleEdgesOffset(edges, width, height, cx, cy, -1, 0)[1]!;
    const c1 = smaaSampleEdges(edges, width, height, cx, cy)[0]!;
    const c2 = smaaSampleEdgesOffset(edges, width, height, cz, cw, 1, 0)[1]!;
    const c3 = smaaSampleEdgesOffset(edges, width, height, cz, cw, 1, -1)[0]!;
    // Merge crossing edges at each side into a single value:
    let cc0 = 2 * c0 + c1, cc1 = 2 * c2 + c3;
    // Remove the crossing edge if we didn't find the end of the line (SMAAMovc):
    if (d[2]! >= 0.9) cc0 = 0;
    if (d[3]! >= 0.9) cc1 = 0;
    // Fetch the areas for this line:
    const blended = smaaAreaDiag(area, [d[0]!, d[1]!], [cc0, cc1], 0);
    weights = [weights[0]! + blended[0]!, weights[1]! + blended[1]!];
  }
  // Search for the line ends:
  {
    const [step, edgeSum] = smaaSearchDiag2(edges, width, height, texcoord, [-1, -1], outEdge);
    d[0] = step; d[2] = edgeSum;
  }
  if (smaaSampleEdgesOffset(edges, width, height, texcoord[0]!, texcoord[1]!, 1, 0)[0] > 0) {
    const [step, edgeSum] = smaaSearchDiag2(edges, width, height, texcoord, [1, 1], outEdge);
    d[1] = step + (outEdge.value[1]! > 0.9 ? 1 : 0); d[3] = edgeSum;
  }
  if (d[0]! + d[1]! > 2) {
    // Fetch the crossing edges:
    const cx = texcoord[0]! - d[0]! / width, cy = texcoord[1]! - d[0]! / height;
    const cz = texcoord[0]! + d[1]! / width, cw = texcoord[1]! + d[1]! / height;
    const c0 = smaaSampleEdgesOffset(edges, width, height, cx, cy, -1, 0)[1]!;
    const c1 = smaaSampleEdgesOffset(edges, width, height, cx, cy, 0, -1)[0]!;
    const c2 = smaaSampleEdgesOffset(edges, width, height, cz, cw, 1, 0)[1]!;
    const c3 = smaaSampleEdgesOffset(edges, width, height, cz, cw, 1, 0)[0]!;
    let cc0 = 2 * c0 + c1, cc1 = 2 * c2 + c3;
    if (d[2]! >= 0.9) cc0 = 0;
    if (d[3]! >= 0.9) cc1 = 0;
    const blended = smaaAreaDiag(area, [d[0]!, d[1]!], [cc0, cc1], 0);
    weights = [weights[0]! + blended[1]!, weights[1]! + blended[0]!]; // .gr
  }
  return weights;
}

/** SMAADetectHorizontalCornerPattern — dampen weights near corners of horizontal lines. */
export function smaaDetectHorizontalCornerPattern(edges: Uint8Array, width: number, height: number,
  weights: number[], coords: number[], d: number[]): [number, number] {
  const leftRight = [Number(d[1]! >= d[0]!), Number(d[0]! >= d[1]!)]; // step(d.xy, d.yx)
  let r0 = (1 - CORNER_ROUNDING_NORM) * leftRight[0]!;
  let r1 = (1 - CORNER_ROUNDING_NORM) * leftRight[1]!;
  r0 /= leftRight[0]! + leftRight[1]!; // Reduce blending for pixels in the center of a line.
  r1 /= leftRight[0]! + leftRight[1]!;
  const saturate = (value: number) => Math.min(1, Math.max(0, value));
  const factor0 = 1 - r0 * smaaSampleEdgesOffset(edges, width, height, coords[0]!, coords[1]!, 0, 1)[0]
    - r1 * smaaSampleEdgesOffset(edges, width, height, coords[2]!, coords[3]!, 1, 1)[0];
  const factor1 = 1 - r0 * smaaSampleEdgesOffset(edges, width, height, coords[0]!, coords[1]!, 0, -2)[0]
    - r1 * smaaSampleEdgesOffset(edges, width, height, coords[2]!, coords[3]!, 1, -2)[0];
  return [saturate(factor0) * weights[0]!, saturate(factor1) * weights[1]!];
}

/** SMAADetectVerticalCornerPattern — dampen weights near corners of vertical lines. */
export function smaaDetectVerticalCornerPattern(edges: Uint8Array, width: number, height: number,
  weights: number[], coords: number[], d: number[]): [number, number] {
  const leftRight = [Number(d[1]! >= d[0]!), Number(d[0]! >= d[1]!)];
  let r0 = (1 - CORNER_ROUNDING_NORM) * leftRight[0]!;
  let r1 = (1 - CORNER_ROUNDING_NORM) * leftRight[1]!;
  r0 /= leftRight[0]! + leftRight[1]!;
  r1 /= leftRight[0]! + leftRight[1]!;
  const saturate = (value: number) => Math.min(1, Math.max(0, value));
  const factor0 = 1 - r0 * smaaSampleEdgesOffset(edges, width, height, coords[0]!, coords[1]!, 1, 0)[1]
    - r1 * smaaSampleEdgesOffset(edges, width, height, coords[2]!, coords[3]!, 1, 1)[1];
  const factor1 = 1 - r0 * smaaSampleEdgesOffset(edges, width, height, coords[0]!, coords[1]!, -2, 0)[1]
    - r1 * smaaSampleEdgesOffset(edges, width, height, coords[2]!, coords[3]!, -2, 1)[1];
  return [saturate(factor0) * weights[0]!, saturate(factor1) * weights[1]!];
}
