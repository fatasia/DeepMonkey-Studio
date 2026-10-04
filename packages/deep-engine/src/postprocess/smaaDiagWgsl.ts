/*!
 * SMAA diagonal search + corner detection — formula-for-formula WGSL port of
 * iryoku/smaa v2.8 SMAA.hlsl (SMAA_PRESET_HIGH capability set: diagonal edge
 * detection SMAA_MAX_SEARCH_STEPS_DIAG=8 and SMAA_CORNER_ROUNDING=25), MIT license;
 * full notice in spatialAa.LICENSE.md. The three.js SMAAShader (SMAA 1x Medium preset)
 * this chain builds on omits both segments (official SMAA_DISABLE_DIAG_DETECTION /
 * SMAA_DISABLE_CORNER_DETECTION); they live in the same AreaTex (x in [0.5, 1.0] uv).
 *
 * Host must provide (injected before this snippet):
 *   fn smaaResolution() -> vec2f           // 1.0 / (width, height)
 *   fn smaaSampleEdges(uv: vec2f) -> vec4f // edges target (rg), linear-filtered
 *   fn smaaSampleEdgesOffset(uv: vec2f, texels: vec2f) -> vec4f // SMAASampleLevelZeroOffset
 *   fn smaaSampleArea(uv: vec2f) -> vec2f  // AreaTex rg channel, linear-filtered
 */
