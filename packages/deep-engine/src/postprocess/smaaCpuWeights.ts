/**
 * SMAA blending weight calculation — CPU mirror of smaaBlendWeightsWgsl.ts, which is a
 * formula-for-formula WGSL port of Three r185 SMAAShader.js SMAAWeightsShader
 * (iryoku/smaa v2.8, SMAA 1x Medium; MIT; license in spatialAa.LICENSE.md).
 * Every function below mirrors its WGSL counterpart line by line (same names, same
 * order of operations); storage semantics match the GPU targets: edges rg8unorm
 * (8-bit quantized), weights float (rgba16float), LUTs 8-bit.
 * Coordinates are uvs in [0,1]; sampler semantics: linear/clamp-to-edge for edges and
 * AreaTex, nearest/clamp-to-edge for SearchTex — mirrors of textureSampleLevel.
 */

/** 模拟 GPU textureSampleLevel(linear, clamp-to-edge):uv → 双线性 RGBA 采样。 */
export function smaaBilinearSample(data: ArrayLike<number>, width: number, height: number,
  channels: number, u: number, v: number, out: number[]): number[] {
  const tx = u * width - 0.5, ty = v * height - 0.5;
  const x0 = Math.floor(tx), y0 = Math.floor(ty);
  const fx = tx - x0, fy = ty - y0;
  const clampX = (x: number) => Math.min(width - 1, Math.max(0, x));
  const clampY = (y: number) => Math.min(height - 1, Math.max(0, y));
  for (let c = 0; c < channels; c++) out[c]! = 0;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const px = (clampY(y0 + j) * width + clampX(x0 + i)) * channels + 0;
    const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
    for (let c = 0; c < channels; c++) out[c]! += data[px + c]! * weight;
  }
  return out;
}

/** edges 中间目标(rg8unorm 存储语义)的双线性采样,镜像 fn smaaSampleEdges。 */
export function smaaSampleEdges(edges: Uint8Array, width: number, height: number, u: number, v: number): [number, number] {
  const sampled = smaaBilinearSample(edges, width, height, 2, u, v, [0, 0]);
  return [sampled[0]! / 255, sampled[1]! / 255];
}

/** SMAASampleLevelZeroOffset 镜像:整数 texel 偏移的线性采样(texels → uv 位移)。 */
export function smaaSampleEdgesOffset(edges: Uint8Array, width: number, height: number,
  u: number, v: number, offsetTexelsX: number, offsetTexelsY: number): [number, number] {
  return smaaSampleEdges(edges, width, height, u + offsetTexelsX / width, v + offsetTexelsY / height);
}

/** GLSL/WGSL round: half away from zero(Math.round 是 half up)。 */
export function smaaRoundHalfAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** AreaTex(rg8 交错 LUT)的双线性采样,镜像 fn smaaSampleArea。 */
export function smaaSampleArea(area: Uint8Array, u: number, v: number): [number, number] {
  const sampled = smaaBilinearSample(area, 160, 560, 2, u, v, [0, 0]);
  return [sampled[0]! / 255, sampled[1]! / 255];
}

/** SearchTex(r8 LUT)的最近采样,镜像 fn smaaSampleSearch(textureSampleLevel + point)。 */
export function smaaSampleSearch(search: Uint8Array, u: number, v: number): number {
  const x = Math.min(65, Math.max(0, Math.floor(u * 66))), y = Math.min(32, Math.max(0, Math.floor(v * 33)));
  return search[y * 66 + x]! / 255;
}

/** SMAASearchLength:边缘配置 → 搜索端点步长修正(texel 数)。 */
export function smaaSearchLength(search: Uint8Array, e: number[], bias: number, scale: number): number {
  // Not required if searchTex accesses are set to point:
  // float2 SEARCH_TEX_PIXEL_SIZE = 1.0 / float2(66.0, 33.0);
  // e = float2(bias, 0.0) + 0.5 * SEARCH_TEX_PIXEL_SIZE + e * float2(scale, 1.0) * float2(64.0, 32.0) * SEARCH_TEX_PIXEL_SIZE;
  const coord = [bias + e[0]! * scale, e[1]!];
  return 255 * smaaSampleSearch(search, coord[0]!, coord[1]!);
}

