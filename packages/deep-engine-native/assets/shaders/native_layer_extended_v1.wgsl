// Layer-only main-light wrapper: scalar parameters keep ordinary entrypoints isolated.
// Ordinary entrypoints continue to reach only native_lit_response.
fn native_layer_lit_response(
  input: VertexOutput, normal: vec3f, geometry_normal: vec3f,
  base: vec3f, metal: f32, rough_raw: f32, dielectric: f32,
  ao: f32, emission: vec3f, view: vec3f, light: vec3f,
  visibility: f32, params0: vec4f, params1: vec4f, metal_reflection: bool,
) -> vec3f {
  let original = native_lit_response(input, normal, geometry_normal, base, metal,
    rough_raw, dielectric, ao, emission, view, light, visibility);
  if (flag(input.material.w, 64u)) { return original; }
  if (metal_reflection) {
    return native_layer_metal_response(input, normal, geometry_normal, base, metal, rough_raw,
      dielectric, ao, emission, view, light, visibility, params0, params1, original);
  }
  if (params0.y == 0.0) { return original; }
  let sun = select(vec3f(3.2, 3.0, 2.8), frame.sunColor.rgb, frame.sunColor.w >= 2.0);
  let extended = deepEvaluateExtendedMaterial(base, metal, rough_raw, normal, view,
    light, input.tangent.xyz, sun,
    DeepMaterialEvalParams(params0.x, params0.y, params0.z, 0.0, 0.0, 0.0));
  let rough = min(1.0, clamp(rough_raw, 0.045, 1.0) + native_view_geometry_roughness(geometry_normal));
  let nv = clamp(dot(normal, view), 0.001, 1.0);
  let dfg = deepDirectDfg185(rough, nv);
  let stock_direct = (brdfWithDielectricF0(normal, view, light, base, metal, rough, dielectric)
    + native_direct_multiscattering(normal, light, base, metal, rough, dielectric, dfg)) * sun * visibility;
  return original - stock_direct + extended.rgb * visibility;
}
