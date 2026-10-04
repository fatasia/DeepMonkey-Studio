/*!
 * SMAA edge detection pass — WebGL port of Subpixel Morphological Antialiasing (SMAA) v2.8,
 * preset SMAA 1x Medium (color edge detection), ported formula-for-formula to WGSL from
 * Three.js r185 examples/jsm/shaders/SMAAShader.js (SMAAEdgesShader).
 * Copyright © 2010-2026 three.js authors / Jorge Jimenez (iryoku/smaa v2.8), MIT license;
 * full notice in spatialAa.LICENSE.md.
 *
 * Domain note: the upstream SMAAPass runs on linear-sRGB; this chain runs on the
 * display-encoded premultiplied RGBA target (same contract as the FXAA variant), so no
 * transfer function is applied here. Upstream function names are kept as comments.
 *
 * Host must provide (injected before this snippet):
 *   fn smaaSampleColor(uv: vec2f) -> vec4f   // display-encoded source, linear-filtered
 *   fn smaaResolution() -> vec2f             // 1.0 / (width, height) of the source
 */
export const SMAA_EDGE_DETECTION_WGSL = /* wgsl */ `
// SMAA_THRESHOLD = 0.1 (SMAAEdgesShader.defines)
const smaaThreshold = 0.1;

/**
 * SMAAColorEdgeDetectionPS — computes luma/color deltas against left and top neighbors,
 * thresholds them, then applies local contrast adaptation (SMAA v2.8 §3.2).
 */
fn smaaColorEdgeDetectionPS(texcoord: vec2f) -> vec2f {
  let resolution = smaaResolution();
  let threshold = vec2f(smaaThreshold, smaaThreshold);

  // Calculate color deltas:
  var delta = vec4f(0.0);
  let C = smaaSampleColor(texcoord).rgb;

  let Cleft = smaaSampleColor(texcoord + resolution * vec2f(-1.0, 0.0)).rgb; // offset[0].xy (SMAAEdgeDetectionVS)
  var t = abs(C - Cleft);
  delta.x = max(max(t.r, t.g), t.b);

  let Ctop = smaaSampleColor(texcoord + resolution * vec2f(0.0, 1.0)).rgb; // offset[0].zw
  t = abs(C - Ctop);
  delta.y = max(max(t.r, t.g), t.b);

  // We do the usual threshold (WGSL has no scalar-vector step overload, hence vec2f(threshold)):
  var edges = step(vec2f(threshold), delta.xy);

  // Then discard if there is no edge (write zero instead of discard; the edges target is cleared to zero):
  if (dot(edges, vec2f(1.0, 1.0)) == 0.0) { return vec2f(0.0); }

  // Calculate right and bottom deltas:
  let Cright = smaaSampleColor(texcoord + resolution * vec2f(1.0, 0.0)).rgb; // offset[1].xy
  t = abs(C - Cright);
  delta.z = max(max(t.r, t.g), t.b);

  let Cbottom = smaaSampleColor(texcoord + resolution * vec2f(0.0, -1.0)).rgb; // offset[1].zw
  t = abs(C - Cbottom);
  delta.w = max(max(t.r, t.g), t.b);

  // Calculate the maximum delta in the direct neighborhood:
  var maxDelta = max(max(max(delta.x, delta.y), delta.z), delta.w);

  // Calculate left-left and top-top deltas:
  let Cleftleft = smaaSampleColor(texcoord + resolution * vec2f(-2.0, 0.0)).rgb; // offset[2].xy
  t = abs(C - Cleftleft);
  delta.z = max(max(t.r, t.g), t.b);

  let Ctoptop = smaaSampleColor(texcoord + resolution * vec2f(0.0, 2.0)).rgb; // offset[2].zw
  t = abs(C - Ctoptop);
  delta.w = max(max(t.r, t.g), t.b);

  // Calculate the final maximum delta:
  maxDelta = max(max(maxDelta, delta.z), delta.w);

  // Local contrast adaptation in action:
  edges *= step(vec2f(0.5 * maxDelta), delta.xy);

  return edges;
}
`;
