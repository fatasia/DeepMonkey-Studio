import { PBR_BRDF_DIRECT_MULTISCATTERING_WGSL } from "../lighting/brdfDirectMultiscatteringWgsl.js";
import { DIRECT_DFG_185_WGSL_ARRAY } from "./directDfgLut185.js";

/**
 * Direct-scatter DFG must come from the same table as the original Three r185
 * direct path (BRDF_GGX_Multiscatter -> DFGLUTData). The production brdfLut
 * stays the IBL split-sum resource; swapping it here left a systematic
 * multi-scatter residual on rough metals (C8-S9 oblique gate).
 */
const DIRECT_DFG_SOURCE = /* wgsl */ `
var<private> DEEP_DIRECT_DFG_185 = ${DIRECT_DFG_185_WGSL_ARRAY};
fn deepDirectDfg185(roughness: f32, dotNv: f32) -> vec2f {
  let u = clamp(roughness, 0.0, 1.0) * 16.0 - 0.5;
  let v = clamp(dotNv, 0.0, 1.0) * 16.0 - 0.5;
  let fu0 = floor(u); let fv0 = floor(v);
  let i0 = u32(clamp(fu0, 0.0, 15.0)); let j0 = u32(clamp(fv0, 0.0, 15.0));
  let i1 = u32(clamp(fu0 + 1.0, 0.0, 15.0)); let j1 = u32(clamp(fv0 + 1.0, 0.0, 15.0));
  let fu = clamp(u - fu0, 0.0, 1.0); let fv = clamp(v - fv0, 0.0, 1.0);
  let a00 = DEEP_DIRECT_DFG_185[j0 * 16u + i0]; let a10 = DEEP_DIRECT_DFG_185[j0 * 16u + i1];
  let a01 = DEEP_DIRECT_DFG_185[j1 * 16u + i0]; let a11 = DEEP_DIRECT_DFG_185[j1 * 16u + i1];
  return a00 * (1.0 - fu) * (1.0 - fv) + a10 * fu * (1.0 - fv)
    + a01 * (1.0 - fu) * fv + a11 * fu * fv;
}
`;

/** Uses the existing DFG resource/ABI; no light performs no direct LUT sampling. */
export const PBR_DIRECT_MULTISCATTERING_WGSL = /* wgsl */ `${PBR_BRDF_DIRECT_MULTISCATTERING_WGSL}
${DIRECT_DFG_SOURCE}
// WGSL private storage belongs to this fragment invocation, never another draw.
var<private> deepDirectViewDfgReady: bool;
var<private> deepDirectViewDfg: vec2f;
fn deepResetDirectViewDfg() { deepDirectViewDfgReady = false; }
fn deepSeedDirectViewDfg(value: vec2f) { deepDirectViewDfg = value; deepDirectViewDfgReady = true; }
fn deepClusterDirectMultiscattering(nv: f32, nl: f32, rough: f32, f0: vec3f) -> vec3f {
  if (nl <= 0.0) { return vec3f(0.0); }
  if (!deepDirectViewDfgReady) {
    deepSeedDirectViewDfg(deepDirectDfg185(rough, nv));
  }
  let dfgLight = deepDirectDfg185(rough, nl);
  return deepDirectMultiscatteringEnergy(f0, deepDirectViewDfg, dfgLight);
}
fn deepViewGeometryRoughness(worldGeometryNormal: vec3f) -> f32 {
  let viewNormal = safeNormalize((frame.worldToView * vec4f(worldGeometryNormal, 0.0)).xyz, vec3f(0.0, 0.0, 1.0));
  return deepGeometryRoughness(viewNormal);
}
fn deepDirectMultiscatteringFromView(n: vec3f, light: vec3f, base: vec3f, metal: f32,
  rough: f32, dielectric: f32, dfgView: vec2f) -> vec3f {
  let nl = clamp(dot(n, light), 0.0, 1.0);
  if (frame.sunColor.w <= 0.0 || nl <= 0.0) { return vec3f(0.0); }
  let dfgLight = deepDirectDfg185(rough, nl);
  return deepDirectMultiscatteringEnergy(mix(vec3f(dielectric), base, metal), dfgView, dfgLight) * nl;
}
fn deepSampleDirectMultiscattering(n: vec3f, view: vec3f, light: vec3f, base: vec3f,
  metal: f32, rough: f32, dielectric: f32) -> vec3f {
  deepResetDirectViewDfg();
  if (frame.sunColor.w <= 0.0 || dot(n, light) <= 0.0) { return vec3f(0.0); }
  let nv = clamp(dot(n, view), 0.001, 1.0);
  let dfgView = deepDirectDfg185(rough, nv);
  deepSeedDirectViewDfg(dfgView);
  return deepDirectMultiscatteringFromView(n, light, base, metal, rough, dielectric, dfgView);
}
`;
