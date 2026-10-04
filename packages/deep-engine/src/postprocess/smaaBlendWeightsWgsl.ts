/*!
 * SMAA blending weight calculation pass — ported formula-for-formula from
 * iryoku/smaa v2.8 SMAA.hlsl / Three.js r185 examples/jsm/shaders/SMAAShader.js
 * (SMAAWeightsShader, the WebGL SMAA 1x port), MIT license; full notice in
 * spatialAa.LICENSE.md. Capability set = official SMAA_PRESET_HIGH: orthogonal
 * search SMAA_MAX_SEARCH_STEPS=16, diagonal detection (smaaDiagWgsl, steps 8)
 * with diagonal priority, corner rounding 25. The three.js port ships the
 * Medium preset (diagonals/corners disabled per official SMAA_DISABLE_* defines);
 * the diagonal segment is required by the AA-M2 task brief ("完整搜索段").
 *
 * Host must provide (injected before this snippet):
 *   fn smaaResolution() -> vec2f          // 1.0 / (width, height)
 *   fn smaaSampleEdges(uv: vec2f) -> vec4f // edges target (rg), linear-filtered
 *   fn smaaSampleEdgesOffset(uv: vec2f, texels: vec2f) -> vec4f // SMAASampleLevelZeroOffset
 *   fn smaaSampleArea(uv: vec2f) -> vec2f  // AreaTex rg channel, linear-filtered
 *   fn smaaSampleSearch(uv: vec2f) -> f32  // SearchTex r channel, point-filtered
 */
