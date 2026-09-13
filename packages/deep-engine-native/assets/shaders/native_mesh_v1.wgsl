// Deep Engine native mesh shader contract v1.
struct Frame {
  view: mat4x4f,
  light: mat4x4f,
  eye: vec4f,
  background: vec4f,
  floor: vec4f,
  lightDirection: vec4f,
  tuning: vec4f,
};
struct MaterialTextures {
  base_row_0: vec4f, base_row_1: vec4f,
  mr_row_0: vec4f, mr_row_1: vec4f,
  occlusion_row_0: vec4f, occlusion_row_1: vec4f,
  normal_row_0: vec4f, normal_row_1: vec4f,
  emissive_row_0: vec4f, emissive_row_1: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(3) var specular_environment: texture_cube<f32>;
@group(0) @binding(4) var diffuse_environment: texture_cube<f32>;
@group(0) @binding(5) var brdf_lut: texture_2d<f32>;
@group(0) @binding(6) var environment_sampler: sampler;
@group(1) @binding(0) var base_color_map: texture_2d<f32>;
@group(1) @binding(1) var base_color_sampler: sampler;
@group(1) @binding(2) var metallic_roughness_map: texture_2d<f32>;
@group(1) @binding(3) var metallic_roughness_sampler: sampler;
@group(1) @binding(4) var<uniform> material_textures: MaterialTextures;
@group(1) @binding(5) var occlusion_map: texture_2d<f32>;
@group(1) @binding(6) var occlusion_sampler: sampler;
@group(1) @binding(7) var normal_map: texture_2d<f32>;
@group(1) @binding(8) var normal_sampler: sampler;
@group(1) @binding(9) var emissive_map: texture_2d<f32>;
@group(1) @binding(10) var emissive_sampler: sampler;

struct VertexOutput {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) tangent: vec4f,
  @location(3) uv0: vec2f,
  @location(4) uv1: vec2f,
  @location(5) base_color: vec4f,
  @location(6) material: vec4f,
  @location(7) emissive_alpha: vec4f,
};

struct VertexInput {
  @location(0) position: vec3f, @location(1) normal: vec3f,
  @location(2) model_0: vec4f, @location(3) model_1: vec4f, @location(4) model_2: vec4f,
  @location(5) normal_0: vec4f, @location(6) normal_1: vec4f, @location(7) normal_2: vec4f,
  @location(8) base_color: vec4f, @location(9) material: vec4f,
  @location(10) uv0: vec2f, @location(12) emissive_alpha: vec4f, @location(13) uv1: vec2f,
};
struct TangentInput {
  @location(0) position: vec3f, @location(1) normal: vec3f,
  @location(2) model_0: vec4f, @location(3) model_1: vec4f, @location(4) model_2: vec4f,
  @location(5) normal_0: vec4f, @location(6) normal_1: vec4f, @location(7) normal_2: vec4f,
  @location(8) base_color: vec4f, @location(9) material: vec4f,
  @location(10) uv0: vec2f, @location(11) tangent: vec4f,
  @location(12) emissive_alpha: vec4f, @location(13) uv1: vec2f,
};

fn safe_normalize(value: vec3f, fallback: vec3f) -> vec3f {
  let length_squared = dot(value, value);
  let normalized = value * inverseSqrt(max(length_squared, 0.00000001));
  return select(fallback, normalized, length_squared > 0.00000001);
}

fn tangent_fallback(normal: vec3f) -> vec3f {
  let axis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(normal.x) > 0.9);
  return safe_normalize(cross(axis, normal), vec3f(0.0, 0.0, 1.0));
}

fn build_vertex(position: vec3f, normal: vec3f, model_0: vec4f, model_1: vec4f,
  model_2: vec4f, normal_0: vec4f, normal_1: vec4f, normal_2: vec4f,
  base_color: vec4f, material: vec4f, uv0: vec2f, uv1: vec2f,
  emissive_alpha: vec4f, tangent: vec4f) -> VertexOutput {
  let normal_matrix = mat3x3f(normal_0.xyz, normal_1.xyz, normal_2.xyz);
  let local = vec4f(position, 1.0);
  let authored = vec3f(dot(model_0, local), dot(model_1, local), dot(model_2, local));
  let world = authored;
  let world_normal = safe_normalize(normal_matrix * normal, vec3f(0.0, 1.0, 0.0));
  var world_tangent = vec3f(dot(model_0.xyz, tangent.xyz),
    dot(model_1.xyz, tangent.xyz), dot(model_2.xyz, tangent.xyz));
  world_tangent = safe_normalize(
    world_tangent - world_normal * dot(world_normal, world_tangent), tangent_fallback(world_normal));
  var out: VertexOutput;
  out.clip = frame.view * vec4f(world, 1.0);
  out.world = world; out.normal = world_normal;
  out.tangent = vec4f(world_tangent, tangent.w * material.z);
  out.uv0 = uv0; out.uv1 = uv1; out.base_color = base_color; out.material = material;
  out.emissive_alpha = emissive_alpha;
  return out;
}

