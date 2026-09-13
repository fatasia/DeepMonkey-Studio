export const TEMPORAL_AA_WORKGROUP_SIZE = 8;
export const TEMPORAL_AA_WGSL = /* wgsl */ `
struct TemporalParams {
  sizeHistory: vec4<u32>,
  jitter: vec4<f32>,
  tuning: vec4<f32>,
};
@group(0) @binding(0) var currentColor: texture_2d<f32>;
@group(0) @binding(1) var currentDepth: texture_2d<f32>;
@group(0) @binding(2) var motionVectors: texture_2d<f32>;
@group(0) @binding(3) var previousColor: texture_2d<f32>;
@group(0) @binding(4) var previousDepth: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> temporalParams: TemporalParams;
@group(0) @binding(6) var outputColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var outputDepth: texture_storage_2d<r32float, write>;

fn rgbToYCoCg(rgb: vec3f) -> vec3f {
  return vec3f(rgb.r * 0.25 + rgb.g * 0.5 + rgb.b * 0.25, rgb.r * 0.5 - rgb.b * 0.5,
    -rgb.r * 0.25 + rgb.g * 0.5 - rgb.b * 0.25);
}
fn yCoCgToRgb(value: vec3f) -> vec3f {
  return vec3f(value.x + value.y - value.z, value.x + value.z, value.x - value.y - value.z);
}
@compute @workgroup_size(8, 8)
fn resolveTemporal(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = temporalParams.sizeHistory.xy;
  if (id.x >= size.x || id.y >= size.y) { return; }
  let coordinate = vec2<i32>(id.xy); let color = textureLoad(currentColor, coordinate, 0);
  let depth = textureLoad(currentDepth, coordinate, 0).x;
  var resolved = color.rgb;
  if (temporalParams.sizeHistory.z == 1u && depth > 0.0) {
    let motion = textureLoad(motionVectors, coordinate, 0).xy;
    let previousPosition = vec2f(id.xy) + 0.5 + motion * vec2f(size) + temporalParams.jitter.zw - temporalParams.jitter.xy;
    let inside = all(previousPosition >= vec2f(0.0)) && all(previousPosition < vec2f(size));
    if (inside) {
      let previousCoordinate = vec2<i32>(floor(previousPosition));
      let historicalDepth = textureLoad(previousDepth, previousCoordinate, 0).x;
      let threshold = max(temporalParams.tuning.y, depth * temporalParams.tuning.z);
      if (historicalDepth > 0.0 && abs(historicalDepth - depth) <= threshold) {
        var minimum = vec3f(1e20); var maximum = vec3f(-1e20);
        for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
          let neighbor = clamp(coordinate + vec2<i32>(x, y), vec2<i32>(0), vec2<i32>(size) - 1);
          let ycocg = rgbToYCoCg(textureLoad(currentColor, neighbor, 0).rgb);
          minimum = min(minimum, ycocg); maximum = max(maximum, ycocg);
        } }
        let history = rgbToYCoCg(textureLoad(previousColor, previousCoordinate, 0).rgb);
        let clampedHistory = yCoCgToRgb(clamp(history, minimum, maximum));
        resolved = mix(color.rgb, clampedHistory, temporalParams.tuning.x);
      }
    }
  }
  textureStore(outputColor, coordinate, vec4f(max(resolved, vec3f(0.0)), color.a));
  textureStore(outputDepth, coordinate, vec4f(max(depth, 0.0), 0.0, 0.0, 0.0));
}
`;
