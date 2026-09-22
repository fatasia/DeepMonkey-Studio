export const WEBGPU_PROBE_CAPTURE_WORKGROUP = 64;
export const WEBGPU_PROBE_VOLUME_WORKGROUP = 8;

export const WEBGPU_PROBE_CAPTURE_WGSL = /* wgsl */ `
struct ProbeUpdate { level: u32, x: u32, y: u32, z: u32 }
struct ProbeParams {
  updateCount: u32,
  gridZ: u32,
  levelCount: u32,
  dynamicHysteresis: f32,
  fallbackRadiance: vec4f,
  // F1 slice-3: energyClamp = max per-channel frame-to-frame change relative to history
  // (0 disables); staticHysteresis = bounded feedback weight for non-dynamic probes (0 keeps
  // them purely freshly filtered). Both multiply an epsilon floor so a dark history can still
  // brighten; hysteresis < 1 makes the feedback chain geometrically bounded ((1-h)^n decay).
  energyClamp: f32,
  staticHysteresis: f32,
  pad0: vec2u,
}

@group(0) @binding(0) var<storage, read> updates: array<ProbeUpdate>;
@group(0) @binding(1) var<uniform> params: ProbeParams;
@group(0) @binding(2) var captureOutput: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var captureInput: texture_2d_array<f32>;
@group(0) @binding(4) var filteredOutput: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(5) var mipInput: texture_2d_array<f32>;
@group(0) @binding(6) var mipOutput: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(7) var historyInput: texture_2d_array<f32>;

const DYNAMIC_PROBE_UPDATE_FLAG: u32 = 0x80000000u;

fn probeLayer(update: ProbeUpdate) -> i32 {
  return i32(update.z + (update.level & ~DYNAMIC_PROBE_UPDATE_FLAG) * params.gridZ);
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
  let filtered = max(sum / 9.0, vec4f(0.0));
  let history = max(textureLoad(historyInput, center, layer, 0), vec4f(0.0));
  let dynamic = (update.level & DYNAMIC_PROBE_UPDATE_FLAG) != 0u;
  let weight = select(params.staticHysteresis, params.dynamicHysteresis, dynamic);
  var blended = mix(filtered, history, vec4f(weight));
  // Bounded energy clamp: each channel may move at most energyClamp * max(history, floor)
  // per committed frame, so a bad capture can flash but never explode the volume.
  if (params.energyClamp > 0.0) {
    let bound = params.energyClamp * max(history.rgb, vec3f(0.05));
    blended = vec4f(clamp(blended.rgb, history.rgb - bound, history.rgb + bound), blended.a);
  }
  textureStore(filteredOutput, center, layer, blended);
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
