export const AMBIENT_OCCLUSION_WORKGROUP_SIZE = 8;
export const AMBIENT_OCCLUSION_SAMPLE_COUNT = 16;

const COMMON = /* wgsl */ `
struct AoParams {
  sourceSize: vec2<u32>,
  outputSize: vec2<u32>,
  projection: vec4<f32>,
  tuning: vec4<f32>,
};
fn safeNormal(value: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  return select(vec3f(0.0, 0.0, 1.0), value * inverseSqrt(max(lengthSquared, 0.00000001)), lengthSquared > 0.00000001);
}
fn sourceCoordinate(halfCoordinate: vec2<u32>) -> vec2<u32> {
  return min(halfCoordinate * 2u + vec2<u32>(1u), aoParams.sourceSize - vec2<u32>(1u));
}
fn loadNormal(coordinate: vec2<u32>) -> vec3f {
  // View normals are encoded from [-1, 1] into the renderable rgba8unorm target.
  return safeNormal(textureLoad(sourceNormal, vec2<i32>(coordinate), 0).xyz * 2.0 - 1.0);
}
`;

export const AMBIENT_OCCLUSION_EVALUATE_WGSL = /* wgsl */ `${COMMON}
@group(0) @binding(0) var sourceDepth: texture_2d<f32>;
@group(0) @binding(1) var sourceNormal: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> aoParams: AoParams;
@group(0) @binding(3) var rawAo: texture_storage_2d<r32float, write>;
const AO_PI: f32 = 3.141592653589793;
const AO_DIRECTIONS = array<vec2f, 8>(vec2f(1.0, 0.0), vec2f(0.70710678, 0.70710678),
  vec2f(0.0, 1.0), vec2f(-0.70710678, 0.70710678), vec2f(-1.0, 0.0),
  vec2f(-0.70710678, -0.70710678), vec2f(0.0, -1.0), vec2f(0.70710678, -0.70710678));
fn noiseRotation(coordinate: vec2<u32>) -> mat2x2<f32> {
  var hash = coordinate.x * 0x9e3779b9u + coordinate.y * 0x85ebca6bu + 0xc2b2ae35u;
  hash = hash ^ (hash >> 16u); hash = hash * 0x7feb352du; hash = hash ^ (hash >> 15u);
  let quadrant = hash & 3u;
  if (quadrant == 0u) { return mat2x2<f32>(1.0, 0.0, 0.0, 1.0); }
  if (quadrant == 1u) { return mat2x2<f32>(0.0, 1.0, -1.0, 0.0); }
  if (quadrant == 2u) { return mat2x2<f32>(-1.0, 0.0, 0.0, -1.0); }
  return mat2x2<f32>(0.0, -1.0, 1.0, 0.0);
}
fn reconstructPosition(coordinate: vec2<u32>, depth: f32) -> vec3f {
  let uv = (vec2f(coordinate) + 0.5) / vec2f(aoParams.sourceSize);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return vec3f(ndc.x * depth * aoParams.projection.x * aoParams.projection.y,
    ndc.y * depth * aoParams.projection.x, -depth);
}
@compute @workgroup_size(8, 8)
fn evaluateAo(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= aoParams.outputSize.x || id.y >= aoParams.outputSize.y) { return; }
  let centerCoordinate = sourceCoordinate(id.xy);
  let centerDepth = textureLoad(sourceDepth, vec2<i32>(centerCoordinate), 0).x;
  if (!(centerDepth > 0.0)) { textureStore(rawAo, vec2<i32>(id.xy), vec4f(1.0)); return; }
  let centerPosition = reconstructPosition(centerCoordinate, centerDepth); let normal = loadNormal(centerCoordinate);
  let radius = aoParams.projection.z; let thickness = aoParams.projection.w;
  let radiusPixels = clamp(radius / centerDepth * f32(aoParams.sourceSize.y) / (2.0 * aoParams.projection.x), 1.0, 32.0);
  let rotation = noiseRotation(centerCoordinate); var occlusion = 0.0; var validSamples = 0.0;
  for (var sampleIndex = 0u; sampleIndex < 16u; sampleIndex++) {
    let ringScale = select(0.5, 1.0, sampleIndex >= 8u);
    let offset = rotation * AO_DIRECTIONS[sampleIndex & 7u] * radiusPixels * ringScale;
    let maximum = vec2<i32>(aoParams.sourceSize) - vec2<i32>(1);
    let sampleCoordinate = vec2<u32>(clamp(vec2<i32>(floor(vec2f(centerCoordinate) + offset + 0.5)), vec2<i32>(0), maximum));
    let sampleDepth = textureLoad(sourceDepth, vec2<i32>(sampleCoordinate), 0).x;
    if (sampleDepth > 0.0) {
      let delta = reconstructPosition(sampleCoordinate, sampleDepth) - centerPosition;
      let distance = length(delta);
      if (distance > 0.0001 && distance < radius) {
        let horizon = max(dot(normal, delta / distance) - thickness / distance, 0.0);
        occlusion += horizon * (1.0 - distance / radius); validSamples += 1.0;
      }
    }
  }
  let visibility = pow(clamp(1.0 - 2.0 * occlusion / max(validSamples, 1.0), 0.0, 1.0), aoParams.tuning.x);
  textureStore(rawAo, vec2<i32>(id.xy), vec4f(visibility, 0.0, 0.0, 0.0));
}
`;

