/*!
 * SMAA present-chain WGSL assembly (AA-M2 L3 spatial layer): binds the three pass cores
 * (smaaEdgeDetectionWgsl / smaaBlendWeightsWgsl / smaaNeighborhoodBlendingWgsl) into three
 * self-contained shader modules — one render pipeline each, explicit bind declarations,
 * auto layout stays single-pass simple. Upstream: Three.js r185 SMAAShader.js (MIT),
 * formula-for-formula; license notice in spatialAa.LICENSE.md.
 *
 * All passes run on display-encoded premultiplied RGBA (same host contract as the FXAA
 * variant); no tone mapping or transfer function here. SMAA 1x (subsampleIndices = 0).
 */
import { SMAA_EDGE_DETECTION_WGSL } from "./smaaEdgeDetectionWgsl.js";
import { SMAA_BLEND_WEIGHTS_WGSL } from "./smaaBlendWeightsWgsl.js";
import { SMAA_DIAG_WGSL } from "./smaaDiagWgsl.js";
import { SMAA_NEIGHBORHOOD_BLENDING_WGSL } from "./smaaNeighborhoodBlendingWgsl.js";

const SMAA_VERTEX_WGSL = /* wgsl */ `
struct SmaaVertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> SmaaVertex {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var v: SmaaVertex; v.position = vec4f(positions[i], 0.0, 1.0);
  v.uv = positions[i] * vec2f(0.5, -0.5) + 0.5; return v;
}
`;

const edgeHeader = /* wgsl */ `
@group(0) @binding(0) var smaaSource: texture_2d<f32>;
@group(0) @binding(1) var smaaLinearSampler: sampler;
fn smaaSampleColor(uv: vec2f) -> vec4f { return textureSampleLevel(smaaSource, smaaLinearSampler, uv, 0.0); }
fn smaaResolution() -> vec2f { return 1.0 / vec2f(textureDimensions(smaaSource)); }
`;

const weightsHeader = /* wgsl */ `
@group(0) @binding(0) var smaaEdges: texture_2d<f32>;
@group(0) @binding(1) var smaaAreaTex: texture_2d<f32>;
@group(0) @binding(2) var smaaSearchTex: texture_2d<f32>;
@group(0) @binding(3) var smaaLinearSampler: sampler;
@group(0) @binding(4) var smaaPointSampler: sampler;
fn smaaSampleEdges(uv: vec2f) -> vec4f { return textureSampleLevel(smaaEdges, smaaLinearSampler, uv, 0.0); }
fn smaaSampleEdgesOffset(uv: vec2f, texels: vec2f) -> vec4f { // SMAASampleLevelZeroOffset
  return textureSampleLevel(smaaEdges, smaaLinearSampler, uv + texels / vec2f(textureDimensions(smaaEdges)), 0.0);
}
fn smaaSampleArea(uv: vec2f) -> vec2f { return textureSampleLevel(smaaAreaTex, smaaLinearSampler, uv, 0.0).rg; }
fn smaaSampleSearch(uv: vec2f) -> f32 { return textureSampleLevel(smaaSearchTex, smaaPointSampler, uv, 0.0).r; }
fn smaaResolution() -> vec2f { return 1.0 / vec2f(textureDimensions(smaaEdges)); }
// SMAA_AREATEX_PIXEL_SIZE / SMAA_AREATEX_SUBTEX_SIZE (shared by orthogonal and diagonal areas):
const smaaAreaTexPixelSize = vec2f(1.0 / 160.0, 1.0 / 560.0);
const smaaAreaTexSubtexSize = 1.0 / 7.0;
`;

const blendHeader = /* wgsl */ `
@group(0) @binding(0) var smaaSource: texture_2d<f32>;
@group(0) @binding(1) var smaaWeights: texture_2d<f32>;
@group(0) @binding(2) var smaaLinearSampler: sampler;
fn smaaSampleColor(uv: vec2f) -> vec4f { return textureSampleLevel(smaaSource, smaaLinearSampler, uv, 0.0); }
fn smaaSampleWeights(uv: vec2f) -> vec4f { return textureSampleLevel(smaaWeights, smaaLinearSampler, uv, 0.0); }
fn smaaResolution() -> vec2f { return 1.0 / vec2f(textureDimensions(smaaSource)); }
`;

/** Pass 1: color edge detection, writes (edgeX, edgeY, 0, 0) into an rg8unorm target. */
export const SMAA_EDGE_PASS_PRESENT_WGSL = /* wgsl */ `${edgeHeader}
${SMAA_EDGE_DETECTION_WGSL}
${SMAA_VERTEX_WGSL}
@fragment fn fragmentMain(v: SmaaVertex) -> @location(0) vec4f {
  return vec4f(smaaColorEdgeDetectionPS(v.uv), 0.0, 0.0);
}
`;

/** Pass 2: search + crossing-edge + AreaTex blend weights (orthogonal + diagonal + corners). */
export const SMAA_WEIGHTS_PASS_PRESENT_WGSL = /* wgsl */ `${weightsHeader}
${SMAA_DIAG_WGSL}
${SMAA_BLEND_WEIGHTS_WGSL}
${SMAA_VERTEX_WGSL}
@fragment fn fragmentMain(v: SmaaVertex) -> @location(0) vec4f {
  return smaaBlendingWeightCalculationPS(v.uv);
}
`;

/** Pass 3: neighborhood blending of source with the weights target, writes present. */
export const SMAA_BLEND_PASS_PRESENT_WGSL = /* wgsl */ `${blendHeader}
${SMAA_NEIGHBORHOOD_BLENDING_WGSL}
${SMAA_VERTEX_WGSL}
@fragment fn fragmentMain(v: SmaaVertex) -> @location(0) vec4f {
  return smaaNeighborhoodBlendingPS(v.uv);
}
`;