@vertex fn vertex_main(v: VertexInput) -> VertexOutput {
  return build_vertex(v.position, v.normal, v.model_0, v.model_1, v.model_2,
    v.normal_0, v.normal_1, v.normal_2, v.base_color, v.material, v.uv0, v.uv1,
    v.emissive_alpha, vec4f(1.0, 0.0, 0.0, 1.0));
}

@vertex fn vertex_normal_mapped(v: TangentInput) -> VertexOutput {
  return build_vertex(v.position, v.normal, v.model_0, v.model_1, v.model_2,
    v.normal_0, v.normal_1, v.normal_2, v.base_color, v.material, v.uv0, v.uv1,
    v.emissive_alpha, v.tangent);
}

@vertex fn shadow_main(v: VertexInput) -> @builtin(position) vec4f {
  let local = vec4f(v.position, 1.0);
  let world = vec3f(dot(v.model_0, local), dot(v.model_1, local), dot(v.model_2, local));
  return frame.light * vec4f(world, 1.0);
}

struct ShadowVertexOutput {
  @builtin(position) clip: vec4f,
  @location(0) uv0: vec2f,
  @location(1) uv1: vec2f,
  @location(2) alpha_cutoff: vec2f,
};

@vertex fn shadow_mask_main(v: VertexInput) -> ShadowVertexOutput {
  let local = vec4f(v.position, 1.0);
  let world = vec3f(dot(v.model_0, local), dot(v.model_1, local), dot(v.model_2, local));
  var out: ShadowVertexOutput;
  out.clip = frame.light * vec4f(world, 1.0);
  out.uv0 = v.uv0;
  out.uv1 = v.uv1;
  out.alpha_cutoff = vec2f(v.emissive_alpha.w, v.material.y);
  return out;
}

fn transformed_uv(uv0: vec2f, uv1: vec2f, row_0: vec4f, row_1: vec4f) -> vec2f {
  let value = vec3f(select(uv0, uv1, row_0.w > 1.5), 1.0);
  return vec2f(dot(row_0.xyz, value), dot(row_1.xyz, value));
}

@fragment fn shadow_mask_plain(input: ShadowVertexOutput) {
  if (input.alpha_cutoff.x < input.alpha_cutoff.y) { discard; }
}

@fragment fn shadow_mask_material(input: ShadowVertexOutput) {
  let uv = transformed_uv(input.uv0, input.uv1,
    material_textures.base_row_0, material_textures.base_row_1);
  var sampled_alpha = 1.0;
  if (material_textures.base_row_0.w > 0.5) {
    sampled_alpha = textureSample(base_color_map, base_color_sampler, uv).a;
  }
  if (input.alpha_cutoff.x * sampled_alpha < input.alpha_cutoff.y) { discard; }
}

fn flag(value: f32, bit: u32) -> bool {
  return (u32(value) & bit) != 0u;
}

fn oriented_normal(input: VertexOutput, front_facing: bool) -> vec3f {
  let gltf_front = select(!front_facing, front_facing, input.material.z > 0.0);
  let reverse = flag(input.material.w, 1u) && !gltf_front;
  return safe_normalize(
    select(input.normal, -input.normal, reverse), vec3f(0.0, 1.0, 0.0));
}

fn mapped_normal(input: VertexOutput, front_facing: bool) -> vec3f {
  let n = oriented_normal(input, front_facing);
  let source_tangent = safe_normalize(
    input.tangent.xyz - n * dot(n, input.tangent.xyz), tangent_fallback(n));
  let source_bitangent = cross(n, source_tangent) * input.tangent.w;
  let determinant = material_textures.normal_row_0.x * material_textures.normal_row_1.y
    - material_textures.normal_row_0.y * material_textures.normal_row_1.x;
  let determinant_sign = select(-1.0, 1.0, determinant >= 0.0);
  let tangent = safe_normalize((source_tangent * material_textures.normal_row_1.y
    - source_bitangent * material_textures.normal_row_1.x) * determinant_sign,
    tangent_fallback(n));
  let bitangent = cross(n, tangent) * input.tangent.w * determinant_sign;
  let uv = transformed_uv(input.uv0, input.uv1, material_textures.normal_row_0, material_textures.normal_row_1);
  let sampled = textureSample(normal_map, normal_sampler, uv).rgb * 2.0 - 1.0;
  let tangent_normal = safe_normalize(
    vec3f(sampled.xy * material_textures.normal_row_1.w, sampled.z), vec3f(0.0, 0.0, 1.0));
  return safe_normalize(
    tangent * tangent_normal.x + bitangent * tangent_normal.y + n * tangent_normal.z, n);
}

fn fresnel(cosine: f32, f0: vec3f) -> vec3f {
  return f0 + (1.0 - f0) * pow(1.0 - cosine, 5.0);
}

