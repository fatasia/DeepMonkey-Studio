import { PBR_BRDF_DIRECT_MULTISCATTERING_WGSL } from "../lighting/brdfDirectMultiscatteringWgsl.js";

/** Uses existing DFG resource/ABI; no light performs no direct LUT sampling. */
export const PBR_DIRECT_MULTISCATTERING_WGSL = /* wgsl */ `${PBR_BRDF_DIRECT_MULTISCATTERING_WGSL}
fn deepViewGeometryRoughness(worldGeometryNormal: vec3f) -> f32 {
  let viewNormal = safeNormalize((frame.worldToView * vec4f(worldGeometryNormal, 0.0)).xyz, vec3f(0.0, 0.0, 1.0));
  return deepGeometryRoughness(viewNormal);
}
fn deepDirectMultiscatteringFromView(n: vec3f, light: vec3f, base: vec3f, metal: f32,
  rough: f32, dielectric: f32, dfgView: vec2f) -> vec3f {
  let nl = clamp(dot(n, light), 0.0, 1.0);
  if (frame.sunColor.w <= 0.0 || nl <= 0.0) { return vec3f(0.0); }
  let dfgLight = textureSampleLevel(brdfLut, environmentSampler, vec2f(nl, rough), 0.0).rg;
  return deepDirectMultiscatteringEnergy(mix(vec3f(dielectric), base, metal), dfgView, dfgLight) * nl;
}
fn deepSampleDirectMultiscattering(n: vec3f, view: vec3f, light: vec3f, base: vec3f,
  metal: f32, rough: f32, dielectric: f32) -> vec3f {
  if (frame.sunColor.w <= 0.0 || dot(n, light) <= 0.0) { return vec3f(0.0); }
  let nv = clamp(dot(n, view), 0.001, 1.0);
  let dfgView = textureSampleLevel(brdfLut, environmentSampler, vec2f(nv, rough), 0.0).rg;
  return deepDirectMultiscatteringFromView(n, light, base, metal, rough, dielectric, dfgView);
}
`;
