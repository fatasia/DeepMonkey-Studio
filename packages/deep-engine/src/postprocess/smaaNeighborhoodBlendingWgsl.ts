/*!
 * SMAA neighborhood blending pass — WebGL port of Subpixel Morphological Antialiasing
 * (SMAA) v2.8, preset SMAA 1x Medium, ported formula-for-formula to WGSL from
 * Three.js r185 examples/jsm/shaders/SMAAShader.js (SMAABlendShader).
 * Copyright © 2010-2026 three.js authors / Jorge Jimenez (iryoku/smaa v2.8), MIT license;
 * full notice in spatialAa.LICENSE.md.
 *
 * Host must provide (injected before this snippet):
 *   fn smaaSampleColor(uv: vec2f) -> vec4f    // display-encoded source, linear-filtered
 *   fn smaaSampleWeights(uv: vec2f) -> vec4f  // weights target (rgba), linear-filtered
 *   fn smaaResolution() -> vec2f              // 1.0 / (width, height)
 */
export const SMAA_NEIGHBORHOOD_BLENDING_WGSL = /* wgsl */ `
/**
 * SMAANeighborhoodBlendingPS — blend the current pixel towards the neighbor indicated by
 * the strongest blending weight (SMAA v2.8 §3.4).
 *
 * Domain note (WebGL port note: Added gamma correction — upstream pow(2.2)/pow(1/2.2)
 * wraps the mix because upstream runs on linear-sRGB and wants perceptual blending).
 * This chain already operates on display-encoded (perceptually encoded) RGBA, so the
 * mix is performed directly in that domain; adding the pow pair here would double-encode.
 */
fn smaaNeighborhoodBlendingPS(texcoord: vec2f) -> vec4f {
  let resolution = smaaResolution();

  // Fetch the blending weights for current pixel:
  var a = vec4f(0.0);
  a.xz = smaaSampleWeights(texcoord).xz;
  a.y = smaaSampleWeights(texcoord + resolution * vec2f(0.0, -1.0)).g; // offset[1].zw (SMAANeighborhoodBlendingVS)
  a.w = smaaSampleWeights(texcoord + resolution * vec2f(1.0, 0.0)).a; // offset[1].xy

  // Is there any blending weight with a value greater than 0.0?
  if (dot(a, vec4f(1.0, 1.0, 1.0, 1.0)) < 1e-5) {
    return smaaSampleColor(texcoord);
  } else {
    // Up to 4 lines can be crossing a pixel (one through each edge). We favor blending
    // by choosing the line with the maximum weight for each direction:
    var offset = vec2f(0.0);
    offset.x = select(-a.b, a.a, a.a > a.b); // left vs. right
    offset.y = select(a.r, -a.g, a.g > a.r); // top vs. bottom // WebGL port note: Changed signs

    // Then we go in the direction that has the maximum weight:
    if (abs(offset.x) > abs(offset.y)) { // horizontal vs. vertical
      offset.y = 0.0;
    } else {
      offset.x = 0.0;
    }

    // Fetch the opposite color and lerp by hand:
    let C = smaaSampleColor(texcoord);
    let Cop = smaaSampleColor(texcoord + sign(offset) * resolution);
    let s = select(abs(offset.y), abs(offset.x), abs(offset.x) > abs(offset.y));

    return mix(C, Cop, vec4f(s));
  }
}
`;