export const AMBIENT_OCCLUSION_BLUR_WGSL = /* wgsl */ `${COMMON}
override HORIZONTAL: bool = true;
@group(0) @binding(0) var sourceDepth: texture_2d<f32>;
@group(0) @binding(1) var sourceNormal: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> aoParams: AoParams;
@group(0) @binding(3) var sourceAo: texture_2d<f32>;
@group(0) @binding(4) var targetAo: texture_storage_2d<r32float, write>;
const BLUR_WEIGHTS = array<f32, 5>(0.06136, 0.24477, 0.38774, 0.24477, 0.06136);
@compute @workgroup_size(8, 8)
fn bilateralBlur(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= aoParams.outputSize.x || id.y >= aoParams.outputSize.y) { return; }
  let centerSource = sourceCoordinate(id.xy); let centerDepth = textureLoad(sourceDepth, vec2<i32>(centerSource), 0).x;
  let centerNormal = loadNormal(centerSource); var weighted = 0.0; var totalWeight = 0.0;
  for (var tap = -2; tap <= 2; tap++) {
    let direction = select(vec2<i32>(0, tap), vec2<i32>(tap, 0), HORIZONTAL);
    let sampleHalf = vec2<u32>(clamp(vec2<i32>(id.xy) + direction, vec2<i32>(0), vec2<i32>(aoParams.outputSize) - 1));
    let sampleSource = sourceCoordinate(sampleHalf); let sampleDepth = textureLoad(sourceDepth, vec2<i32>(sampleSource), 0).x;
    let sampleNormal = loadNormal(sampleSource); let spatial = BLUR_WEIGHTS[u32(tap + 2)];
    let depthWeight = exp(-abs(sampleDepth - centerDepth) / max(aoParams.projection.w, 0.0001));
    let normalWeight = pow(max(dot(centerNormal, sampleNormal), 0.0), 8.0);
    let validWeight = select(0.0, 1.0, centerDepth > 0.0 && sampleDepth > 0.0);
    let weight = spatial * depthWeight * normalWeight * validWeight;
    weighted += textureLoad(sourceAo, vec2<i32>(sampleHalf), 0).x * weight; totalWeight += weight;
  }
  let fallback = textureLoad(sourceAo, vec2<i32>(id.xy), 0).x;
  textureStore(targetAo, vec2<i32>(id.xy), vec4f(select(fallback, weighted / totalWeight, totalWeight > 0.000001), 0.0, 0.0, 0.0));
}
`;
