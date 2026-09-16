export const AUTHORED_DIRECTIONAL_SHADOW_WGSL = /* wgsl */ `
fn deepAuthorShadowCoordinate(world: vec3f, normal: vec3f) -> vec4f {
  if (deepCascade.params.w < 1.5) { return vec4f(0.0); }
  return deepCascade.matrices[0] * vec4f(world + normal * deepCascade.texelWorld1.x, 1.0);
}
fn deepAuthorShadowVisibility(coordinate: vec4f, fragmentCoordinate: vec2f) -> f32 {
  let ndc = coordinate.xyz / coordinate.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  let depth = ndc.z + deepCascade.params.y;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || depth > 1.0) { return 1.0; }
  let glPixel = vec2f(fragmentCoordinate.x, deepCascade.texelWorld1.w - fragmentCoordinate.y);
  let phi = fract(52.9829189 * fract(dot(glPixel, vec2f(0.06711056, 0.00583715)))) * 6.283185307179586;
  let radius = deepCascade.texelWorld1.z * deepCascade.params.z;
  var visibility = 0.0;
  for (var index = 0u; index < 5u; index++) {
    let r = sqrt((f32(index) + 0.5) / 5.0);
    let theta = f32(index) * 2.399963229728653 + phi;
    let offset = vec2f(cos(theta), -sin(theta)) * r * radius;
    visibility += textureSampleCompareLevel(deepShadowMap, deepShadowSampler, uv + offset, 0, depth);
  }
  return mix(1.0, visibility * 0.2, deepCascade.texelWorld1.y);
}
`;
