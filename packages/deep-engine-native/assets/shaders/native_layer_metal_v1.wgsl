// Explicit reflection model only replaces the main sun term; stock environment,
// local lighting, GI and emission continue through native_lit_response.
fn native_layer_metal_response(input: VertexOutput, normal: vec3f, geometry_normal: vec3f,
  base: vec3f, metal: f32, rough_raw: f32, dielectric: f32, ao: f32, emission: vec3f,
  view: vec3f, light: vec3f, visibility: f32, params0: vec4f, params1: vec4f,
  original: vec3f) -> vec3f {
  let sun = select(vec3f(3.2, 3.0, 2.8), frame.sunColor.rgb, frame.sunColor.w >= 2.0);
  let rough = min(1.0, clamp(rough_raw, 0.045, 1.0) + native_view_geometry_roughness(geometry_normal));
  let nv = clamp(dot(normal, view), 0.001, 1.0);
  let dfg = deepDirectDfg185(rough, nv);
  let stock_direct = (brdfWithDielectricF0(normal, view, light, base, metal, rough, dielectric)
    + native_direct_multiscattering(normal, light, base, metal, rough, dielectric, dfg)) * sun * visibility;
  let reflected = deepMetalReflectionDirect(base, rough_raw, normal, view, light,
    input.tangent.xyz, sun, params0.w, params1.x);
  return original - stock_direct + reflected * visibility;
}