export const SMAA_BLEND_WEIGHTS_WGSL = /* wgsl */ `
// SMAAWeightsShader.defines:
const smaaMaxSearchSteps = 16.0; // SMAA_MAX_SEARCH_STEPS (SMAA_PRESET_HIGH; three ships 8/Medium)
const smaaAreaTexMaxDistance = 16.0; // SMAA_AREATEX_MAX_DISTANCE
// smaaAreaTexPixelSize / smaaAreaTexSubtexSize live in the injected weights header.

// SMAASearchLength: translate the edge configuration into a search-length correction (texels).
fn smaaSearchLength(e: vec2f, bias: f32, scale: f32) -> f32 {
  // Not required if searchTex accesses are set to point:
  // float2 SEARCH_TEX_PIXEL_SIZE = 1.0 / float2(66.0, 33.0);
  // e = float2(bias, 0.0) + 0.5 * SEARCH_TEX_PIXEL_SIZE + e * float2(scale, 1.0) * float2(64.0, 32.0) * SEARCH_TEX_PIXEL_SIZE;
  var coord = e;
  coord.x = bias + coord.x * scale;
  return 255.0 * smaaSampleSearch(coord);
}

/**
 * SMAASearchXLeft — search left for the end of the horizontal edge line.
 * @PSEUDO_GATHER4: texcoord is pre-offset by (-0.25, -0.125) (see offset[0]) to sample
 * between edges, fetching four edges in a row; differing offsets per direction
 * disambiguate which of the four fetched edges are active.
 */
fn smaaSearchXLeft(texcoordStart: vec2f, end: f32, resolution: vec2f) -> f32 {
  var e = vec2f(0.0, 1.0);
  var texcoord = texcoordStart;
  for (var i = 0.0; i < smaaMaxSearchSteps; i += 1.0) { // WebGL port note: Changed while to for
    e = smaaSampleEdges(texcoord).rg;
    texcoord -= vec2f(2.0, 0.0) * resolution;
    if (!(texcoord.x > end && e.g > 0.8281 && e.r == 0.0)) { break; }
  }
  // We correct the previous (-0.25, -0.125) offset we applied:
  texcoord.x += 0.25 * resolution.x;
  // The searches are biased by 1, so adjust the coords accordingly:
  texcoord.x += resolution.x;
  // Disambiguate the length added by the last step:
  texcoord.x += 2.0 * resolution.x; // Undo last step
  texcoord.x -= resolution.x * smaaSearchLength(e, 0.0, 0.5);
  return texcoord.x;
}

/** SMAASearchXRight — mirror of SMAASearchXLeft towards +x. */
fn smaaSearchXRight(texcoordStart: vec2f, end: f32, resolution: vec2f) -> f32 {
  var e = vec2f(0.0, 1.0);
  var texcoord = texcoordStart;
  for (var i = 0.0; i < smaaMaxSearchSteps; i += 1.0) {
    e = smaaSampleEdges(texcoord).rg;
    texcoord += vec2f(2.0, 0.0) * resolution;
    if (!(texcoord.x < end && e.g > 0.8281 && e.r == 0.0)) { break; }
  }
  texcoord.x -= 0.25 * resolution.x;
  texcoord.x -= resolution.x;
  texcoord.x -= 2.0 * resolution.x;
  texcoord.x += resolution.x * smaaSearchLength(e, 0.5, 0.5);
  return texcoord.x;
}

/** SMAASearchYUp — search up for the end of the vertical edge line. */
fn smaaSearchYUp(texcoordStart: vec2f, end: f32, resolution: vec2f) -> f32 {
  var e = vec2f(1.0, 0.0);
  var texcoord = texcoordStart;
  for (var i = 0.0; i < smaaMaxSearchSteps; i += 1.0) {
    e = smaaSampleEdges(texcoord).rg;
    texcoord += vec2f(0.0, 2.0) * resolution; // WebGL port note: Changed sign
    if (!(texcoord.y > end && e.r > 0.8281 && e.g == 0.0)) { break; }
  }
  texcoord.y -= 0.25 * resolution.y; // WebGL port note: Changed sign
  texcoord.y -= resolution.y; // WebGL port note: Changed sign
  texcoord.y -= 2.0 * resolution.y; // WebGL port note: Changed sign
  texcoord.y += resolution.y * smaaSearchLength(e.gr, 0.0, 0.5); // WebGL port note: Changed sign
  return texcoord.y;
}

/** SMAASearchYDown — mirror of SMAASearchYUp towards -y. */
fn smaaSearchYDown(texcoordStart: vec2f, end: f32, resolution: vec2f) -> f32 {
  var e = vec2f(1.0, 0.0);
  var texcoord = texcoordStart;
  for (var i = 0.0; i < smaaMaxSearchSteps; i += 1.0) {
    e = smaaSampleEdges(texcoord).rg;
    texcoord -= vec2f(0.0, 2.0) * resolution; // WebGL port note: Changed sign
    if (!(texcoord.y < end && e.r > 0.8281 && e.g == 0.0)) { break; }
  }
  texcoord.y += 0.25 * resolution.y; // WebGL port note: Changed sign
  texcoord.y += resolution.y; // WebGL port note: Changed sign
  texcoord.y += 2.0 * resolution.y; // WebGL port note: Changed sign
  texcoord.y -= resolution.y * smaaSearchLength(e.gr, 0.5, 0.5); // WebGL port note: Changed sign
  return texcoord.y;
}

/**
 * SMAAArea — fetch the two crossing-edge blend areas from the AreaTex double channel;
 * distances enter square-root-compressed, offset selects the subtexel row (SMAA 1x: 0).
 */
fn smaaArea(dist: vec2f, e1: f32, e2: f32, offset: f32) -> vec2f {
  // Rounding prevents precision errors of bilinear filtering:
  var texcoord = smaaAreaTexMaxDistance * round(4.0 * vec2f(e1, e2)) + dist;
  // We do a scale and bias for mapping to texel space:
  texcoord = smaaAreaTexPixelSize * texcoord + (0.5 * smaaAreaTexPixelSize);
  // Move to proper place, according to the subpixel offset:
  texcoord.y += smaaAreaTexSubtexSize * offset;
  return smaaSampleArea(texcoord);
}

/**
 * SMAABlendingWeightCalculationPS — per pixel: diagonal patterns get priority; a found
 * diagonal skips orthogonal processing entirely. Otherwise horizontal edge line (north)
 * yields weights.rg, vertical edge line (west) yields weights.ba. subsampleIndices =
 * ivec4(0) for SMAA 1x (no MSAA re-projection).
 */
fn smaaBlendingWeightCalculationPS(texcoord: vec2f) -> vec4f {
  let resolution = smaaResolution();
  let pixcoord = texcoord / resolution;

  // SMAABlendingWeightCalculationVS (computed per-fragment):
  let offset0 = texcoord.xyxy + resolution.xyxy * vec4f(-0.25, 0.125, 1.25, 0.125);
  let offset1 = texcoord.xyxy + resolution.xyxy * vec4f(-0.125, 0.25, -0.125, -1.25);
  // And these for the searches, they indicate the ends of the loops:
  let offset2 = vec4f(offset0.xz, offset1.yw)
    + vec4f(-2.0, 2.0, -2.0, 2.0) * vec4f(resolution.x, resolution.x, resolution.y, resolution.y) * smaaMaxSearchSteps;

  var weights = vec4f(0.0);
  var e = smaaSampleEdges(texcoord).rg;

  if (e.g > 0.0) { // Edge at north
    // Diagonals have both north and west edges, so searching for them in one of the
    // boundaries is enough. We give priority to diagonals: if we find one, we skip
    // horizontal/vertical processing.
    let diag = smaaCalculateDiagWeights(texcoord, e, resolution);
    weights.rg = diag;
    if (diag.r + diag.g == 0.0) { // weights.r == -weights.g (no diagonal found)
      // Find the distance to the left:
      var coords = vec2f(0.0, 0.0);
      coords.x = smaaSearchXLeft(offset0.xy, offset2.x, resolution);
      coords.y = offset1.y; // offset[1].y = texcoord.y - 0.25 * resolution.y (@CROSSING_OFFSET)
      var d = vec2f(coords.x, 0.0);
      let leftX = coords.x;

      // Now fetch the left crossing edges, two at a time using bilinear filtering.
      // Sampling at -0.25 (see @CROSSING_OFFSET) enables to discern what value each edge has:
      let e1 = smaaSampleEdges(coords).r;

      // Find the distance to the right:
      coords.x = smaaSearchXRight(offset0.zw, offset2.y, resolution);
      let rightX = coords.x;
      d.y = coords.x;

      // We want the distances to be in pixel units (official variant: rounded to whole
      // pixels and made absolute, so the AreaTex quadratic compression is well-formed):
      d = abs(round(d / resolution.x - pixcoord.x));

      // SMAAArea below needs a sqrt, as the areas texture is compressed quadratically:
      let sqrtD = sqrt(d);

      // Fetch the right crossing edges:
      coords.y -= 1.0 * resolution.y; // WebGL port note: Added
      let e2 = smaaSampleEdges(coords + vec2f(resolution.x, 0.0)).r; // SMAASampleLevelZeroOffset(edgesTex, coords, ivec2(1, 0)).r

      // Ok, we know how this pattern looks like, now it is time for getting the actual area:
      weights.rg = smaaArea(sqrtD, e1, e2, 0.0); // float(subsampleIndices.y)

      // Fix corners: coords.xyzy = (left.x, texcoord.y, right.x, texcoord.y)
      weights.rg = smaaDetectHorizontalCornerPattern(weights.rg,
        vec4f(leftX, texcoord.y, rightX, texcoord.y), d, resolution);
    } else {
      e.r = 0.0; // Skip vertical processing (diagonal found).
    }
  }

  if (e.r > 0.0) { // Edge at west
    // Find the distance to the top:
    var coords = vec2f(0.0, 0.0);
    coords.y = smaaSearchYUp(offset1.xy, offset2.z, resolution);
    coords.x = offset0.x; // offset[1].x = texcoord.x - 0.25 * resolution.x;
    var d = vec2f(coords.y, 0.0);
    let topY = coords.y;

    // Fetch the top crossing edges:
    let e1 = smaaSampleEdges(coords).g;

    // Find the distance to the bottom:
    coords.y = smaaSearchYDown(offset1.zw, offset2.w, resolution);
    let bottomY = coords.y;
    d.y = coords.y;

    // We want the distances to be in pixel units:
    d = abs(round(d / resolution.y - pixcoord.y));

    // SMAAArea below needs a sqrt, as the areas texture is compressed quadratically:
    let sqrtD = sqrt(d);

    // Fetch the bottom crossing edges:
    coords.y -= 1.0 * resolution.y; // WebGL port note: Added
    let e2 = smaaSampleEdges(coords + vec2f(0.0, resolution.y)).g; // SMAASampleLevelZeroOffset(edgesTex, coords, ivec2(0, 1)).g

    // Get the area for this direction:
    weights.ba = smaaArea(sqrtD, e1, e2, 0.0); // float(subsampleIndices.x)

    // Fix corners: coords.xyxz = (texcoord.x, top.y, texcoord.x, bottom.y)
    weights.ba = smaaDetectVerticalCornerPattern(weights.ba,
      vec4f(texcoord.x, topY, texcoord.x, bottomY), d, resolution);
  }

  return weights;
}
`;
