// F2 RT fragment 像素消费最小切片（仅 directional shadow Ray Query）。
// 本文件是拼接追加段：frame_bindings::create_native_mesh_rt_shader 按
// "enable wgpu_ray_query" + native_mesh_v1.wgsl + native_cascaded_shadow_v1.wgsl
// + 本文件 组成单一模块，因此这里可直接引用前两个文件的类型与函数库。
//
// 同步契约：fragment_main_rt 的 PBR 主体与 native_mesh_v1.wgsl 的
// fragment_main 保持一致，唯一差异是 directional 阴影可见性来源——
// 本体走级联阴影贴图采样，这里走场景 TLAS 的硬件 Ray Query 遮挡检测
// （BLEND 整族不在 TLAS 驻留内，与 Web renderPacketRayScene 同口径）。
// 修改本体 lighting 主体时必须同步本文件；若契约失配，拼接模块的 WGSL
// 编译会在 device error scope 内失败并 fail-closed 关闭 RT pixel 路径，
// 栅格主通路不受影响（init/帧循环均按 Option 缺失回退）。
@group(0) @binding(10) var scene_tlas: acceleration_structure;

// TLAS 实例掩码与 renderer::rt_residency 的 RT_SCENE_RAY_MASK(=1) 同值；
// cull mask 0xFF 表示接受全部实例掩码，遮挡判定只看几何存在性。
fn rt_directional_visibility(world: vec3f, light: vec3f) -> f32 {
  var rq: ray_query;
  let origin = world + light * 0.001;
  rayQueryInitialize(&rq, scene_tlas, RayDesc(0u, 0xFFu, 0.0, 1.0e30, origin, light));
  while rayQueryProceed(&rq) {}
  let committed = rayQueryGetCommittedIntersection(&rq);
  return select(1.0, 0.0, committed.kind != RAY_QUERY_INTERSECTION_NONE);
}

// I-C23:光照主体抽到本体的 native_lit_response + deep_layer_stack 共享函数
// (同步契约由函数共享而非文本重复保证);本文件只剩 RT 专属的可见性来源与
// 与本体同构的拆分:naga 按静态调用图收集 uniform 资源,共享函数里的
// if(layered) 分支会让普通 RT 入口也绑 group1@11。核心路径返回
// NativeMeshShading(本体同款结构),层栈只在 *_layered 包装内引用。
fn rt_shade_surface(
  input: VertexOutput,
  front_facing: bool,
) -> NativeMeshShading {
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
  let rough_raw = input.material.x * mr_sample.g;
  let geometry_normal = oriented_normal(input, front_facing);
  var normal = geometry_normal;
  if (material_textures.normal_row_0.w > 0.5) { normal = mapped_normal(input, front_facing); }
  let authored_light = frame.sunColor.w >= 2.0;
  let view = safe_normalize(frame.eye.xyz - input.world, vec3f(0.0, 0.0, 1.0));
  let light = safe_normalize(frame.lightDirection.xyz, vec3f(0.0, 1.0, 0.0));
  // 与本体 fragment_main 的唯一差异：directional 阴影可见性改走 Ray Query。
  let visibility = select(rt_directional_visibility(input.world, light),
    1.0, flag(input.material.w, 16u) || (authored_light && frame.lightingOptions.y == 0.0));
  // C9/native 扩展带:RT 像素路与栅格路共用 native_extended_shade 包装核——
  // 同步契约由函数共享保证;全零带回落后与旧 native_lit_response 调用逐位一致。
  let surface_color = native_extended_shade(input, normal, geometry_normal, base, metal,
    rough_raw, input.dielectric, ao, emission, view, light, visibility);
  return NativeMeshShading(surface_color, normal, clamp(rough_raw, 0.045, 1.0), alpha, geometry_normal, base,
    clamp(input.base_color.w * mr_sample.b, 0.0, 1.0), rough_raw, ao, emission, view, light, visibility);
}

// 曝光/雾收尾:与本体 finish_native_mesh 同序(先雾后曝光);RT 侧复用本体函数亦可,
// 但 RT 阴影可见性已在 core 内解析,此处保持独立以隔离 RT 语义。
@fragment fn fragment_main_rt(
  input: VertexOutput,
  @builtin(front_facing) front_facing: bool,
) -> @location(0) vec4f {
  let shaded = rt_shade_surface(input, front_facing);
  var color = shaded.color;
  if (frame.fogProjection.z == 2.0 && !flag(input.material.w, 32u)) {
    let camera_depth = max((frame.view * vec4f(input.world, 1.0)).w, 0.0);
    let optical_depth = frame.tuning.w * camera_depth;
    let amount = clamp(1.0 - exp(-optical_depth * optical_depth), 0.0, 1.0);
    color = mix(color, frame.tuning.rgb, amount);
  }
  let exposure = select(1.0, frame.lightingOptions.x, frame.sunColor.w >= 2.0);
  let output_alpha = select(1.0, shaded.alpha, flag(input.material.w, 4u));
  return vec4f(color * exposure, output_alpha);
}

// I-C23 分层入口:只有 RT 分层管线族(扩展 layout)创建;层栈只被本包装引用。
@fragment fn fragment_main_rt_layered(
  input: VertexOutput,
  @builtin(front_facing) front_facing: bool,
) -> @location(0) vec4f {
  let shaded = rt_shade_surface(input, front_facing);
  let layered_color = deep_layer_stack(shaded.color, input, shaded.normal, shaded.geometry_normal,
    shaded.base, shaded.metal, shaded.rough_raw, shaded.ao, shaded.emission,
    shaded.view, shaded.light, shaded.visibility);
  var color = layered_color;
  if (frame.fogProjection.z == 2.0 && !flag(input.material.w, 32u)) {
    let camera_depth = max((frame.view * vec4f(input.world, 1.0)).w, 0.0);
    let optical_depth = frame.tuning.w * camera_depth;
    let amount = clamp(1.0 - exp(-optical_depth * optical_depth), 0.0, 1.0);
    color = mix(color, frame.tuning.rgb, amount);
  }
  let exposure = select(1.0, frame.lightingOptions.x, frame.sunColor.w >= 2.0);
  let output_alpha = select(1.0, shaded.alpha, flag(input.material.w, 4u));
  return vec4f(color * exposure, output_alpha);
}