fn direct_brdf(n: vec3f, v: vec3f, l: vec3f, base: vec3f, metal: f32, rough: f32) -> vec3f {
  let h = safe_normalize(v + l, n);
  let nv = clamp(dot(n, v), 0.0001, 1.0); let nl = clamp(dot(n, l), 0.0, 1.0);
  let nh = clamp(dot(n, h), 0.0, 1.0); let vh = clamp(dot(v, h), 0.0, 1.0);
  let alpha = rough * rough; let alpha_2 = alpha * alpha;
  let denominator = nh * nh * (alpha_2 - 1.0) + 1.0;
  let distribution = alpha_2 / max(3.14159265 * denominator * denominator, 0.000001);
  let k = (rough + 1.0) * (rough + 1.0) / 8.0;
  let geometry = (nv / (nv * (1.0 - k) + k)) * (nl / max(nl * (1.0 - k) + k, 0.0001));
  let f = fresnel(vh, mix(vec3f(0.04), base, metal));
  let specular = distribution * geometry * f / max(4.0 * nv * nl, 0.0001);
  return ((1.0 - f) * (1.0 - metal) * base / 3.14159265 + specular) * nl;
}

@fragment fn fragment_main(
  input: VertexOutput,
  @builtin(front_facing) front_facing: bool,
) -> @location(0) vec4f {
  var base_sample = vec4f(1.0); var mr_sample = vec4f(1.0);
  var ao = 1.0; var emission = vec3f(1.0);
  if (material_textures.base_row_0.w > 0.5) {
    base_sample = textureSample(base_color_map, base_color_sampler,
      transformed_uv(input.uv0, input.uv1, material_textures.base_row_0, material_textures.base_row_1));
  }
  if (material_textures.mr_row_0.w > 0.5) {
    mr_sample = textureSample(metallic_roughness_map, metallic_roughness_sampler,
      transformed_uv(input.uv0, input.uv1, material_textures.mr_row_0, material_textures.mr_row_1));
  }
  if (material_textures.occlusion_row_0.w > 0.5) {
    let red = textureSample(occlusion_map, occlusion_sampler,
      transformed_uv(input.uv0, input.uv1, material_textures.occlusion_row_0, material_textures.occlusion_row_1)).r;
    ao = 1.0 + material_textures.occlusion_row_1.w * (red - 1.0);
  }
  if (material_textures.emissive_row_0.w > 0.5) {
    emission = textureSample(emissive_map, emissive_sampler,
      transformed_uv(input.uv0, input.uv1, material_textures.emissive_row_0, material_textures.emissive_row_1)).rgb;
  }
  let alpha = input.emissive_alpha.w * base_sample.a;
  if (flag(input.material.w, 2u) && alpha < input.material.y) { discard; }
  let base = input.base_color.rgb * base_sample.rgb;
  let metal = clamp(input.base_color.w * mr_sample.b, 0.0, 1.0);
  let rough = clamp(input.material.x * mr_sample.g, 0.06, 1.0);
  var normal = oriented_normal(input, front_facing);
  if (material_textures.normal_row_0.w > 0.5) { normal = mapped_normal(input, front_facing); }
  let view = safe_normalize(frame.eye.xyz - input.world, vec3f(0.0, 0.0, 1.0));
  let light = safe_normalize(frame.lightDirection.xyz, vec3f(0.0, 1.0, 0.0));
  let visibility = shadow_visibility(input.world, normal, max(dot(normal, light), 0.0));
  var color = direct_brdf(normal, view, light, base, metal, rough)
    * vec3f(3.2, 3.0, 2.8) * visibility;
  let nv = clamp(dot(normal, view), 0.001, 1.0);
  let f0 = mix(vec3f(0.04), base, metal);
  let f = f0 + (max(vec3f(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
  let irradiance = textureSampleLevel(
    diffuse_environment, environment_sampler, normal, 0.0).rgb;
  let ambient_occlusion = clamp(ao, 0.0, 1.0);
  color += (1.0 - f) * (1.0 - metal) * base * irradiance * ambient_occlusion;
  let reflection = safe_normalize(reflect(-view, normal), normal);
  let max_specular_lod = f32(textureNumLevels(specular_environment) - 1u);
  let radiance = textureSampleLevel(
    specular_environment, environment_sampler, reflection, rough * max_specular_lod).rgb;
  let dfg = textureSampleLevel(
    brdf_lut, environment_sampler, vec2f(nv, rough), 0.0).rg;
  let energy_compensation = vec3f(1.0)
    + f0 * (1.0 / max(dfg.x + dfg.y, 0.05) - 1.0);
  color += radiance * (f0 * dfg.x + dfg.y) * energy_compensation * ambient_occlusion;
  color += input.emissive_alpha.rgb * emission;
  return vec4f(color, select(1.0, alpha, flag(input.material.w, 4u)));
}
