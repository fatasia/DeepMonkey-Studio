/*!
 * Spatial AA adapted from Three.js r185 FXAAShader.js.
 * Copyright © 2010-2026 three.js authors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
/** Three r185 FXAA adaptation; MIT notice in spatialAa.LICENSE.md.
 * Host supplies deepSpatialAaSample(uv) and deepSpatialAaTexel().
 * Input/output: display-encoded premultiplied RGBA; no tone mapping or transfer function here.
 */
export const SPATIAL_AA_WGSL = /* wgsl */ `
fn deepSpatialAaLuma(uv: vec2f) -> f32 { return dot(deepSpatialAaSample(uv).rgb, vec3f(0.3, 0.59, 0.11)); }
fn deepSpatialAaSearch(uv: vec2f, step: vec2f, edgeLuma: f32, threshold: f32) -> vec2f {
  let steps = array<f32, 6>(1.0, 1.5, 2.0, 2.0, 2.0, 4.0);
  var distance = 0.0; var delta = 0.0; var found = false;
  for (var i = 0u; i < 6u; i++) {
    distance += steps[i]; delta = deepSpatialAaLuma(uv + step * distance) - edgeLuma;
    if (abs(delta) >= threshold) { found = true; break; }
  }
  if (!found) { distance += 8.0; }
  return vec2f(distance, delta);
}
fn deepSpatialAa(uv: vec2f) -> vec4f {
  let t = deepSpatialAaTexel();
  let m = deepSpatialAaLuma(uv); let n = deepSpatialAaLuma(uv + vec2f(0.0, t.y));
  let e = deepSpatialAaLuma(uv + vec2f(t.x, 0.0)); let s = deepSpatialAaLuma(uv - vec2f(0.0, t.y));
  let w = deepSpatialAaLuma(uv - vec2f(t.x, 0.0));
  let highest = max(max(max(m, n), max(e, s)), w);
  let contrast = highest - min(min(min(m, n), min(e, s)), w);
  if (contrast < max(0.0312, 0.063 * highest)) { return deepSpatialAaSample(uv); }
  let ne = deepSpatialAaLuma(uv + t); let nw = deepSpatialAaLuma(uv + vec2f(-t.x, t.y));
  let se = deepSpatialAaLuma(uv + vec2f(t.x, -t.y)); let sw = deepSpatialAaLuma(uv - t);
  let f = clamp(abs((2.0 * (n + e + s + w) + ne + nw + se + sw) / 12.0 - m) / contrast, 0.0, 1.0);
  let smoothed = f * f * (3.0 - 2.0 * f); let pixelBlend = smoothed * smoothed;
  let horizontal = abs(n + s - 2.0 * m) * 2.0 + abs(ne + se - 2.0 * e) + abs(nw + sw - 2.0 * w)
    >= abs(e + w - 2.0 * m) * 2.0 + abs(ne + nw - 2.0 * n) + abs(se + sw - 2.0 * s);
  let positive = select(e, n, horizontal); let negative = select(w, s, horizontal);
  let direction = select(1.0, -1.0, abs(positive - m) < abs(negative - m));
  let opposite = select(positive, negative, direction < 0.0);
  let normalStep = select(vec2f(t.x, 0.0), vec2f(0.0, t.y), horizontal) * direction;
  let edgeStep = select(vec2f(0.0, t.y), vec2f(t.x, 0.0), horizontal);
  let edgeLuma = (m + opposite) * 0.5; let threshold = abs(opposite - m) * 0.25;
  let edgeUv = uv + normalStep * 0.5;
  let p = deepSpatialAaSearch(edgeUv, edgeStep, edgeLuma, threshold);
  let q = deepSpatialAaSearch(edgeUv, -edgeStep, edgeLuma, threshold);
  let nearest = select(q, p, p.x <= q.x);
  var edgeBlend = 0.0;
  if ((nearest.y >= 0.0) != (m - edgeLuma >= 0.0)) { edgeBlend = 0.5 - nearest.x / (p.x + q.x); }
  return deepSpatialAaSample(uv + normalStep * max(pixelBlend, edgeBlend));
}
`;

/** Final presentation only: source must not have an sRGB texture format (automatic decoding would undo its domain). */
export const SPATIAL_AA_PRESENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var spatialSource: texture_2d<f32>;
@group(0) @binding(1) var spatialSampler: sampler;
fn deepSpatialAaSample(uv: vec2f) -> vec4f { return textureSampleLevel(spatialSource, spatialSampler, uv, 0.0); }
fn deepSpatialAaTexel() -> vec2f { return 1.0 / vec2f(textureDimensions(spatialSource)); }
${SPATIAL_AA_WGSL}
struct SpatialVertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> SpatialVertex {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var v: SpatialVertex; v.position = vec4f(positions[i], 0.0, 1.0);
  v.uv = positions[i] * vec2f(0.5, -0.5) + 0.5; return v;
}
@fragment fn fragmentMain(v: SpatialVertex) -> @location(0) vec4f { return deepSpatialAa(v.uv); }
`;
