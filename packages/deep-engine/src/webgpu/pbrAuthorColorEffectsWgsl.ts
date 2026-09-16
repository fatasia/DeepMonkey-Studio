export const PBR_AUTHOR_COLOR_EFFECTS_WGSL = /* wgsl */ `
struct DeepAuthorColorEffects { switches: vec4f, grading: vec4f };
@group(1) @binding(0) var<uniform> authorEffects: DeepAuthorColorEffects;
fn deepAuthorColor(source: vec3f, uv: vec2f) -> vec3f {
  var color = source;
  if (authorEffects.switches.y > 0.5) {
    color = mix(color, vec3f(1.0 - authorEffects.switches.w), dot(uv - 0.5, uv - 0.5));
  }
  if (authorEffects.switches.z > 0.5) {
    let g = authorEffects.grading;
    if (g.x != 0.0) {
      let angle = g.x / 180.0 * 3.14159265;
      let s = sin(angle); let c = cos(angle);
      let weights = (vec3f(2.0 * c, -sqrt(3.0) * s - c, sqrt(3.0) * s - c) + 1.0) / 3.0;
      color = vec3f(dot(color, weights.xyz), dot(color, weights.zxy), dot(color, weights.yzx));
    }
    let average = (color.r + color.g + color.b) / 3.0;
    if (g.y > 0.0) { color += (average - color) * (1.0 - 1.0 / (1.001 - g.y)); }
    else { color += (average - color) * (-g.y); }
    if (g.z != 0.0 || g.w != 0.0) { color += g.z; color = (color - 0.5) * (g.w + 1.0) + 0.5; }
  }
  return color;
}
`;
