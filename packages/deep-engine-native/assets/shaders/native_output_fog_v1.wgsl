// Deep Engine native HDR exponential fog output contract v1.
@group(0) @binding(0) var hdr_color: texture_2d<f32>;
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
  localShadowMatrices: array<mat4x4f, 16>,
  fogProjection: vec4f,
  localShadowSoftness: array<vec4f, 4>,
  fogProfile: vec4f,
};
@group(0) @binding(5) var<uniform> frame: Frame;

struct OutputVertex { @builtin(position) position: vec4f };

@vertex fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> OutputVertex {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return OutputVertex(vec4f(positions[vertex_index], 0.0, 1.0));
}

// Output color functions are assembled from shared displayColor and native_output_color.

fn fogged_hdr(position: vec4f) -> vec4f {
  let pixel = vec2i(position.xy);
  let color = textureLoad(hdr_color, pixel, 0);
  let depth = min(min(textureLoad(forward_depth, pixel, 0), textureLoad(forward_depth, pixel, 1)),
    min(textureLoad(forward_depth, pixel, 2), textureLoad(forward_depth, pixel, 3)));
  // 雾投影行动态读 near/far（与 fog.rs::frame_projection 同源），不再固定 0.1/100。
  let near = frame.fogProjection.x;
  let far = frame.fogProjection.y;
  let distance = near * far / max(far - depth * (far - near), 0.0001);
  let optical_depth = frame.tuning.w * distance;
  let metric = select(optical_depth, optical_depth * optical_depth, frame.fogProjection.z == 2.0);
  var amount = clamp(1.0 - deepFogTransmittance(metric), 0.0, 1.0);
  if (frame.fogProjection.z == 1.0) {
    // Recover a world ray from the frame's projection columns. No inverse
    // matrix, froxel texture or extra GPU binding is needed for height falloff.
    let extent = vec2f(textureDimensions(hdr_color));
    let ndc = vec2f(2.0 * position.x / extent.x - 1.0,
      1.0 - 2.0 * position.y / extent.y);
    let right_projection = vec3f(frame.view[0].x, frame.view[1].x, frame.view[2].x);
    let up_projection = vec3f(frame.view[0].y, frame.view[1].y, frame.view[2].y);
    let forward = normalize(vec3f(frame.view[0].w, frame.view[1].w, frame.view[2].w));
    let ray = normalize(forward + ndc.x * right_projection / dot(right_projection, right_projection)
      + ndc.y * up_projection / dot(up_projection, up_projection));
    let ray_distance = distance / max(dot(ray, forward), 0.01);
    let step_count = clamp(u32(round(frame.fogProfile.x)), 1u, 64u);
    let step_distance = ray_distance / f32(step_count);
    let g = clamp(frame.fogProfile.z, -0.99, 0.99);
    let sun_direction = normalize(frame.lightDirection.xyz);
    let cosine = dot(ray, sun_direction);
    let phase = clamp((1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosine, 0.01), 1.5), 0.0, 4.0);
    var transmittance = 1.0;
    var integrated = 0.0;
    for (var step = 0u; step < 64u; step++) {
      if (step >= step_count) { break; }
      let sample_distance = (f32(step) + 0.5) * step_distance;
      let sample_height = frame.eye.y + ray.y * sample_distance;
      let density = deepFogDensityAtHeight(sample_height, frame.tuning.w, frame.fogProfile.y);
      let step_transmittance = deepFogTransmittance(density * step_distance);
      integrated += transmittance * (1.0 - step_transmittance) * phase;
      transmittance *= step_transmittance;
    }
    amount = clamp(integrated, 0.0, 1.0);
  }
  return vec4f(mix(color.rgb, frame.tuning.rgb, amount), color.a);
}

@fragment fn fragment_srgb_target(input: OutputVertex) -> @location(0) vec4f {
  let hdr = fogged_hdr(input.position);
  return vec4f(aces(author_grading_apply(hdr.rgb)), hdr.a);
}

@fragment fn fragment_unorm_target(input: OutputVertex) -> @location(0) vec4f {
  let hdr = fogged_hdr(input.position);
  return vec4f(linear_to_srgb(aces(author_grading_apply(hdr.rgb))), hdr.a);
}
