export const OIT_REACTIVE_MASK_WGSL = /* wgsl */ `
@group(0) @binding(0) var revealage: texture_2d<f32>;
@vertex fn reactiveVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}
@fragment fn reactiveFragment(@builtin(position) position: vec4f) -> @location(0) f32 {
  let coverage = 1.0 - clamp(textureLoad(revealage, vec2i(position.xy), 0).x, 0.0, 1.0);
  return coverage;
}
`;
