export const BLOOM_WORKGROUP_SIZE = 8;

export const BLOOM_WGSL = /* wgsl */ `
struct BloomParams {
  threshold: f32,
  softKnee: f32,
  intensity: f32,
  padding: f32,
};
@group(0) @binding(0) var primarySource: texture_2d<f32>;
@group(0) @binding(1) var secondarySource: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> bloomParams: BloomParams;
@group(0) @binding(3) var targetTexture: texture_storage_2d<rgba16float, write>;

fn loadClamped(source: texture_2d<f32>, coordinate: vec2<i32>) -> vec4<f32> {
  let size = vec2<i32>(textureDimensions(source));
  return textureLoad(source, clamp(coordinate, vec2<i32>(0), size - vec2<i32>(1)), 0);
}

fn downsampleBox(source: texture_2d<f32>, coordinate: vec2<u32>) -> vec4<f32> {
  let origin = vec2<i32>(coordinate * 2u);
  return (loadClamped(source, origin) + loadClamped(source, origin + vec2<i32>(1, 0))
    + loadClamped(source, origin + vec2<i32>(0, 1)) + loadClamped(source, origin + vec2<i32>(1, 1))) * 0.25;
}

fn extract(color: vec3<f32>) -> vec3<f32> {
  let positive = max(color, vec3<f32>(0.0));
  let brightness = max(max(positive.r, positive.g), positive.b);
  let knee = bloomParams.threshold * bloomParams.softKnee;
  var soft = 0.0;
  if (knee > 0.0) {
    let transition = clamp(brightness - bloomParams.threshold + knee, 0.0, 2.0 * knee);
    soft = transition * transition / (4.0 * knee);
  }
  let contribution = max(brightness - bloomParams.threshold, soft) / max(brightness, 0.00001);
  return positive * contribution;
}

fn bilinear(source: texture_2d<f32>, coordinate: vec2<u32>, targetSize: vec2<u32>) -> vec4<f32> {
  let sourceSize = textureDimensions(source);
  let position = (vec2<f32>(coordinate) + vec2<f32>(0.5)) * vec2<f32>(sourceSize) / vec2<f32>(targetSize) - vec2<f32>(0.5);
  let base = vec2<i32>(floor(position));
  let fraction = fract(position);
  let top = mix(loadClamped(source, base), loadClamped(source, base + vec2<i32>(1, 0)), fraction.x);
  let bottom = mix(loadClamped(source, base + vec2<i32>(0, 1)), loadClamped(source, base + vec2<i32>(1, 1)), fraction.x);
  return mix(top, bottom, fraction.y);
}

@compute @workgroup_size(8, 8)
fn extractDownsample(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(targetTexture);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let color = downsampleBox(primarySource, id.xy);
  textureStore(targetTexture, vec2<i32>(id.xy), vec4<f32>(extract(color.rgb), 1.0));
}

@compute @workgroup_size(8, 8)
fn downsample(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(targetTexture);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let color = downsampleBox(primarySource, id.xy);
  textureStore(targetTexture, vec2<i32>(id.xy), vec4<f32>(color.rgb, 1.0));
}

fn gaussian(coordinate: vec2<i32>, direction: vec2<i32>) -> vec3<f32> {
  return loadClamped(primarySource, coordinate - direction * 2).rgb * 0.0625
    + loadClamped(primarySource, coordinate - direction).rgb * 0.25
    + loadClamped(primarySource, coordinate).rgb * 0.375
    + loadClamped(primarySource, coordinate + direction).rgb * 0.25
    + loadClamped(primarySource, coordinate + direction * 2).rgb * 0.0625;
}

@compute @workgroup_size(8, 8)
fn blurHorizontal(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(targetTexture);
  if (id.x >= size.x || id.y >= size.y) { return; }
  textureStore(targetTexture, vec2<i32>(id.xy), vec4<f32>(gaussian(vec2<i32>(id.xy), vec2<i32>(1, 0)), 1.0));
}

@compute @workgroup_size(8, 8)
fn blurVertical(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(targetTexture);
  if (id.x >= size.x || id.y >= size.y) { return; }
  textureStore(targetTexture, vec2<i32>(id.xy), vec4<f32>(gaussian(vec2<i32>(id.xy), vec2<i32>(0, 1)), 1.0));
}

@compute @workgroup_size(8, 8)
fn upsampleCombine(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(targetTexture);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let high = textureLoad(primarySource, vec2<i32>(id.xy), 0).rgb;
  let low = bilinear(secondarySource, id.xy, size).rgb;
  // 保持均匀辐亮度，不让层数或分辨率放大整个亮区的能量。
  textureStore(targetTexture, vec2<i32>(id.xy), vec4<f32>(mix(high, low, 0.5), 1.0));
}

@compute @workgroup_size(8, 8)
fn compositeScene(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(targetTexture);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let scene = textureLoad(primarySource, vec2<i32>(id.xy), 0);
  let bloom = bilinear(secondarySource, id.xy, size).rgb;
  textureStore(targetTexture, vec2<i32>(id.xy), vec4<f32>(scene.rgb + bloom * bloomParams.intensity, scene.a));
}
`;
