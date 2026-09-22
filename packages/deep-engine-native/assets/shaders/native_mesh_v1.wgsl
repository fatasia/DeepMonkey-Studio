// Deep Engine native mesh shader contract v1.
// Bounded world-space slots share the Web/Three local attenuation and cone policy.
struct LocalLight {
  positionRange: vec4f, directionKind: vec4f, radianceOuter: vec4f, coneDecay: vec4f,
};
struct Frame {
  view: mat4x4f,
  light: mat4x4f,
  eye: vec4f,
  background: vec4f,
  floor: vec4f,
  lightDirection: vec4f,
  tuning: vec4f,
  sunColor: vec4f,
  lightingOptions: vec4f,
  localLights: array<LocalLight, 16>,
  localShadowMatrices: array<mat4x4f, 10>,
  fogProjection: vec4f,
  localShadowSoftness: array<vec4f, 4>,
};
struct MaterialTextures {
  base_row_0: vec4f, base_row_1: vec4f,
  mr_row_0: vec4f, mr_row_1: vec4f,
  occlusion_row_0: vec4f, occlusion_row_1: vec4f,
  normal_row_0: vec4f, normal_row_1: vec4f,
  emissive_row_0: vec4f, emissive_row_1: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(8) var<uniform> section_plane: vec4f;
@group(0) @binding(9) var<storage, read> iesShading: array<vec4f>;
// F3:探针 GI storage。每条记录 6 个 vec4f(96B):[0]irradiance.xyz+validity、
// [1]距离统计、[2]positionOffset.xyz、[3..5]保留零区。0..10 既有绑定不动。
@group(0) @binding(11) var<storage, read> probe_gi: array<vec4f>;
const PROBE_GI_RECORD_FLOATS: u32 = 6u;
const IES_ROW_STRIDE: u32 = 91u;
const IES_RAD_TO_DEG: f32 = 57.29577951308232;

fn ies_factor(lightIndex: u32, surfaceToLight: vec3f, lightDirection: vec3f) -> f32 {
  let params = iesShading[lightIndex];
  if (params.x < 0.0) { return 1.0; }
  let profile = iesShading[u32(params.w)];
  let toSurface = -surfaceToLight;
  let thetaHalf = clamp(round(acos(clamp(dot(toSurface, lightDirection), -1.0, 1.0))
    * IES_RAD_TO_DEG * 2.0), 0.0, 360.0);
  let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(lightDirection.y) > 0.999);
  let right = normalize(cross(up, lightDirection));
  let pole = cross(lightDirection, right);
  var phi = atan2(dot(toSurface, pole), dot(toSurface, right)) * IES_RAD_TO_DEG - params.y * 0.5;
  phi = phi - floor(phi / 360.0) * 360.0;
  var gHalf = round(phi * 2.0);
  if (gHalf >= 720.0) { gHalf = 0.0; }
  if (profile.w == 2.0 && gHalf > 360.0) { gHalf = 720.0 - gHalf; }
  if (profile.w == 4.0) { gHalf = gHalf % 360.0; if (gHalf > 180.0) { gHalf = 360.0 - gHalf; } }
  var row = 0.0;
  if (profile.w != 1.0) { row = clamp(round(gHalf / profile.z), 0.0, profile.y - 1.0); }
  let cell = iesShading[u32(profile.x) + u32(row) * IES_ROW_STRIDE + u32(thetaHalf) / 4u];
  let lane = u32(thetaHalf) % 4u;
  let value = select(cell.x, select(cell.y, select(cell.z, cell.w, lane == 3u), lane == 2u), lane == 1u);
  return value * params.z;
}
// F3 最小切片:按世界位置取最近探针的 irradiance 近似(不做三线性/等级混合)。
// 合同:producer 把探针世界位置预烘焙进 record.positionOffset(Web clipmap 的
// origin + cell*spacing 在打包时并入该字段);validity <= 0 的探针跳过。
// frame.lightDirection.w 是保留开关通道:0 = 关(旧包默认),直接返回零,
// 逐位保持既有光照结果;无有效探针同样返回零。逐记录线性扫描只服务当前
// 最小切片,网格加速与三线性留给 producer 接入后的后续切片。
fn probe_gi_nearest_irradiance(world: vec3f) -> vec3f {
  let record_count = arrayLength(&probe_gi) / PROBE_GI_RECORD_FLOATS;
  var best_distance_squared = -1.0;
  var best_base = 0u;
  for (var index = 0u; index < record_count; index = index + 1u) {
    let base = index * PROBE_GI_RECORD_FLOATS;
    if (probe_gi[base].w <= 0.0) { continue; }
    let offset = probe_gi[base + 2u].xyz;
    let distance_squared = dot(offset - world, offset - world);
    if (best_distance_squared < 0.0 || distance_squared < best_distance_squared) {
      best_distance_squared = distance_squared;
      best_base = base;
    }
  }
  if (best_distance_squared < 0.0) { return vec3f(0.0); }
  return probe_gi[best_base].xyz;
}
// F3 网格三线性模式:record 0 是网格头(origin/spacing、gridSize、
// maxPosition/probeCount),探针从 record 1 开始,线性下标
// (z*gridY + y)*gridX + x。该模式 positionOffset 语义是重定位增量
// (探针世界位置 = origin + cell*spacing + offset),与 Web storage-record
// 路径一致;最近探针模式仍把 positionOffset 当预烘焙世界位置,两模式不同。
// 数学逐式对齐 Web sampleIrradianceProbeClipmap 单层路径:三线性 × validity
// × Chebyshev × 法线权重(pow(cos,3));半球判断用原始着色点,0.2 格法线
// 偏移只进可见性测试。头/世界位置/记录数任一非法一律返回零(fail-closed)。
fn probe_gi_grid_trilinear(world: vec3f, normal: vec3f) -> vec3f {
  let origin = probe_gi[0u].xyz;
  let spacing = probe_gi[0u].w;
  let grid_size_f = probe_gi[1u].xyz;
  let base_records = probe_gi[1u].w;
  let max_position = probe_gi[2u].xyz;
  let probe_count_f = probe_gi[2u].w;
  if (!(spacing > 0.0 && spacing <= 1000000.0)) { return vec3f(0.0); }
  if (!all(grid_size_f == floor(grid_size_f)) || !(all(grid_size_f >= vec3f(2.0)) && all(grid_size_f <= vec3f(64.0)))) { return vec3f(0.0); }
  let grid_size = vec3u(grid_size_f);
  if (probe_count_f != f32(grid_size.x * grid_size.y * grid_size.z)) { return vec3f(0.0); }
  if (!(base_records == 1.0) || !all(world >= origin) || !all(world <= max_position)) { return vec3f(0.0); }
  let record_count = arrayLength(&probe_gi) / PROBE_GI_RECORD_FLOATS;
  if (record_count < 1u + u32(probe_count_f)) { return vec3f(0.0); }
  let normal_length = length(normal);
  let n = select(vec3f(0.0, 1.0, 0.0), normal / max(normal_length, 0.000001),
    normal_length > 0.000001);
  let receiver = world + n * spacing * 0.2;
  let coordinate = clamp((world - origin) / spacing, vec3f(0.0), vec3f(grid_size - vec3u(1u)));
  let low = min(vec3u(floor(coordinate)), grid_size - vec3u(2u));
  let fraction = clamp(coordinate - vec3f(low), vec3f(0.0), vec3f(1.0));
  var sum = vec3f(0.0);
  var total_weight = 0.0;
  for (var corner = 0u; corner < 8u; corner = corner + 1u) {
    let bits = vec3u(corner & 1u, (corner >> 1u) & 1u, (corner >> 2u) & 1u);
    let cell = low + bits;
    let axis_weight = mix(vec3f(1.0) - fraction, fraction, vec3f(bits));
    let trilinear = axis_weight.x * axis_weight.y * axis_weight.z;
    if (!(trilinear > 0.0)) { continue; }
    let linear = (cell.z * grid_size.y + cell.y) * grid_size.x + cell.x;
    let base = (1u + linear) * PROBE_GI_RECORD_FLOATS;
    let validity = clamp(probe_gi[base].w, 0.0, 1.0);
    if (!(validity > 0.0)) { continue; }
    let probe_position = origin + vec3f(cell) * spacing + probe_gi[base + 2u].xyz;
    let distance = length(receiver - probe_position);
    let mean_distance = clamp(probe_gi[base + 1u].x, 0.0, 1000000.0);
    var visibility = 1.0;
    if (distance > mean_distance) {
      let variance = clamp(probe_gi[base + 1u].y, spacing * spacing * 0.0001, 1000000000000.0);
      let delta = distance - mean_distance;
      visibility = max(clamp(probe_gi[base + 1u].z, 0.0, 1.0),
        variance / max(variance + delta * delta, 0.000001));
    }
    let to_probe = probe_position - world;
    let length_to_probe = length(to_probe);
    var normal_weight = 1.0;
    if (length_to_probe > 0.000001) {
      let cosine = dot(to_probe, n) / length_to_probe;
      normal_weight = select(0.0, pow(cosine, 3.0), cosine > 0.0);
    }
    let weight = trilinear * validity * visibility * normal_weight;
    sum = sum + max(probe_gi[base].xyz, vec3f(0.0)) * weight;
    total_weight = total_weight + weight;
  }
  if (total_weight < 0.001) { return vec3f(0.0); }
  return clamp(sum / total_weight, vec3f(0.0), vec3f(65504.0));
}
// frame.lightDirection.w 开关通道:0 = 关(旧包默认,逐位不变),
// 1 = 最近探针扁平扫描,<1.5 走该路径;>=1.5 = 网格三线性模式。
fn probe_gi_irradiance(world: vec3f, normal: vec3f) -> vec3f {
  let mode = frame.lightDirection.w;
  if (mode <= 0.0) { return vec3f(0.0); }
  if (mode >= 1.5) { return probe_gi_grid_trilinear(world, normal); }
  return probe_gi_nearest_irradiance(world);
}
fn section_rejected(world: vec3f) -> bool {
  return dot(section_plane.xyz, world) + section_plane.w < 0.0;
}
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
  @location(6) @interpolate(flat) material: vec4f,
  @location(7) emissive_alpha: vec4f,
  @location(8) @interpolate(flat) dielectric: f32,
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
  out.emissive_alpha = emissive_alpha; out.dielectric = dielectric_f0(normal_0.w);
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
  @location(3) world: vec3f,
};

