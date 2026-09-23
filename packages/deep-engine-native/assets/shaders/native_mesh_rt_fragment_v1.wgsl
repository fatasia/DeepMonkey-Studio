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

@fragment fn fragment_main_rt(
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
  // 与本体 fragment_main 的唯一差异：directional 阴影可见性改走 Ray Query。
  let visibility = select(rt_directional_visibility(input.world, light),
    1.0, flag(input.material.w, 16u) || (authored_light && frame.lightingOptions.y == 0.0));
  let sun = select(vec3f(3.2, 3.0, 2.8), frame.sunColor.rgb, authored_light);
  let dielectric = input.dielectric;
  var color = direct_brdf_f0(normal, view, light, base, metal, rough, dielectric)
    * sun * visibility;
  if (frame.sunColor.w == 3.0) {
    color += local_direct_lighting(input.world, normal, view, base, metal, rough, !flag(input.material.w,16u), ao, dielectric, input.clip);
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
