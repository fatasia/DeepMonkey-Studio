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
// Reactive coverage (r8unorm, 0-255 → 0-1): transparent/particle regions whose motion
// target carries opaque background motion. Scales the trusted feedback exactly like
// temporalResponseMask.applyResponseFeedback; a zero mask keeps the baseline formula
// bit-identical (1.0 - 0.0 is exact in IEEE-754).
@group(0) @binding(8) var reactiveMask: texture_2d<f32>;

// GHOST_GUARD decision layer (AA-M2 follow-up slice, compile-time switch shared by both
// temporal kernels): the residual-energy fix wired into the production resolve, formula
// identical to the decision branch of postprocess/temporalReprojection.ts
// accumulateTemporalFrameDetailed. Literal constants below are pinned to
// GHOST_GUARD_REPROJECTION_POLICY by temporalAaWgslChecksum.test.ts (same single source
// as the T07 GPU probe, no duplicated hardcode). 0 = off: only the baseline branch runs
// and the output stays bit-identical to the shipped TAA; hosts enable it through
// enableTemporalGhostGuardWgsl (TemporalAaPass ghostGuard option / T07 probe).
const DEEP_TEMPORAL_GHOST_GUARD: u32 = 0u;

fn rgbToYCoCg(rgb: vec3f) -> vec3f {
  return vec3f(rgb.r * 0.25 + rgb.g * 0.5 + rgb.b * 0.25, rgb.r * 0.5 - rgb.b * 0.5,
    -rgb.r * 0.25 + rgb.g * 0.5 - rgb.b * 0.25);
}
fn yCoCgToRgb(value: vec3f) -> vec3f {
  return vec3f(value.x + value.y - value.z, value.x + value.z, value.x - value.y - value.z);
}
// Rejected depth taps contribute neither color nor weight, preserving disocclusion rejection.
fn sampleHistory(position: vec2f, size: vec2u, depth: f32, threshold: f32) -> vec4f {
  let samplePosition = position - 0.5;
  let base = vec2i(floor(samplePosition));
  let fraction = fract(samplePosition);
  var color = vec3f(0.0); var acceptedWeight = 0.0;
  for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
    let weight = select(1.0 - fraction.x, fraction.x, x == 1)
      * select(1.0 - fraction.y, fraction.y, y == 1);
    let coordinate = clamp(base + vec2i(x, y), vec2i(0), vec2i(size) - 1);
    let historicalDepth = textureLoad(previousDepth, coordinate, 0).x;
    if (weight > 0.0 && historicalDepth > 0.0 && abs(historicalDepth - depth) <= threshold) {
      color += textureLoad(previousColor, coordinate, 0).rgb * weight;
      acceptedWeight += weight;
    }
  } }
  if (acceptedWeight <= 0.0) { return vec4f(0.0); }
  return vec4f(color / acceptedWeight, acceptedWeight);
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
      let threshold = max(temporalParams.tuning.y, depth * temporalParams.tuning.z);
      let historicalColor = sampleHistory(previousPosition, size, depth, threshold);
      if (historicalColor.a > 0.0) {
        var minimum = vec3f(1e20); var maximum = vec3f(-1e20);
        for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
          let neighbor = clamp(coordinate + vec2<i32>(x, y), vec2<i32>(0), vec2<i32>(size) - 1);
          let ycocg = rgbToYCoCg(textureLoad(currentColor, neighbor, 0).rgb);
          minimum = min(minimum, ycocg); maximum = max(maximum, ycocg);
        } }
        let history = rgbToYCoCg(historicalColor.rgb);
        let clampedHistory = yCoCgToRgb(clamp(history, minimum, maximum));
        let reactive = clamp(textureLoad(reactiveMask, coordinate, 0).x, 0.0, 1.0);
        if (DEEP_TEMPORAL_GHOST_GUARD == 0u) {
          resolved = mix(color.rgb, clampedHistory, temporalParams.tuning.x * (1.0 - reactive));
        } else {
          // GHOST_GUARD 决策层(与 accumulateTemporalFrameDetailed 决策分支同式;
          // acceptedRatio 拒绝时 box fallback 优先,reactive 降权在 decay 乘子之前生效):
          let acceptedRatio = historicalColor.a;
          if (acceptedRatio < 0.25) {
            var boxMean = vec3f(0.0);
            for (var oy = -1; oy <= 1; oy++) { for (var ox = -1; ox <= 1; ox++) {
              let neighbor = clamp(coordinate + vec2<i32>(ox, oy), vec2<i32>(0), vec2<i32>(size) - 1);
              boxMean = boxMean + textureLoad(currentColor, neighbor, 0).rgb / 9.0;
            } }
            resolved = max(boxMean, vec3f(0.0));
          } else {
            let historyError = dot(abs(clampedHistory - color.rgb), vec3f(1.0)) / 3.0;
            var feedback = temporalParams.tuning.x * (1.0 - reactive);
            if (historyError > 0.05) { feedback = feedback * 0.1; }
            resolved = mix(color.rgb, clampedHistory, feedback);
          }
        }
      }
    }
  }
  textureStore(outputColor, coordinate, vec4f(max(resolved, vec3f(0.0)), color.a));
  textureStore(outputDepth, coordinate, vec4f(max(depth, 0.0), 0.0, 0.0, 0.0));
}