@vertex fn shadow_mask_main(v: VertexInput) -> ShadowVertexOutput {
  let local = vec4f(v.position, 1.0);
  let world = vec3f(dot(v.model_0, local), dot(v.model_1, local), dot(v.model_2, local));
  var out: ShadowVertexOutput;
  out.clip = frame.light * vec4f(world, 1.0);
  out.uv0 = v.uv0;
  out.uv1 = v.uv1;
  out.alpha_cutoff = vec2f(v.emissive_alpha.w, v.material.y);
  out.world = world;
  return out;
}

fn transformed_uv(uv0: vec2f, uv1: vec2f, row_0: vec4f, row_1: vec4f) -> vec2f {
  let value = vec3f(select(uv0, uv1, row_0.w > 1.5), 1.0);
  return vec2f(dot(row_0.xyz, value), dot(row_1.xyz, value));
}

@fragment fn shadow_mask_plain(input: ShadowVertexOutput) {
  if (section_rejected(input.world)) { discard; }
  if (input.alpha_cutoff.x < input.alpha_cutoff.y) { discard; }
}

@fragment fn shadow_mask_material(input: ShadowVertexOutput) {
  if (section_rejected(input.world)) { discard; }
  let uv = transformed_uv(input.uv0, input.uv1,
    material_textures.base_row_0, material_textures.base_row_1);
  var sampled_alpha = 1.0;
  if (material_textures.base_row_0.w > 0.5) {
    sampled_alpha = textureSample(base_color_map, base_color_sampler, uv).a;
  }
  if (input.alpha_cutoff.x * sampled_alpha < input.alpha_cutoff.y) { discard; }
}

