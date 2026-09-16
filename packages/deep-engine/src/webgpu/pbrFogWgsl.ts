/** Author fog is mixed in the HDR composer domain, before output tone mapping. */
export const PBR_FOG_WGSL = /* wgsl */ `
struct DeepFog { colorMode: vec4f, parameters: vec4f };
@group(0) @binding(8) var<uniform> deepFog: DeepFog;
fn deepApplyAuthorFog(color: vec3f, viewDepth: f32) -> vec3f {
  if (deepFog.colorMode.w < 0.5) { return color; }
  var factor = 0.0;
  if (deepFog.colorMode.w < 1.5) {
    factor = smoothstep(deepFog.parameters.x, deepFog.parameters.y, viewDepth);
  } else {
    let opticalDepth = deepFog.parameters.z * viewDepth;
    factor = 1.0 - exp(-opticalDepth * opticalDepth);
  }
  return mix(color, deepFog.colorMode.rgb, factor);
}
fn deepApplySceneFog(color: vec3f, world: vec3f, materialFlags: f32) -> vec3f {
  if (flag(materialFlags, 32u)) { return color; }
  if (deepFog.colorMode.w < 2.5) { return deepApplyAuthorFog(color, -(frame.worldToView * vec4f(world, 1.0)).z); }
  if (frame.tuning.w <= 0.0) { return color; }
  let distance = length(frame.eye.xyz - world); let fog = 1.0 - exp(-pow(distance * frame.tuning.w, 2.0));
  return mix(color, frame.background.rgb, min(fog, 0.95));
}
`;