/** SMAASearchXLeft — search left for the end of the horizontal edge line (@PSEUDO_GATHER4). */
export function smaaSearchXLeft(edges: Uint8Array, search: Uint8Array, width: number, height: number,
  texcoordStart: [number, number], end: number): number {
  const resolutionX = 1 / width;
  let e: [number, number] = [0, 1];
  const texcoord = [...texcoordStart] as [number, number];
  for (let i = 0; i < 16; i++) { // SMAA_MAX_SEARCH_STEPS = 16 (SMAA_PRESET_HIGH; WebGL port note: Changed while to for)
    e = smaaSampleEdges(edges, width, height, texcoord[0]!, texcoord[1]!);
    texcoord[0] -= 2 * resolutionX;
    if (!(texcoord[0]! > end && e[1]! > 0.8281 && e[0] === 0)) break;
  }
  texcoord[0] += 0.25 * resolutionX; // We correct the previous (-0.25, -0.125) offset we applied
  texcoord[0] += resolutionX; // The searches are biased by 1, so adjust the coords accordingly
  texcoord[0] += 2 * resolutionX; // Undo last step
  texcoord[0] -= resolutionX * smaaSearchLength(search, e, 0.0, 0.5);
  return texcoord[0]!;
}

/** SMAASearchXRight — mirror of SMAASearchXLeft towards +x. */
export function smaaSearchXRight(edges: Uint8Array, search: Uint8Array, width: number, height: number,
  texcoordStart: [number, number], end: number): number {
  const resolutionX = 1 / width;
  let e: [number, number] = [0, 1];
  const texcoord = [...texcoordStart] as [number, number];
  for (let i = 0; i < 16; i++) {
    e = smaaSampleEdges(edges, width, height, texcoord[0]!, texcoord[1]!);
    texcoord[0] += 2 * resolutionX;
    if (!(texcoord[0]! < end && e[1]! > 0.8281 && e[0] === 0)) break;
  }
  texcoord[0] -= 0.25 * resolutionX;
  texcoord[0] -= resolutionX;
  texcoord[0] -= 2 * resolutionX;
  texcoord[0] += resolutionX * smaaSearchLength(search, e, 0.5, 0.5);
  return texcoord[0]!;
}

/** SMAASearchYUp — search up for the end of the vertical edge line. */
export function smaaSearchYUp(edges: Uint8Array, search: Uint8Array, width: number, height: number,
  texcoordStart: [number, number], end: number): number {
  const resolutionY = 1 / height;
  let e: [number, number] = [1, 0];
  const texcoord = [...texcoordStart] as [number, number];
  for (let i = 0; i < 16; i++) {
    e = smaaSampleEdges(edges, width, height, texcoord[0]!, texcoord[1]!);
    texcoord[1] += 2 * resolutionY; // WebGL port note: Changed sign
    if (!(texcoord[1]! > end && e[0]! > 0.8281 && e[1] === 0)) break;
  }
  texcoord[1] -= 0.25 * resolutionY; // WebGL port note: Changed sign
  texcoord[1] -= resolutionY; // WebGL port note: Changed sign
  texcoord[1] -= 2 * resolutionY; // WebGL port note: Changed sign
  texcoord[1] += resolutionY * smaaSearchLength(search, [e[1]!, e[0]!], 0.0, 0.5); // e.gr
  return texcoord[1]!;
}

/** SMAASearchYDown — mirror of SMAASearchYUp towards -y. */
export function smaaSearchYDown(edges: Uint8Array, search: Uint8Array, width: number, height: number,
  texcoordStart: [number, number], end: number): number {
  const resolutionY = 1 / height;
  let e: [number, number] = [1, 0];
  const texcoord = [...texcoordStart] as [number, number];
  for (let i = 0; i < 16; i++) {
    e = smaaSampleEdges(edges, width, height, texcoord[0]!, texcoord[1]!);
    texcoord[1] -= 2 * resolutionY; // WebGL port note: Changed sign
    if (!(texcoord[1]! < end && e[0]! > 0.8281 && e[1] === 0)) break;
  }
  texcoord[1] += 0.25 * resolutionY; // WebGL port note: Changed sign
  texcoord[1] += resolutionY; // WebGL port note: Changed sign
  texcoord[1] += 2 * resolutionY; // WebGL port note: Changed sign
  texcoord[1] -= resolutionY * smaaSearchLength(search, [e[1]!, e[0]!], 0.5, 0.5); // e.gr
  return texcoord[1]!;
}

/** SMAAArea — crossing-edge blend areas from the AreaTex double channel (sqrt-compressed dist). */
export function smaaArea(area: Uint8Array, dist: number[], e1: number, e2: number, offset: number): [number, number] {
  // Rounding prevents precision errors of bilinear filtering:
  const texcoordX = 16 * Math.round(4 * e1) + dist[0]!; // SMAA_AREATEX_MAX_DISTANCE
  let texcoordY = 16 * Math.round(4 * e2) + dist[1]!;
  // We do a scale and bias for mapping to texel space (SMAA_AREATEX_PIXEL_SIZE):
  const u = (1 / 160) * texcoordX + 0.5 * (1 / 160);
  // Move to proper place, according to the subpixel offset (SMAA_AREATEX_SUBTEX_SIZE):
  const v = (1 / 560) * texcoordY + 0.5 * (1 / 560) + (1 / 7) * offset;
  return smaaSampleArea(area, u, v);
}