@fragment fn shadow_section(input: ShadowVertexOutput) {
  if (section_rejected(input.world)) { discard; }
}

fn local_direct_lighting(world: vec3f, normal: vec3f, view: vec3f, base: vec3f, metal: f32, rough: f32, receiveShadow: bool, ao: f32, dielectric: f32) -> vec3f {
  var color = vec3f(0.0);
  for (var index = 0u; index < min(u32(frame.lightingOptions.z), 16u); index++) {
    let source = frame.localLights[index];
    if (source.directionKind.w == 4.0) {
      let weight = dot(normal, source.directionKind.xyz) * 0.5 + 0.5;
      let irradiance = mix(source.positionRange.xyz, source.radianceOuter.rgb, weight);
      color += irradiance * base * (1.0 - metal) * clamp(ao, 0.0, 1.0) / 3.141592653589793;
      continue;
    }
    var direction = source.directionKind.xyz;
    var attenuation = 1.0;
    if (source.directionKind.w >= 2.0) {
      let toLight = source.positionRange.xyz - world;
      let distanceSquared = dot(toLight, toLight);
      let distance = sqrt(distanceSquared);
      direction = safe_normalize(toLight, normal);
      // Three lights_pars_begin: inverse-power falloff and smooth finite cutoff.
      attenuation = 1.0 / max(pow(max(distance, 0.00000001), source.coneDecay.y), 0.01);
      if (source.positionRange.w > 0.0) {
        let ratio = distance / source.positionRange.w;
        let window = max(1.0 - ratio * ratio * ratio * ratio, 0.0);
        attenuation *= window * window;
      }
      if (source.directionKind.w == 3.0) {
        let cosine = dot(-direction, source.directionKind.xyz);
        let outer = source.radianceOuter.w;
        let inner = source.coneDecay.x;
        var coneWeight = select(0.0, 1.0, cosine >= outer);
        if (inner > outer) { coneWeight = clamp((cosine - outer) / (inner - outer), 0.0, 1.0); }
        attenuation *= coneWeight * coneWeight * (3.0 - 2.0 * coneWeight)
          * ies_factor(index, direction, source.directionKind.xyz);
      }
    }
    var visibility = 1.0;
    if (receiveShadow && source.coneDecay.z > 0.0) {
      var shadowIndex = u32(source.coneDecay.z)-1u;
      if (source.directionKind.w == 2.0) { shadowIndex += point_shadow_face(world-source.positionRange.xyz); }
      visibility = local_spot_visibility(shadowIndex, source.coneDecay.w, world, max(dot(normal,direction),0.0), frame.localShadowSoftness[index / 4u][index % 4u]);
    }
    color += direct_brdf_f0(normal, view, direction, base, metal, rough, dielectric) * source.radianceOuter.rgb * attenuation * visibility;
  }
  return color;
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

fn dielectric_f0(encoded_ior: f32) -> f32 {
  if (encoded_ior == 0.0 || encoded_ior == 1.5) { return 0.04; }
  let reflectance = 1.0 - 2.0 / (encoded_ior + 1.0);
  return reflectance * reflectance;
}
fn fresnel(cosine: f32, f0: vec3f) -> vec3f {
  let factor = exp2((-5.55473 * cosine - 6.98316) * cosine);
  return f0 * (1.0 - factor) + factor;
}

fn direct_brdf_f0(n: vec3f, v: vec3f, l: vec3f, base: vec3f, metal: f32, rough: f32, dielectric: f32) -> vec3f {
  let h = safe_normalize(v + l, n);
  let nv = clamp(dot(n, v), 0.0001, 1.0); let nl = clamp(dot(n, l), 0.0, 1.0);
  let nh = clamp(dot(n, h), 0.0, 1.0); let vh = clamp(dot(v, h), 0.0, 1.0);
  let alpha = rough * rough; let alpha_2 = alpha * alpha;
  let denominator = nh * nh * (alpha_2 - 1.0) + 1.0;
  let distribution = alpha_2 / max(3.14159265 * denominator * denominator, 0.000001);
  let gv = nl * sqrt(alpha_2 + (1.0 - alpha_2) * nv * nv);
  let gl = nv * sqrt(alpha_2 + (1.0 - alpha_2) * nl * nl);
  let visibility = 0.5 / max(gv + gl, 0.000001);
  let f = fresnel(vh, mix(vec3f(dielectric), base, metal));
  let specular = distribution * visibility * f;
  let diffuse = (1.0 - metal) * base / 3.14159265;
  return (diffuse + specular) * nl;
}

@fragment fn fragment_main(
  input: VertexOutput,
  @builtin(front_facing) front_facing: bool,
) -> @location(0) vec4f {
  if (section_rejected(input.world)) { discard; }
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
  let rough = clamp(input.material.x * mr_sample.g, 0.045, 1.0);
  var normal = oriented_normal(input, front_facing);
  if (material_textures.normal_row_0.w > 0.5) { normal = mapped_normal(input, front_facing); }
  let view = safe_normalize(frame.eye.xyz - input.world, vec3f(0.0, 0.0, 1.0));
  let light = safe_normalize(frame.lightDirection.xyz, vec3f(0.0, 1.0, 0.0));
  let authored_light = frame.sunColor.w >= 2.0;
  let visibility = select(shadow_visibility(input.world, normal, max(dot(normal, light), 0.0)),
    1.0, flag(input.material.w, 16u) || (authored_light && frame.lightingOptions.y == 0.0));
  let sun = select(vec3f(3.2, 3.0, 2.8), frame.sunColor.rgb, authored_light);
  let dielectric = input.dielectric;
  var color = direct_brdf_f0(normal, view, light, base, metal, rough, dielectric)
    * sun * visibility;
  if (frame.sunColor.w == 3.0) {
    color += local_direct_lighting(input.world, normal, view, base, metal, rough, !flag(input.material.w,16u), ao, dielectric);
  }
  if (frame.background.w > 0.5) {
    // Zero is the legacy/default value; authored GI uses the reserved
    // fog-projection W lane without changing the frame ABI size.
    let global_illumination = select(1.0, frame.fogProjection.w, frame.fogProjection.w > 0.0);
    let nv = clamp(dot(normal, view), 0.001, 1.0);
    let f0 = mix(vec3f(dielectric), base, metal);
    let f = f0 + (max(vec3f(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
    let irradiance = textureSampleLevel(
      diffuse_environment, environment_sampler, normal, 0.0).rgb;
    let ambient_occlusion = clamp(ao, 0.0, 1.0);
    color += (1.0 - f) * (1.0 - metal) * base * irradiance * ambient_occlusion * global_illumination;
    // F3:探针 GI 作为环境漫射的近场补偿叠加进 ambient;开关为 0 时
    // probe_gi_irradiance 返回零,加零不改既有结果。
    let probe_irradiance = probe_gi_irradiance(input.world, normal);
    color += base * (1.0 - metal) * probe_irradiance * ambient_occlusion / 3.141592653589793;
    let reflection = safe_normalize(reflect(-view, normal), normal);
    let max_specular_lod = f32(textureNumLevels(specular_environment) - 1u);
    let radiance = textureSampleLevel(
      specular_environment, environment_sampler, reflection, rough * max_specular_lod).rgb;
    let dfg = textureSampleLevel(
      brdf_lut, environment_sampler, vec2f(nv, rough), 0.0).rg;
    let energy_compensation = vec3f(1.0)
      + f0 * (1.0 / max(dfg.x + dfg.y, 0.05) - 1.0);
    color += radiance * (f0 * dfg.x + dfg.y) * energy_compensation * ambient_occlusion * global_illumination;
  }
  color += input.emissive_alpha.rgb * emission;
  let exposure = select(1.0, frame.lightingOptions.x, authored_light);
  var surface_color = select(color, base, flag(input.material.w, 64u));
  if (frame.fogProjection.z == 2.0) {
    // clip W is signed camera-space depth; no radial-distance or fixed near/far approximation.
    let camera_depth = max((frame.view * vec4f(input.world, 1.0)).w, 0.0);
    let optical_depth = frame.tuning.w * camera_depth;
    let amount = clamp(1.0 - exp(-optical_depth * optical_depth), 0.0, 1.0);
    surface_color = mix(surface_color, frame.tuning.rgb, amount);
  }
  let output_alpha = select(1.0, alpha, flag(input.material.w, 4u));
  return vec4f(surface_color * exposure, output_alpha);
}

@fragment fn outline_mask_fragment(input: VertexOutput) -> @location(0) vec4f {
  if (!flag(input.material.w, 256u) || section_rejected(input.world)) { discard; }
  var sampled_alpha = 1.0;
  if (material_textures.base_row_0.w > 0.5) {
    sampled_alpha = textureSample(base_color_map, base_color_sampler,
      transformed_uv(input.uv0, input.uv1, material_textures.base_row_0, material_textures.base_row_1)).a;
  }
  let alpha = input.emissive_alpha.w * sampled_alpha;
  if (alpha <= 0.001) { discard; }
  if (flag(input.material.w, 2u) && alpha < input.material.y) { discard; }
  let coverage = select(1.0, alpha, flag(input.material.w, 4u));
  return vec4f(coverage, 0.0, 0.0, 1.0);
}