export const SMAA_DIAG_WGSL = /* wgsl */ `
const smaaMaxSearchStepsDiag = 8.0; // SMAA_MAX_SEARCH_STEPS_DIAG (SMAA_PRESET_HIGH)
const smaaCornerRoundingNorm = 25.0 / 100.0; // SMAA_CORNER_ROUNDING_NORM (SMAA_PRESET_HIGH)
const smaaAreaTexMaxDistanceDiag = 20.0; // SMAA_AREATEX_MAX_DISTANCE_DIAG
// smaaAreaTexPixelSize / smaaAreaTexSubtexSize live in the injected weights header.

/**
 * SMAASearchDiag1 — search along the (dir.x, dir.y) diagonal for the end of the line.
 * (官方非优化变体) coord.z tracks the step, coord.w the summed edge (0.5*e.r + 0.5*e.g).
 */
fn smaaSearchDiag1(texcoord: vec2f, dir: vec2f, resolution: vec2f, outEdge: ptr<function, vec2f>) -> vec2f {
  var coord = vec4f(texcoord, -1.0, 1.0);
  let t = vec3f(resolution, 1.0);
  while (coord.z < smaaMaxSearchStepsDiag - 1.0 && coord.w > 0.9) {
    coord.xyz += t * vec3f(dir, 1.0);
    let e = smaaSampleEdges(coord.xy).rg;
    *outEdge = e;
    coord.w = dot(e, vec2f(0.5, 0.5));
  }
  return coord.zw;
}

/** SMAASearchDiag2 — mirror diagonal search (the @SearchDiag2Optimization decode is
 * equivalent to fetching both edges separately, per the official non-optimized variant). */
fn smaaSearchDiag2(texcoord: vec2f, dir: vec2f, resolution: vec2f, outEdge: ptr<function, vec2f>) -> vec2f {
  var coord = vec4f(texcoord, -1.0, 1.0);
  coord.x += 0.25 * resolution.x; // See @SearchDiag2Optimization
  let t = vec3f(resolution, 1.0);
  while (coord.z < smaaMaxSearchStepsDiag - 1.0 && coord.w > 0.9) {
    coord.xyz += t * vec3f(dir, 1.0);
    var e = smaaSampleEdges(coord.xy).rg;
    e = vec2f(smaaSampleEdgesOffset(coord.xy, vec2f(1.0, 0.0)).r, e.g); // e.r one texel right, e.g in place
    *outEdge = e;
    coord.w = dot(e, vec2f(0.5, 0.5));
  }
  return coord.zw;
}

/**
 * SMAAAreaDiag — diagonal areas live on the second (x >= 0.5) half of the AreaTex;
 * distances enter in diagonal steps (no quadratic compression, unlike SMAAArea).
 */
fn smaaAreaDiag(dist: vec2f, e: vec2f, offset: f32) -> vec2f {
  var texcoord = smaaAreaTexMaxDistanceDiag * e + dist;
  // We do a scale and bias for mapping to texel space:
  texcoord = smaaAreaTexPixelSize * texcoord + (0.5 * smaaAreaTexPixelSize);
  // Diagonal areas are on the second half of the texture:
  texcoord.x += 0.5;
  // Move to proper place, according to the subpixel offset:
  texcoord.y += smaaAreaTexSubtexSize * offset;
  return smaaSampleArea(texcoord);
}

/**
 * SMAACalculateDiagWeights — full diagonal pattern weights (both diagonals).
 * A found diagonal gets priority over the orthogonal processing (see the main PS).
 */
fn smaaCalculateDiagWeights(texcoord: vec2f, e: vec2f, resolution: vec2f) -> vec2f {
  var weights = vec2f(0.0, 0.0);

  // Search for the line ends:
  var d = vec4f(0.0);
  var end = vec2f(0.0);
  var edge = vec2f(0.0);
  if (e.r > 0.0) {
    d.xz = smaaSearchDiag1(texcoord, vec2f(-1.0, 1.0), resolution, &edge);
    d.x += select(0.0, 1.0, edge.y > 0.9);
  } else {
    d.xz = vec2f(0.0, 0.0);
  }
  d.yw = smaaSearchDiag1(texcoord, vec2f(1.0, -1.0), resolution, &edge);

  if (d.x + d.y > 2.0) { // d.x + d.y + 1 > 3
    // Fetch the crossing edges (official non-optimized variant of @SearchDiagDecoding):
    let coords = vec4f(
      texcoord.x + (-d.x + 0.25) * resolution.x, texcoord.y + d.x * resolution.y,
      texcoord.x + d.y * resolution.x, texcoord.y + (-d.y - 0.25) * resolution.y);
    var c = vec4f(0.0);
    c.x = smaaSampleEdgesOffset(coords.xy, vec2f(-1.0, 0.0)).g;
    c.y = smaaSampleEdges(coords.xy).r;
    c.z = smaaSampleEdgesOffset(coords.zw, vec2f(1.0, 0.0)).g;
    c.w = smaaSampleEdgesOffset(coords.zw, vec2f(1.0, -1.0)).r;

    // Merge crossing edges at each side into a single value:
    var cc = vec2f(0.0);
    cc.x = 2.0 * c.x + c.y;
    cc.y = 2.0 * c.z + c.w;

    // Remove the crossing edge if we didn't find the end of the line
    // (SMAAMovc(step(0.9, d.zw), cc, 0.0): the search must have terminated on the edge sum):
    if (d.z >= 0.9) { cc.x = 0.0; }
    if (d.w >= 0.9) { cc.y = 0.0; }

    // Fetch the areas for this line:
    weights += smaaAreaDiag(vec2f(d.x, d.y), cc, 0.0); // subsampleIndices.z = 0 (SMAA 1x)
  }

  // Search for the line ends:
  d.xz = smaaSearchDiag2(texcoord, vec2f(-1.0, -1.0), resolution, &edge);
  if (smaaSampleEdgesOffset(texcoord, vec2f(1.0, 0.0)).r > 0.0) {
    d.yw = smaaSearchDiag2(texcoord, vec2f(1.0, 1.0), resolution, &edge);
    d.y += select(0.0, 1.0, edge.y > 0.9);
  } else {
    d.yw = vec2f(0.0, 0.0);
  }

  if (d.x + d.y > 2.0) { // d.x + d.y + 1 > 3
    // Fetch the crossing edges:
    let coords = vec4f(
      texcoord.x + -d.x * resolution.x, texcoord.y + -d.x * resolution.y,
      texcoord.x + d.y * resolution.x, texcoord.y + d.y * resolution.y);
    var c = vec4f(0.0);
    c.x = smaaSampleEdgesOffset(coords.xy, vec2f(-1.0, 0.0)).g;
    c.y = smaaSampleEdgesOffset(coords.xy, vec2f(0.0, -1.0)).r;
    c.z = smaaSampleEdgesOffset(coords.zw, vec2f(1.0, 0.0)).g;
    c.w = smaaSampleEdgesOffset(coords.zw, vec2f(1.0, 0.0)).r;

    // Merge crossing edges at each side into a single value:
    var cc = vec2f(0.0);
    cc.x = 2.0 * c.x + c.y;
    cc.y = 2.0 * c.z + c.w;

    // Remove the crossing edge if we didn't find the end of the line
    // (SMAAMovc(step(0.9, d.zw), cc, 0.0): the search must have terminated on the edge sum):
    if (d.z >= 0.9) { cc.x = 0.0; }
    if (d.w >= 0.9) { cc.y = 0.0; }

    // Fetch the areas for this line:
    weights += smaaAreaDiag(vec2f(d.x, d.y), cc, 0.0).gr; // subsampleIndices.w = 0 (SMAA 1x)
  }

  return weights;
}

/** SMAADetectHorizontalCornerPattern — dampen weights near corners of horizontal lines. */
fn smaaDetectHorizontalCornerPattern(weights: vec2f, coords: vec4f, d: vec2f, resolution: vec2f) -> vec2f {
  var weightsLocal = weights;
  let leftRight = step(vec2f(d.x, d.y), vec2f(d.y, d.x));
  var rounding = (1.0 - smaaCornerRoundingNorm) * leftRight;
  rounding /= leftRight.x + leftRight.y; // Reduce blending for pixels in the center of a line.

  var factor = vec2f(1.0, 1.0);
  factor.x -= rounding.x * smaaSampleEdgesOffset(coords.xy, vec2f(0.0, 1.0)).r;
  factor.x -= rounding.y * smaaSampleEdgesOffset(coords.zw, vec2f(1.0, 1.0)).r;
  factor.y -= rounding.x * smaaSampleEdgesOffset(coords.xy, vec2f(0.0, -2.0)).r;
  factor.y -= rounding.y * smaaSampleEdgesOffset(coords.zw, vec2f(1.0, -2.0)).r;

  weightsLocal *= clamp(factor, vec2f(0.0), vec2f(1.0));
  return weightsLocal;
}

/** SMAADetectVerticalCornerPattern — dampen weights near corners of vertical lines. */
fn smaaDetectVerticalCornerPattern(weights: vec2f, coords: vec4f, d: vec2f, resolution: vec2f) -> vec2f {
  var weightsLocal = weights;
  let leftRight = step(vec2f(d.x, d.y), vec2f(d.y, d.x));
  var rounding = (1.0 - smaaCornerRoundingNorm) * leftRight;
  rounding /= leftRight.x + leftRight.y; // Reduce blending for pixels in the center of a line.

  var factor = vec2f(1.0, 1.0);
  factor.x -= rounding.x * smaaSampleEdgesOffset(coords.xy, vec2f(1.0, 0.0)).g;
  factor.x -= rounding.y * smaaSampleEdgesOffset(coords.zw, vec2f(1.0, 1.0)).g;
  factor.y -= rounding.x * smaaSampleEdgesOffset(coords.xy, vec2f(-2.0, 0.0)).g;
  factor.y -= rounding.y * smaaSampleEdgesOffset(coords.zw, vec2f(-2.0, 1.0)).g;

  weightsLocal *= clamp(factor, vec2f(0.0), vec2f(1.0));
  return weightsLocal;
}
`;
