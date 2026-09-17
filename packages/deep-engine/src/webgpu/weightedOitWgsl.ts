export const WEIGHTED_OIT_FRAGMENT_WGSL = /* wgsl */ `
struct DeepWeightedOitOutput {
  @location(0) accumulation: vec4f,
  @location(1) revealage: f32,
};

fn deepWeightedOitWeight(alpha: f32, normalizedLinearDepth: f32) -> f32 {
  let alphaWeight = clamp(alpha * 8.0 + 0.01, 0.01, 8.0);
  let depthWeight = max(1.0 - clamp(normalizedLinearDepth, 0.0, 1.0) * 0.95, 0.05);
  return alphaWeight * depthWeight;
}

fn deepWeightedOit(linearColor: vec3f, alphaInput: f32, normalizedLinearDepth: f32) -> DeepWeightedOitOutput {
  let alpha = clamp(alphaInput, 0.0, 1.0);
  let weight = deepWeightedOitWeight(alpha, normalizedLinearDepth);
  var output: DeepWeightedOitOutput;
  output.accumulation = vec4f(max(linearColor, vec3f(0.0)) * alpha * weight, alpha * weight);
  output.revealage = alpha;
  return output;
}

// DE26/C03 premultiplied 变体：输入 RGB 已含 alpha，累积不得二次乘；合成公式不受影响
// （Σ(C·a)w / Σa·w 恰为 straight 空间按 a·w 加权的平均颜色）。
fn deepWeightedOitPremultiplied(premultipliedColor: vec3f, alphaInput: f32, normalizedLinearDepth: f32) -> DeepWeightedOitOutput {
  let alpha = clamp(alphaInput, 0.0, 1.0);
  let weight = deepWeightedOitWeight(alpha, normalizedLinearDepth);
  var output: DeepWeightedOitOutput;
  output.accumulation = vec4f(max(premultipliedColor, vec3f(0.0)) * weight, alpha * weight);
  output.revealage = alpha;
  return output;
}
`;

export const WEIGHTED_OIT_COMPOSITE_WGSL = /* wgsl */ `
@group(0) @binding(0) var opaqueTexture: texture_2d<f32>;
@group(0) @binding(1) var accumulationTexture: texture_2d<f32>;
@group(0) @binding(2) var revealageTexture: texture_2d<f32>;

@vertex
fn compositeVertex(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  let x = f32((vertexIndex << 1u) & 2u);
  let y = f32(vertexIndex & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn compositeFragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2<i32>(position.xy);
  let opaque = textureLoad(opaqueTexture, pixel, 0);
  let accumulation = textureLoad(accumulationTexture, pixel, 0);
  let revealage = clamp(textureLoad(revealageTexture, pixel, 0).x, 0.0, 1.0);
  let transparent = accumulation.rgb / max(accumulation.a, 0.00001);
  let coverage = 1.0 - revealage;
  return vec4f(transparent * coverage + opaque.rgb * revealage, coverage + opaque.a * revealage);
}
`;
