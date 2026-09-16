import { AUTHOR_BLOOM_RADII, authorBloomCoefficients } from "./authorBloomCpu.js";

// r185 UnrealBloomPass uses destination-size UV offsets, including when the source is the preceding mip.
export const AUTHOR_BLOOM_WGSL = /* wgsl */ `
struct Settings { threshold: f32, strength: f32, padding: vec2f };
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var mip0: texture_2d<f32>;
@group(0) @binding(2) var mip1: texture_2d<f32>;
@group(0) @binding(3) var mip2: texture_2d<f32>;
@group(0) @binding(4) var mip3: texture_2d<f32>;
@group(0) @binding(5) var mip4: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> settings: Settings;
@group(0) @binding(7) var destination: texture_storage_2d<rgba16float, write>;
fn loadClamped(tex: texture_2d<f32>, xy: vec2i) -> vec4f {
  return textureLoad(tex, clamp(xy, vec2i(0), vec2i(textureDimensions(tex)) - 1), 0);
}
fn bilinear(tex: texture_2d<f32>, uv: vec2f) -> vec4f {
  let position = uv * vec2f(textureDimensions(tex)) - 0.5;
  let base = vec2i(floor(position)); let fraction = fract(position);
  return mix(mix(loadClamped(tex, base), loadClamped(tex, base + vec2i(1, 0)), fraction.x),
    mix(loadClamped(tex, base + vec2i(0, 1)), loadClamped(tex, base + vec2i(1, 1)), fraction.x), fraction.y);
}
@compute @workgroup_size(8, 8) fn extract(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination); if (any(id.xy >= size)) { return; }
  let color = bilinear(source, (vec2f(id.xy) + 0.5) / vec2f(size));
  let alpha = smoothstep(settings.threshold, settings.threshold + 0.01, dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722)));
  textureStore(destination, id.xy, color * alpha);
}
${AUTHOR_BLOOM_RADII.map((radius, index) => {
  const coefficients = authorBloomCoefficients(radius).map(value => `${value}`).join(", ");
  return `fn blur${index}(xy: vec2u, direction: vec2f) {
  let size = textureDimensions(destination); if (any(xy >= size)) { return; }
  let weights = array<f32, ${radius}>(${coefficients});
  let uv = (vec2f(xy) + 0.5) / vec2f(size); let offset = direction / vec2f(size);
  var color = bilinear(source, uv).rgb * weights[0];
  for (var i = 1u; i < ${radius}u; i++) {
    color += (bilinear(source, uv + offset * f32(i)).rgb + bilinear(source, uv - offset * f32(i)).rgb) * weights[i];
  }
  textureStore(destination, xy, vec4f(color, 1.0));
}
@compute @workgroup_size(8, 8) fn horizontal${index}(@builtin(global_invocation_id) id: vec3u) { blur${index}(id.xy, vec2f(1.0, 0.0)); }
@compute @workgroup_size(8, 8) fn vertical${index}(@builtin(global_invocation_id) id: vec3u) { blur${index}(id.xy, vec2f(0.0, 1.0)); }`;
}).join("\n")}
@compute @workgroup_size(8, 8) fn combine(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination); if (any(id.xy >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let color = 3.0 * settings.strength * (0.8 * bilinear(mip0, uv).rgb + 0.7 * bilinear(mip1, uv).rgb
    + 0.6 * bilinear(mip2, uv).rgb + 0.5 * bilinear(mip3, uv).rgb + 0.4 * bilinear(mip4, uv).rgb);
  textureStore(destination, id.xy, vec4f(color, max(color.r, max(color.g, color.b))));
}
@compute @workgroup_size(8, 8) fn composite(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination); if (any(id.xy >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  textureStore(destination, id.xy, textureLoad(source, id.xy, 0) + bilinear(mip0, uv));
}
`;
