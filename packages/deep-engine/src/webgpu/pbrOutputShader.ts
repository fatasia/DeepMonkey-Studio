import { PBR_DISPLAY_COLOR_WGSL } from "./pbrDisplayColorWgsl.js";
import { PBR_AUTHOR_COLOR_EFFECTS_WGSL } from "./pbrAuthorColorEffectsWgsl.js";

export const outputShader = /* wgsl */ `${PBR_DISPLAY_COLOR_WGSL}
${PBR_AUTHOR_COLOR_EFFECTS_WGSL}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> settings: DeepOutputSettings;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> Vertex {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: Vertex; out.position = vec4f(positions[i], 0.0, 1.0);
  out.uv = positions[i] * vec2f(0.5, -0.5) + 0.5; return out;
}
@fragment fn fragmentMain(v: Vertex) -> @location(0) vec4f {
  var color = textureSample(source, sourceSampler, v.uv).rgb;
  if (authorEffects.switches.x > 0.5) {
    let authorSettings = DeepOutputSettings(settings.exposure, 0.0, 0.0, settings.toneMapping, 0.0, 0.0, 1.0, 1.0);
    return vec4f(deepDisplayColor(deepAuthorColor(color, v.uv), authorSettings), 1.0);
  }
  let radial = dot(v.uv - 0.5, v.uv - 0.5);
  color *= 1.0 - settings.vignette * smoothstep(0.05, 0.5, radial);
  return vec4f(deepDisplayColor(color, settings), 1.0);
}
`;
