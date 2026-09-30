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
  localShadowMatrices: array<mat4x4f, 16>,
  fogProjection: vec4f,
  localShadowSoftness: array<vec4f, 4>,
  fogProfile: vec4f,
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
@group(0) @binding(9) var<storage, read> deepIesShading: array<vec4f>;
// F3:探针 GI storage。每条记录 6 个 vec4f(96B):[0]irradiance.xyz+validity、
// [1]距离统计、[2]positionOffset.xyz、[3..5]保留零区。0..10 既有绑定不动。
@group(0) @binding(11) var<storage, read> probe_gi: array<vec4f>;
// Cluster storage ABI v1 is resident for every Native frame. Invalid or empty
// plans fall back to the legacy authored-light order without changing output.
@group(0) @binding(12) var<storage, read> cluster_grid: array<u32>;
// J2-B1 单源:IES 光域网采样库(deepSpotIesFactor)与直射 BRDF/介电 F0 库由
// frame_bindings 经 include_str! 拼接自 packages/deep-engine/wgsl/ 三份真源;
// 本体只保留宿主 binding 声明(9 号行距 91 的 vec4 展开表,与 web E02 布局同构)。
const PROBE_GI_RECORD_FLOATS: u32 = 6u;
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
// F3 网格三线性模式(单层旧合同):record 0 是网格头(origin/spacing、gridSize、
// maxPosition/probeCount),探针从 record 1 开始,线性下标
// (z*gridY + y)*gridX + x。该模式 positionOffset 语义是重定位增量
// (探针世界位置 = origin + cell*spacing + offset),与 Web storage-record
// 路径一致;最近探针模式仍把 positionOffset 当预烘焙世界位置,两模式不同。
//
// F3 v2 多层级联:record 0 是布局头——主 12 字全零,保留区 word12=版本 2.0、
// word13=levelCount(1..4,细→粗)、word14=levels 起始记录号(恒 1)、word15 及
// 其余保留字全零;随后每层一个网格头(原格式,保留区全零)+该层探针记录按层
// 顺序排布。层头 baseProbeRecords = 本层首条探针记录号(布局头 + 前面所有层
// 全部记录 + 本层网格头;旧单层恒 1)。层间合同:粗层 spacing 严格更大、粗层
// 范围逐轴包含细层范围;记录流必须恰好排布完声明的层数。
//
// 采样数学逐式对齐 Web sampleIrradianceProbeClipmap 与 CPU 参考
// sample_probe_grid_irradiance:单层 = 三线性 × validity × Chebyshev × 法线
// 权重(pow(cos,3)),半球判断用原始着色点,0.2 格法线偏移只进可见性测试;
// 级联 = 细层优先,仅紧随的次粗层参与混合(Web MAX_LEVEL_SAMPLE_COUNT=2),
// 两层权重都足够时按 1-smoothstep(0,1.5,细层边界格距) 混合,混合公式与
// Web mix3 同式(fine + (coarse-fine)*blend);细层权重不足而粗层足够时单独
// 用粗层。头/世界位置/法线/记录流任一非法一律返回零(fail-closed;
// 非有限法线不再回退到 +y 采样,与 CPU 参考一致直接返零)。
const PROBE_GI_GRID_LAYOUT_VERSION: f32 = 2.0;
const PROBE_GI_GRID_MAX_LEVELS: u32 = 4u;
const PROBE_GI_CASCADE_BLEND_CELLS: f32 = 1.5;
struct ProbeGiLevel {
  origin: vec3f,
  spacing: f32,
  grid_size: vec3u,
  base_records: u32,
  probe_count: u32,
  valid: u32,
};
struct ProbeGiLevelSample {
  irradiance: vec3f,
  weight: f32,
};
fn probe_gi_grid_invalid_level() -> ProbeGiLevel {
  return ProbeGiLevel(vec3f(0.0), 0.0, vec3u(0u), 0u, 0u, 0u);
}
// 解码一个层级网格头:保留区必须全零、baseProbeRecords 必须指向本层首条
// 探针、maxPosition 必须 = origin + gridSize*spacing,且本层全部记录必须
// 落在 storage 内;任一违反返回 valid=0(调用方 fail-closed 返零)。
fn probe_gi_grid_level_header(header_record: u32, record_count: u32) -> ProbeGiLevel {
  if (header_record >= record_count) { return probe_gi_grid_invalid_level(); }
  let base = header_record * PROBE_GI_RECORD_FLOATS;
  let origin = probe_gi[base].xyz;
  let spacing = probe_gi[base].w;
  let grid_size_f = probe_gi[base + 1u].xyz;
  let base_records_f = probe_gi[base + 1u].w;
  let max_position = probe_gi[base + 2u].xyz;
  let probe_count_f = probe_gi[base + 2u].w;
  // 层级网格头不得占用保留区(保留区只归 record 0 布局头使用)。
  if (!(all(probe_gi[base + 3u] == vec4f(0.0)) && all(probe_gi[base + 4u] == vec4f(0.0))
    && all(probe_gi[base + 5u] == vec4f(0.0)))) { return probe_gi_grid_invalid_level(); }
  if (!(spacing > 0.0 && spacing <= 1000000.0)) { return probe_gi_grid_invalid_level(); }
  if (!all(grid_size_f == floor(grid_size_f)) || !(all(grid_size_f >= vec3f(2.0)) && all(grid_size_f <= vec3f(64.0)))) { return probe_gi_grid_invalid_level(); }
  let grid_size = vec3u(grid_size_f);
  if (probe_count_f != f32(grid_size.x * grid_size.y * grid_size.z)) { return probe_gi_grid_invalid_level(); }
  if (!(base_records_f == floor(base_records_f))) { return probe_gi_grid_invalid_level(); }
  let base_records = u32(base_records_f);
  let probe_count = u32(probe_count_f);
  if (base_records != header_record + 1u) { return probe_gi_grid_invalid_level(); }
  if (any(max_position != origin + vec3f(grid_size) * spacing)) { return probe_gi_grid_invalid_level(); }
  if (header_record + 1u + probe_count > record_count) { return probe_gi_grid_invalid_level(); }
  return ProbeGiLevel(origin, spacing, grid_size, base_records, probe_count, 1u);
}
fn probe_gi_grid_contains(level: ProbeGiLevel, world: vec3f) -> bool {
  let max_position = level.origin + vec3f(level.grid_size) * level.spacing;
  return level.valid == 1u && all(world >= level.origin) && all(world <= max_position);
}
// 与 CPU sample_grid_level 逐式一致:三线性 × validity × Chebyshev × 法线权重,
// 权重归一后返回;累计权重不足 MIN 返回零值零权重。
fn probe_gi_grid_sample_level(level: ProbeGiLevel, world: vec3f, n: vec3f) -> ProbeGiLevelSample {
  if (level.valid == 0u) { return ProbeGiLevelSample(vec3f(0.0), 0.0); }
  let spacing = level.spacing;
  let receiver = world + n * spacing * 0.2;
  let coordinate = clamp((world - level.origin) / spacing, vec3f(0.0), vec3f(level.grid_size - vec3u(1u)));
  let low = min(vec3u(floor(coordinate)), level.grid_size - vec3u(2u));
  let fraction = clamp(coordinate - vec3f(low), vec3f(0.0), vec3f(1.0));
  var sum = vec3f(0.0);
  var total_weight = 0.0;
  for (var corner = 0u; corner < 8u; corner = corner + 1u) {
    let bits = vec3u(corner & 1u, (corner >> 1u) & 1u, (corner >> 2u) & 1u);
    let cell = low + bits;
    let axis_weight = mix(vec3f(1.0) - fraction, fraction, vec3f(bits));
    let trilinear = axis_weight.x * axis_weight.y * axis_weight.z;
    if (!(trilinear > 0.0)) { continue; }
    let linear = (cell.z * level.grid_size.y + cell.y) * level.grid_size.x + cell.x;
    let base = (level.base_records + linear) * PROBE_GI_RECORD_FLOATS;
    let validity = clamp(probe_gi[base].w, 0.0, 1.0);
    if (!(validity > 0.0)) { continue; }
    let probe_position = level.origin + vec3f(cell) * spacing + probe_gi[base + 2u].xyz;
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
  if (total_weight < 0.001) { return ProbeGiLevelSample(vec3f(0.0), 0.0); }
  return ProbeGiLevelSample(clamp(sum / total_weight, vec3f(0.0), vec3f(65504.0)), total_weight);
}
// 与 Web boundaryCells 同式:采样点到本层最近边界的距离(格)。
fn probe_gi_grid_boundary_cells(level: ProbeGiLevel, world: vec3f) -> f32 {
  let coordinate = (world - level.origin) / level.spacing;
  let edge = min(coordinate, vec3f(level.grid_size - vec3u(1u)) - coordinate);
  return min(edge.x, min(edge.y, edge.z));
}
fn probe_gi_grid_trilinear(world: vec3f, normal: vec3f) -> vec3f {
  let record_count = arrayLength(&probe_gi) / PROBE_GI_RECORD_FLOATS;
  if (record_count < 2u) { return vec3f(0.0); }
  // record 0 分派:保留区全零 = 旧单层(record 0 即唯一层网格头,合同逐位不变);
  // 否则必须是 v2 布局头(主 12 字全零,保留区 [版本,层数,levels 起始,0...])。
  let layout_words = probe_gi[3u];
  let reserved_rest_zero = all(probe_gi[4u] == vec4f(0.0)) && all(probe_gi[5u] == vec4f(0.0));
  var level_count = 1u;
  var first_header = 0u;
  if (all(layout_words == vec4f(0.0)) && reserved_rest_zero) {
    // 旧单层。
  } else if (layout_words.x == PROBE_GI_GRID_LAYOUT_VERSION && reserved_rest_zero) {
    if (!(layout_words.y == floor(layout_words.y)) || layout_words.y < 1.0
      || layout_words.y > 4.0 || layout_words.z != 1.0 || layout_words.w != 0.0) {
      return vec3f(0.0);
    }
    level_count = u32(layout_words.y);
    first_header = u32(layout_words.z);
  } else {
    return vec3f(0.0);
  }
  // 逐层解码:层头顺序排布,粗层 spacing 严格更大且范围逐轴包含细层。
  var headers: array<ProbeGiLevel, PROBE_GI_GRID_MAX_LEVELS>;
  var cursor = first_header;
  var selected = level_count;
  for (var index = 0u; index < level_count; index = index + 1u) {
    let level = probe_gi_grid_level_header(cursor, record_count);
    if (level.valid == 0u) { return vec3f(0.0); }
    if (index > 0u) {
      let fine = headers[index - 1u];
      let fine_max = fine.origin + vec3f(fine.grid_size) * fine.spacing;
      let coarse_max = level.origin + vec3f(level.grid_size) * level.spacing;
      if (!(level.spacing > fine.spacing) || any(level.origin > fine.origin)
        || any(coarse_max < fine_max)) {
        return vec3f(0.0);
      }
    }
    headers[index] = level;
    if (selected == level_count && probe_gi_grid_contains(level, world)) { selected = index; }
    cursor = cursor + 1u + level.probe_count;
  }
  // 记录流必须恰好排布完声明的层级(无尾随/缺失,与 CPU 合同一致)。
  if (cursor != record_count) { return vec3f(0.0); }
  if (selected == level_count) { return vec3f(0.0); }
  if (!all(world == world) || !all(abs(world) <= vec3f(1000000000.0))) { return vec3f(0.0); }
  if (!all(normal == normal) || !all(abs(normal) <= vec3f(1000000.0))) { return vec3f(0.0); }
  let normal_length = length(normal);
  let n = select(vec3f(0.0, 1.0, 0.0), normal / max(normal_length, 0.000001),
    normal_length > 0.000001);
  let fine = probe_gi_grid_sample_level(headers[selected], world, n);
  // 级联混合只看紧随的次粗层,且要求该层也包含采样点。
  if (selected + 1u < level_count && probe_gi_grid_contains(headers[selected + 1u], world)) {
    let coarse = probe_gi_grid_sample_level(headers[selected + 1u], world, n);
    if (fine.weight >= 0.001 && coarse.weight >= 0.001) {
      let blend = 1.0 - smoothstep(0.0, PROBE_GI_CASCADE_BLEND_CELLS,
        probe_gi_grid_boundary_cells(headers[selected], world));
      return fine.irradiance + (coarse.irradiance - fine.irradiance) * blend;
    }
    if (coarse.weight >= 0.001) { return coarse.irradiance; }
  }
  if (fine.weight >= 0.001) { return fine.irradiance; }
  return vec3f(0.0);
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
  out.emissive_alpha = emissive_alpha; out.dielectric = deepDielectricF0(normal_0.w);
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

// Primary light compensation uses the existing host DFG; sampling stays outside the shared kernel.
fn native_direct_multiscattering(normal: vec3f, light: vec3f, base: vec3f,
  metal: f32, rough: f32, dielectric: f32, dfg_view: vec2f) -> vec3f {
  let nl = clamp(dot(normal, light), 0.0, 1.0);
  if (nl <= 0.0) { return vec3f(0.0); }
  let dfg_light = textureSampleLevel(brdf_lut, environment_sampler, vec2f(nl, rough), 0.0).rg;
  return deepDirectMultiscatteringEnergy(mix(vec3f(dielectric), base, metal), dfg_view, dfg_light) * nl;
}

fn local_direct_lighting(world: vec3f, normal: vec3f, view: vec3f, base: vec3f, metal: f32, rough: f32, receiveShadow: bool, ao: f32, dielectric: f32, screen: vec4f, dfg_view_input: vec2f, dfg_ready_input: bool) -> vec3f {
  var color = vec3f(0.0);
  var dfg_view = dfg_view_input;
  var dfg_ready = dfg_ready_input;
  let cluster_valid = cluster_grid[0u] == 1u && cluster_grid[1u] == 64u && cluster_grid[2u] == 16u;
  let ndc = screen.xy / max(screen.w, 0.00001);
  let tile_x = min(u32(clamp(ndc.x * 0.5 + 0.5, 0.0, 0.999999) * 8.0), 7u);
  let tile_y = min(u32(clamp(0.5 - ndc.y * 0.5, 0.0, 0.999999) * 8.0), 7u);
  let tile_base = 4u + (tile_y * 8u + tile_x) * 17u;
  var light_count = min(u32(frame.lightingOptions.z), 16u);
  if (cluster_valid) { light_count = min(cluster_grid[tile_base], 16u); }
  for (var slot = 0u; slot < 16u; slot++) {
    if (slot >= light_count) { break; }
    let index = select(slot, cluster_grid[tile_base + 1u + slot], cluster_valid);
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
          * deepSpotIesFactor(index, direction, source.directionKind.xyz);
      }
    }
    var visibility = 1.0;
    if (receiveShadow && source.coneDecay.z > 0.0) {
      var shadowIndex = u32(source.coneDecay.z)-1u;
      if (source.directionKind.w == 2.0) { shadowIndex += point_shadow_face(world-source.positionRange.xyz); }
      visibility = local_spot_visibility(shadowIndex, source.coneDecay.w, world, max(dot(normal,direction),0.0), frame.localShadowSoftness[index / 4u][index % 4u]);
    }
    color += brdfWithDielectricF0(normal, view, direction, base, metal, rough, dielectric) * source.radianceOuter.rgb * attenuation * visibility;
    if (dot(normal, direction) > 0.0 && any(source.radianceOuter.rgb > vec3f(0.0)) && attenuation > 0.0 && visibility > 0.0) {
      if (!dfg_ready) {
        let local_nv = clamp(dot(normal, view), 0.001, 1.0);
        dfg_view = textureSampleLevel(brdf_lut, environment_sampler, vec2f(local_nv, rough), 0.0).rg;
        dfg_ready = true;
      }
      color += native_direct_multiscattering(normal, direction, base, metal, rough, dielectric, dfg_view)
        * source.radianceOuter.rgb * attenuation * visibility;
    }
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

// Restore the rigid camera basis from perspective VP without projection or jitter scaling.
fn native_view_geometry_roughness(geometry_normal: vec3f) -> f32 {
  let forward = safe_normalize(vec3f(frame.view[0].w, frame.view[1].w, frame.view[2].w), vec3f(0.0, 0.0, -1.0));
  let horizontal = vec3f(frame.view[0].x, frame.view[1].x, frame.view[2].x);
  let right = safe_normalize(horizontal - forward * dot(horizontal, forward), vec3f(1.0, 0.0, 0.0));
  let up = safe_normalize(cross(right, forward), vec3f(0.0, 1.0, 0.0));
  let view_normal = vec3f(dot(right, geometry_normal), dot(up, geometry_normal), -dot(forward, geometry_normal));
  return deepGeometryRoughness(view_normal);
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
// J2-B1 单源适配:拼入的直射 BRDF 库以 safeNormalize 取安全归一,此处复用同名语义的
// snake_case safe_normalize 本体(逐式等价,无数值差)。
fn safeNormalize(value: vec3f, fallback: vec3f) -> vec3f {
  return safe_normalize(value, fallback);
}

struct NativeMeshSurface { color: vec4f, normalRoughness: vec4f };
struct NativeMeshCapture {
  @location(0) color: vec4f,
  @location(1) normalRoughness: vec4f,
};

fn shade_native_mesh(
  input: VertexOutput,
  front_facing: bool,
) -> NativeMeshSurface {
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
  let geometry_normal = oriented_normal(input, front_facing);
  let rough = min(1.0, clamp(input.material.x * mr_sample.g, 0.045, 1.0) + native_view_geometry_roughness(geometry_normal));
  var normal = geometry_normal;
  if (material_textures.normal_row_0.w > 0.5) { normal = mapped_normal(input, front_facing); }
  let view = safe_normalize(frame.eye.xyz - input.world, vec3f(0.0, 0.0, 1.0));
  let light = safe_normalize(frame.lightDirection.xyz, vec3f(0.0, 1.0, 0.0));
  let authored_light = frame.sunColor.w >= 2.0;
  let visibility = select(shadow_visibility(input.world, normal, max(dot(normal, light), 0.0)),
    1.0, flag(input.material.w, 16u) || (authored_light && frame.lightingOptions.y == 0.0));
  let sun = select(vec3f(3.2, 3.0, 2.8), frame.sunColor.rgb, authored_light);
  let dielectric = input.dielectric;
  var color = brdfWithDielectricF0(normal, view, light, base, metal, rough, dielectric)
    * sun * visibility;
  let nv = clamp(dot(normal, view), 0.001, 1.0);
  var dfg = vec2f(0.0);
  let direct_lit = dot(normal, light) > 0.0 && any(sun > vec3f(0.0));
  if (frame.background.w > 0.5 || direct_lit) {
    dfg = textureSampleLevel(brdf_lut, environment_sampler, vec2f(nv, rough), 0.0).rg;
  }
  if (direct_lit) {
    color += native_direct_multiscattering(normal, light, base, metal, rough, dielectric, dfg) * sun * visibility;
  }
  if (frame.sunColor.w == 3.0) {
    color += local_direct_lighting(input.world, normal, view, base, metal, rough, !flag(input.material.w,16u), ao, dielectric, input.clip, dfg, frame.background.w > 0.5 || direct_lit);
  }
  if (frame.background.w > 0.5) {
    // Zero is the legacy/default value; authored GI uses the reserved
    // fog-projection W lane without changing the frame ABI size.
    let global_illumination = select(1.0, frame.fogProjection.w, frame.fogProjection.w > 0.0);
    // J2-B3 白炉修复(与 web pbrShader.ts C12 修复式逐式对齐):IBL 漫反射/高光
    // 的能量分配必须用同一 split-sum 分数。原实现把漫反射储备定在镜面 Schlick
    // (rough→1 时坍缩为 1−f0),而高光实际交付 LUT 分数(rough→1 时
    // f0·dfg.x+dfg.y ≈ 0.0135),白粗糙面总出射 ≈0.9735E → 白炉欠冲
    // (native 真机实测:墙腿 mean −2.566% / max −2.588%,与 web C12 的 −2.637%
    // 同量级)。修复后 total = (1−fraction) + fraction ≡ 1,对任意 f0/rough/nv
    // 构造性守恒;金属路径(漫反射为 0)与镜面极限(fraction→f0)逐位不变。
    // 逐字锁定断言:deep_engine_native::white_furnace
    // ::native_mesh_ibl_split_keeps_ts_authoritative_formula。
    let f0 = mix(vec3f(dielectric), base, metal);
    let energy_compensation = vec3f(1.0)
      + f0 * (1.0 / max(dfg.x + dfg.y, 0.05) - 1.0);
    let specular_fraction = clamp(f0 * dfg.x + dfg.y, vec3f(0.0), vec3f(1.0)) * energy_compensation;
    let irradiance = textureSampleLevel(
      diffuse_environment, environment_sampler, normal, 0.0).rgb;
    let ambient_occlusion = clamp(ao, 0.0, 1.0);
    color += (1.0 - specular_fraction) * (1.0 - metal) * base * irradiance * ambient_occlusion * global_illumination;
    // F3:探针 GI 作为环境漫射的近场补偿叠加进 ambient;开关为 0 时
    // probe_gi_irradiance 返回零,加零不改既有结果。
    let probe_irradiance = probe_gi_irradiance(input.world, normal);
    color += base * (1.0 - metal) * probe_irradiance * ambient_occlusion / 3.141592653589793;
    let reflection = safe_normalize(reflect(-view, normal), normal);
    let max_specular_lod = f32(textureNumLevels(specular_environment) - 1u);
    let radiance = textureSampleLevel(
      specular_environment, environment_sampler, reflection, rough * max_specular_lod).rgb;
    color += radiance * specular_fraction * ambient_occlusion * global_illumination;
  }
  color += input.emissive_alpha.rgb * emission;
  let exposure = select(1.0, frame.lightingOptions.x, authored_light);
  var surface_color = select(color, base, flag(input.material.w, 64u));
  if (frame.fogProjection.z == 2.0 && !flag(input.material.w, 32u)) {
    // clip W is signed camera-space depth; no radial-distance or fixed near/far approximation.
    let camera_depth = max((frame.view * vec4f(input.world, 1.0)).w, 0.0);
    let optical_depth = frame.tuning.w * camera_depth;
    let amount = clamp(1.0 - exp(-optical_depth * optical_depth), 0.0, 1.0);
    surface_color = mix(surface_color, frame.tuning.rgb, amount);
  }
  let output_alpha = select(1.0, alpha, flag(input.material.w, 4u));
  return NativeMeshSurface(vec4f(surface_color * exposure, output_alpha), vec4f(normal * 0.5 + 0.5, rough));
}

@fragment fn fragment_main(input: VertexOutput, @builtin(front_facing) front_facing: bool) -> @location(0) vec4f {
  return shade_native_mesh(input, front_facing).color;
}

@fragment fn fragment_normal_capture(input: VertexOutput, @builtin(front_facing) front_facing: bool) -> NativeMeshCapture {
  let surface = shade_native_mesh(input, front_facing);
  return NativeMeshCapture(surface.color, surface.normalRoughness);
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
