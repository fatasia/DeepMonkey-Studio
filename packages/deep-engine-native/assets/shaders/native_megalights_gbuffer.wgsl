// Opaque/MASK material input for RIS. Uses the production UV/normal functions;
// no lighting, emissive, exposure or fog is baked into the material buffer.
@fragment fn fragment_megalights_gbuffer(
  input: VertexOutput, @builtin(front_facing) front_facing: bool,
) -> NativeMeshCapture {
  if (section_rejected(input.world) || flag(input.material.w, 64u)) { discard; }
  var base_sample = vec4f(1.0);
  var mr_sample = vec4f(1.0);
  if (material_textures.base_row_0.w > 0.5) {
    base_sample = textureSample(base_color_map, base_color_sampler,
      transformed_uv(input.uv0, input.uv1, material_textures.base_row_0, material_textures.base_row_1));
  }
  if (material_textures.mr_row_0.w > 0.5) {
    mr_sample = textureSample(metallic_roughness_map, metallic_roughness_sampler,
      transformed_uv(input.uv0, input.uv1, material_textures.mr_row_0, material_textures.mr_row_1));
  }
  if (flag(input.material.w, 2u) && input.emissive_alpha.w * base_sample.a < input.material.y) { discard; }
  let geometry_normal = oriented_normal(input, front_facing);
  var normal = geometry_normal;
  if (material_textures.normal_row_0.w > 0.5) { normal = mapped_normal(input, front_facing); }
  let base = input.base_color.rgb * base_sample.rgb;
  let metal = clamp(input.base_color.w * mr_sample.b, 0.0, 1.0);
  let rough = min(1.0, clamp(input.material.x * mr_sample.g, 0.045, 1.0)
    + native_view_geometry_roughness(geometry_normal));
  return NativeMeshCapture(vec4f(base, metal + select(0.0, 2.0, flag(input.material.w, 16u))), vec4f(normal * 0.5 + 0.5, rough));
}
