// Deep Engine native HDR bloom + exponential fog output contract v1.
@group(0) @binding(0) var hdr_color: texture_2d<f32>;
@group(0) @binding(1) var bloom_color: texture_2d<f32>;
@group(0) @binding(2) var bloom_sampler: sampler;
struct OutputParams { values: vec4f };
@group(0) @binding(3) var<uniform> output: OutputParams;
@group(0) @binding(4) var forward_depth: texture_depth_multisampled_2d;

// Bounded world-space slots share the Web/Three local attenuation and cone policy.
struct LocalLight {
  positionRange: vec4f, directionKind: vec4f, radianceOuter: vec4f, coneDecay: vec4f,
};
struct Frame {
  view: mat4x4f, light: mat4x4f, eye: vec4f, background: vec4f,
  floor: vec4f, lightDirection: vec4f, tuning: vec4f,
  sunColor: vec4f, lightingOptions: vec4f,
  localLights: array<LocalLight, 16>,
  localShadowMatrices: array<mat4x4f, 10>,
  fogProjection: vec4f,
};
@group(0) @binding(5) var<uniform> frame: Frame;

struct OutputVertex { @builtin(position) position: vec4f };

@vertex fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> OutputVertex {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return OutputVertex(vec4f(positions[vertex_index], 0.0, 1.0));
}

fn aces(color: vec3f) -> vec3f {
  return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14),
    vec3f(0.0), vec3f(1.0));
}

fn linear_to_srgb(linear: vec3f) -> vec3f {
  let low = linear * 12.92;
  let high = 1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, linear <= vec3f(0.0031308));
}

fn fogged_hdr(position: vec4f) -> vec4f {
  let pixel = vec2i(position.xy);
  let hdr = textureLoad(hdr_color, pixel, 0);
  let uv = (vec2f(pixel) + 0.5) / vec2f(textureDimensions(hdr_color));
  let glow = textureSampleLevel(bloom_color, bloom_sampler, uv, 0.0).rgb * output.values.x;
  let depth = min(min(textureLoad(forward_depth, pixel, 0), textureLoad(forward_depth, pixel, 1)),
    min(textureLoad(forward_depth, pixel, 2), textureLoad(forward_depth, pixel, 3)));
  // 雾投影行动态读 near/far（与 fog.rs::frame_projection 同源），不再固定 0.1/100。
  let near = frame.fogProjection.x;
  let far = frame.fogProjection.y;
  let distance = near * far / max(far - depth * (far - near), 0.0001);
  let optical_depth = frame.tuning.w * distance;
  let metric = select(optical_depth, optical_depth * optical_depth, frame.fogProjection.z == 2.0);
  let amount = clamp(1.0 - exp(-metric), 0.0, 1.0);
  return vec4f(mix(hdr.rgb + glow, frame.tuning.rgb, amount), hdr.a);
}

@fragment fn fragment_srgb_target(input: OutputVertex) -> @location(0) vec4f {
  let hdr = fogged_hdr(input.position);
  return vec4f(aces(hdr.rgb), hdr.a);
}

@fragment fn fragment_unorm_target(input: OutputVertex) -> @location(0) vec4f {
  let hdr = fogged_hdr(input.position);
  return vec4f(linear_to_srgb(aces(hdr.rgb)), hdr.a);
}
