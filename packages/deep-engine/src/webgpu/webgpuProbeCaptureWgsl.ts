export const WEBGPU_PROBE_CAPTURE_WORKGROUP = 64;
export const WEBGPU_PROBE_VOLUME_WORKGROUP = 8;

export const WEBGPU_PROBE_CAPTURE_WGSL = /* wgsl */ `
struct ProbeUpdate { level: u32, x: u32, y: u32, z: u32 }
struct ProbeParams {
  updateCount: u32,
  gridZ: u32,
  levelCount: u32,
  _padding: u32,
  fallbackRadiance: vec4f,
}

@group(0) @binding(0) var<storage, read> updates: array<ProbeUpdate>;
@group(0) @binding(1) var<uniform> params: ProbeParams;
@group(0) @binding(2) var captureOutput: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var captureInput: texture_2d_array<f32>;
@group(0) @binding(4) var filteredOutput: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(5) var mipInput: texture_2d_array<f32>;
@group(0) @binding(6) var mipOutput: texture_storage_2d_array<rgba16float, write>;

fn probeLayer(update: ProbeUpdate) -> i32 {
  return i32(update.z + update.level * params.gridZ);
}

@compute @workgroup_size(8, 8, 1)
fn clearCapture(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(captureOutput);
  if (id.x >= size.x || id.y >= size.y || id.z >= textureNumLayers(captureOutput)) { return; }
  textureStore(captureOutput, vec2i(id.xy), i32(id.z), params.fallbackRadiance);
}

@compute @workgroup_size(8, 8, 1)
fn clearFiltered(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(filteredOutput);
  if (id.x >= size.x || id.y >= size.y || id.z >= textureNumLayers(filteredOutput)) { return; }
  textureStore(filteredOutput, vec2i(id.xy), i32(id.z), vec4f(0.0));
}

@compute @workgroup_size(64)
fn captureFallback(@builtin(global_invocation_id) id: vec3u) {
  let count = min(params.updateCount, arrayLength(&updates));
  if (id.x >= count) { return; }
  let update = updates[id.x];
  textureStore(captureOutput, vec2i(i32(update.x), i32(update.y)), probeLayer(update), params.fallbackRadiance);
}

@compute @workgroup_size(64)
fn filterIrradiance(@builtin(global_invocation_id) id: vec3u) {
  let count = min(params.updateCount, arrayLength(&updates));
  if (id.x >= count) { return; }
  let update = updates[id.x];
  let size = vec2i(textureDimensions(captureInput));
  let center = vec2i(i32(update.x), i32(update.y));
  let layer = probeLayer(update);
  var sum = vec4f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sum += textureLoad(captureInput, clamp(center + vec2i(x, y), vec2i(0), size - vec2i(1)), layer, 0);
    }
  }
  textureStore(filteredOutput, center, layer, max(sum / 9.0, vec4f(0.0)));
}

@compute @workgroup_size(8, 8, 1)
fn buildMip(@builtin(global_invocation_id) id: vec3u) {
  let targetSize = textureDimensions(mipOutput);
  if (id.x >= targetSize.x || id.y >= targetSize.y || id.z >= textureNumLayers(mipOutput)) { return; }
  let sourceSize = vec2i(textureDimensions(mipInput));
  let base = vec2i(id.xy * 2u);
  var sum = vec4f(0.0);
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      sum += textureLoad(mipInput, min(base + vec2i(x, y), sourceSize - vec2i(1)), i32(id.z), 0);
    }
  }
  textureStore(mipOutput, vec2i(id.xy), i32(id.z), max(sum * 0.25, vec4f(0.0)));
}
`;
