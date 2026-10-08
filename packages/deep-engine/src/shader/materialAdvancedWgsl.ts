/** advancedMaterials 变体的 WGSL 片段(sheen / iridescence / clearcoat IBL / 体积透射)。
 * 数学逐项对齐 three r185 lights_physical_pars_fragment / iridescence_fragment / transmission_*;
 * 仅由 composeAdvancedMaterialSceneShader 注入,未启用该变体的管线不含这段文本。 */
import { PBR_PROBE_IRRADIANCE_GAIN_WGSL } from "../webgpu/pbrGlobalIlluminationIntensity.js";

export const ADVANCED_MATERIAL_STRUCT_FIELDS_WGSL = "extended0: vec4f, extended1: vec4f,\n  advanced0: vec4f, advanced1: vec4f, advanced2: vec4f,\n  specularParameters: vec4f, specularRow0: vec4f, specularRow1: vec4f, specularColorRow0: vec4f, specularColorRow1: vec4f,";

export const ADVANCED_MATERIAL_MATH_WGSL = /* wgsl */ `
const DEEP_ADV_PI: f32 = 3.141592653589793;
fn deepAdvMax3(c: vec3f) -> f32 { return max(c.x, max(c.y, c.z)); }
fn deepAdvSchlick(f0: f32, cosine: f32) -> f32 {
  let f = exp2((-5.55473 * cosine - 6.98316) * cosine);
  return f0 * (1.0 - f) + f;
}
fn deepAdvSensitivity(opd: f32, shift: vec3f) -> vec3f {
  let phase = 2.0 * DEEP_ADV_PI * opd * 1.0e-9;
  let val = vec3f(5.4856e-13, 4.4201e-13, 5.2481e-13);
  let pos = vec3f(1.6810e+06, 1.7953e+06, 2.2084e+06);
  let vr = vec3f(4.3278e+09, 9.3046e+09, 6.6121e+09);
  var xyz = val * sqrt(2.0 * DEEP_ADV_PI * vr) * cos(pos * phase + shift) * exp(-phase * phase * vr);
  xyz.x += 9.7470e-14 * sqrt(2.0 * DEEP_ADV_PI * 4.5282e+09) * cos(2.2399e+06 * phase + shift.x) * exp(-4.5282e+09 * phase * phase);
  xyz /= 1.0685e-7;
  return mat3x3f(vec3f(3.2404542, -0.9692660, 0.0556434), vec3f(-1.5371385, 1.8760108, -0.2040259),
    vec3f(-0.4985314, 0.0415560, 1.0572252)) * xyz;
}
fn deepAdvEvalIridescence(outsideIor: f32, eta2: f32, cosTheta1: f32, thickness: f32, baseF0: vec3f) -> vec3f {
  let iridIor = mix(outsideIor, eta2, smoothstep(0.0, 0.03, thickness));
  let ratio = outsideIor / iridIor;
  let cosTheta2Sq = 1.0 - ratio * ratio * (1.0 - cosTheta1 * cosTheta1);
  if (cosTheta2Sq < 0.0) { return vec3f(1.0); }
  let cosTheta2 = sqrt(cosTheta2Sq);
  let q0 = (iridIor - outsideIor) / (iridIor + outsideIor);
  let r0 = q0 * q0;
  let r12 = deepAdvSchlick(r0, cosTheta1);
  let t121 = 1.0 - r12;
  let phi12 = select(0.0, DEEP_ADV_PI, iridIor < outsideIor);
  let phi21 = DEEP_ADV_PI - phi12;
  let sqrtF0 = sqrt(clamp(baseF0, vec3f(0.0), vec3f(0.9999)));
  let baseIor = (vec3f(1.0) + sqrtF0) / (vec3f(1.0) - sqrtF0);
  let ratio1 = (baseIor - vec3f(iridIor)) / (baseIor + vec3f(iridIor));
  let r1 = ratio1 * ratio1;
  let f = exp2((-5.55473 * cosTheta2 - 6.98316) * cosTheta2);
  let r23 = r1 * (1.0 - f) + vec3f(f);
  let phi23 = select(vec3f(0.0), vec3f(DEEP_ADV_PI), baseIor < vec3f(iridIor));
  let opd = 2.0 * iridIor * thickness * cosTheta2;
  let phi = vec3f(phi21) + phi23;
  let r123 = clamp(vec3f(r12) * r23, vec3f(1e-5), vec3f(0.9999));
  let rt123 = sqrt(r123);
  let rs = (t121 * t121) * r23 / (vec3f(1.0) - r123);
  var intensity = vec3f(r12) + rs;
  var cm = rs - vec3f(t121);
  cm *= rt123;
  intensity += cm * (2.0 * deepAdvSensitivity(opd, phi));
  cm *= rt123;
  intensity += cm * (2.0 * deepAdvSensitivity(2.0 * opd, 2.0 * phi));
  return max(intensity, vec3f(0.0));
}
fn deepAdvSchlickToF0(f: vec3f, cosine: f32) -> vec3f {
  let x = clamp(1.0 - cosine, 0.0, 1.0);
  let x2 = x * x;
  let x5 = clamp(x * x2 * x2, 0.0, 0.9999);
  return (f - vec3f(x5)) / (1.0 - x5);
}
fn deepAdvDCharlie(roughness: f32, nh: f32) -> f32 {
  let invAlpha = 1.0 / (roughness * roughness);
  let sin2h = max(1.0 - nh * nh, 0.0078125);
  return (2.0 + invAlpha) * pow(sin2h, invAlpha * 0.5) / (2.0 * DEEP_ADV_PI);
}
fn deepAdvVNeubelt(nv: f32, nl: f32) -> f32 { return clamp(1.0 / (4.0 * max(nl + nv - nl * nv, 0.000001)), 0.0, 1.0); }
fn deepAdvIblSheen(nv: f32, roughness: f32) -> f32 {
  let r2 = roughness * roughness;
  let rInv = 1.0 / (roughness + 0.1);
  let a = -1.9362 + 1.0678 * roughness + 0.4573 * r2 - 0.8469 * rInv;
  let b = -0.6014 + 0.5538 * roughness - 0.4670 * r2 - 0.1255 * rInv;
  return clamp(exp(a * nv + b), 0.0, 1.0);
}
fn deepAdvGgx(nl: f32, nv: f32, nh: f32, roughness: f32) -> f32 {
  let a2 = pow(roughness * roughness, 2.0);
  let denom = nh * nh * (a2 - 1.0) + 1.0;
  let d = a2 / max(DEEP_ADV_PI * denom * denom, 0.000001);
  let gv = nl * sqrt(a2 + (1.0 - a2) * nv * nv);
  let gl = nv * sqrt(a2 + (1.0 - a2) * nl * nl);
  return d * 0.5 / max(gv + gl, 0.000001);
}
fn deepAdvBeer(distance: f32, color: vec3f, attenuationDistance: f32) -> vec3f {
  if (attenuationDistance <= 0.0) { return vec3f(1.0); }
  return exp(log(max(color, vec3f(0.000001))) * (distance / attenuationDistance));
}
`;

export const ADVANCED_MATERIAL_WGSL = /* wgsl */ `${ADVANCED_MATERIAL_MATH_WGSL}
var<private> deepAdvIridF0: vec3f;
var<private> deepAdvIridFactor: f32;
fn deepAdvancedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {
  let ext0 = materialTextures.extended0;
  let ext1 = materialTextures.extended1;
  let sheenColor = materialTextures.advanced0.xyz;
  let sheenRoughness = clamp(materialTextures.advanced0.w, 0.0001, 1.0);
  let film = materialTextures.advanced1;
  let volume = materialTextures.advanced2;
  let sheenPeak = deepAdvMax3(sheenColor);
  let coat = clamp(ext0.y, 0.0, 1.0);
  let transmission = clamp(ext1.y, 0.0, 1.0);
  let view = safeNormalize(frame.eye.xyz - v.world, vec3f(0.0, 0.0, 1.0));
  let light = safeNormalize(frame.lightDirection.xyz, vec3f(0.0, 1.0, 0.0));
  let base = surface.base;
  let metal = surface.metal;
  let dielectric = v.dielectric;
  let diffuseContribution = base * (1.0 - metal);
  let nv = clamp(dot(normal, view), 0.0, 1.0);
  var iridFresnel = vec3f(0.0);
  var irid = 0.0;
  if (film.z > 0.0) { irid = clamp(film.x, 0.0, 1.0); }
  if (irid > 0.0) {
    if (metal < 1.0) { iridFresnel = deepAdvEvalIridescence(1.0, film.y, nv, film.z, deepAdvMaterialF0(base, 0.0, dielectric)); }
    if (metal > 0.0) { iridFresnel = mix(iridFresnel, deepAdvEvalIridescence(1.0, film.y, nv, film.z, base), metal); }
  }
  let iridF0 = deepAdvSchlickToF0(iridFresnel, nv);
  deepAdvIridFactor = irid;
  deepAdvIridF0 = iridF0;
  let original = shade(v.clip.xy, v.world, normal, geometryNormal, false, base, metal, surface.rough,
    surface.occlusion, surface.emissive, v.authorShadow, v.material.w, dielectric, false);
  deepAdvIridFactor = 0.0;
  let sunRadiance = frame.sunColor.rgb * frame.sunColor.w;
  let visibility = deepPrimaryShadow(v.world, normal, dot(normal, light), v.authorShadow, v.clip.xy, v.material.w);
  let geometryRoughness = deepViewGeometryRoughness(geometryNormal);
  let rough = min(1.0, clamp(surface.rough, 0.06, 1.0) + geometryRoughness);
  let nl = clamp(dot(normal, light), 0.0, 1.0);
  let nvSafe = max(nv, 0.0001);
  let halfDir = safeNormalize(view + light, normal);
  let nh = clamp(dot(normal, halfDir), 0.0, 1.0);
  let vh = clamp(dot(view, halfDir), 0.0, 1.0);
  let stockBrdf = brdfWithDielectricF0(normal, view, light, base, metal, rough, dielectric)
    + deepSampleDirectMultiscattering(normal, view, light, base, metal, rough, dielectric);
  var sunBrdf = stockBrdf;
  if (irid > 0.0) {
    let fStock = fresnel(vh, deepAdvMaterialF0(base, metal, dielectric));
    sunBrdf += (mix(fStock, iridFresnel, irid) - fStock) * (deepAdvGgx(nl, nvSafe, nh, rough) * nl);
  }
  var energyDirect = 1.0;
  var energyIndirect = 1.0;
  var sheenAlbedoView = 0.0;
  var sheenDirect = vec3f(0.0);
  if (sheenPeak > 0.0) {
    sheenAlbedoView = deepAdvIblSheen(nv, sheenRoughness);
    energyIndirect = 1.0 - sheenPeak * sheenAlbedoView;
    energyDirect = 1.0 - sheenPeak * max(sheenAlbedoView, deepAdvIblSheen(nl, sheenRoughness));
    sheenDirect = sheenColor * (deepAdvDCharlie(sheenRoughness, nh) * deepAdvVNeubelt(nv, nl) * nl) * sunRadiance * visibility;
  }
  let emissive = surface.emissive;
  var color = (original - stockBrdf * sunRadiance * visibility - emissive) * energyIndirect
    + sunBrdf * sunRadiance * visibility * energyDirect + sheenDirect + emissive;
  let iblOn = frame.eye.w > 0.0;
  let occlusion = clamp(surface.occlusion, 0.0, 1.0);
  var irradiance = vec3f(0.0);
  var sceneDisplayContribution = vec3f(0.0);
  var sceneDisplayWeight = vec3f(0.0);
  if (iblOn && (sheenPeak > 0.0 || transmission > 0.0)) {
    let environmentIrradiance = textureSampleLevel(diffuseEnvironment, environmentSampler, normal, 0.0).rgb * frame.lightDirection.w;
    let gi = deepGiSampleTexture(v.world, normal);
    irradiance = mix(environmentIrradiance, ${PBR_PROBE_IRRADIANCE_GAIN_WGSL}, gi.a);
  }
  if (sheenPeak > 0.0 && iblOn) { color += irradiance * sheenColor * sheenAlbedoView * occlusion * frame.eye.w; }
  if (transmission > 0.0) {
    let ior = select(1.5, ext0.x, ext0.x >= 1.0);
    let sunDiffuse = diffuseContribution * (nl / DEEP_ADV_PI) * sunRadiance * visibility * energyDirect;
    var iblDiffuse = vec3f(0.0);
    var transmitted = vec3f(0.0);
    let dfg = textureSampleLevel(brdfLut, environmentSampler, vec2f(clamp(nv, 0.001, 1.0), rough), 0.0).rg;
    let f0 = deepAdvMaterialF0(base, metal, dielectric);
    if (iblOn) {
      let f0Film = mix(f0, iridF0, irid);
      let energyCompensation = vec3f(1.0) + f0Film * (1.0 / max(dfg.x + dfg.y, 0.05) - 1.0);
      let specularFraction = clamp(f0Film * dfg.x + deepAdvCurrentSpecularF90() * dfg.y, vec3f(0.0), vec3f(1.0)) * energyCompensation;
      iblDiffuse = (vec3f(1.0) - specularFraction) * diffuseContribution * irradiance * occlusion * frame.eye.w * energyIndirect;
      let refracted = refract(-view, normal, 1.0 / ior);
      let direction = select(-view, safeNormalize(refracted, -view), dot(refracted, refracted) > 0.0);
      let sampled = deepPbrReflectionRadiance(v.world, direction, rough * clamp(ior * 2.0 - 2.0, 0.0, 1.0))
        * frame.lightDirection.w * frame.eye.w;
      transmitted = (vec3f(1.0) - (f0 * dfg.x + deepAdvCurrentSpecularF90() * dfg.y)) * diffuseContribution
        * deepAdvBeer(film.w, volume.xyz, volume.w) * sampled;
    }
    let scene = deepSceneTransmissionSample(v.world, normal, view, ior, film.w, surface.rough);
    if (scene.a > 0.5) {
      let weight = (vec3f(1.0) - clamp(f0 * dfg.x + deepAdvCurrentSpecularF90() * dfg.y, vec3f(0.0), vec3f(1.0)))
        * diffuseContribution * deepAdvBeer(film.w, volume.xyz, volume.w);
      if (deepFog.parameters.w > 0.5) {
        // Direct author source already contains ACES/sRGB; contribute after conversion once.
        transmitted = vec3f(0.0);
        sceneDisplayWeight = transmission * weight;
        sceneDisplayContribution = scene.rgb * sceneDisplayWeight;
      } else { transmitted = scene.rgb * weight; }
    }
    color += transmission * (transmitted - sunDiffuse - iblDiffuse);
  }
  if (coat > 0.0) {
    let coatRoughness = min(max(ext0.z, 0.0525) + geometryRoughness, 1.0);
    var coatSpecular = sunRadiance * visibility * (nl * deepAdvSchlick(0.04, vh) * deepAdvGgx(nl, nvSafe, nh, coatRoughness));
    if (iblOn) {
      let dfg = textureSampleLevel(brdfLut, environmentSampler, vec2f(clamp(nv, 0.001, 1.0), coatRoughness), 0.0).rg;
      coatSpecular += deepPbrReflectionRadiance(v.world, reflect(-view, normal), coatRoughness)
        * frame.lightDirection.w * frame.eye.w * (0.04 * dfg.x + dfg.y);
    }
    color = color * (1.0 - coat * deepAdvSchlick(0.04, nv)) + coatSpecular * coat;
    sceneDisplayWeight *= 1.0 - coat * deepAdvSchlick(0.04, nv);
    sceneDisplayContribution *= 1.0 - coat * deepAdvSchlick(0.04, nv);
  }
  let displayed = deepApplySceneFog(select(color, base, flag(v.material.w, 64u)), v.world, v.material.w);
  if (any(sceneDisplayWeight > vec3f(0.0))) {
    let fogFill = deepApplySceneFog(vec3f(0.0), v.world, v.material.w);
    return displayed + sceneDisplayContribution - fogFill * sceneDisplayWeight;
  }
  return displayed;
}
fn extendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {
  deepAdvSampleSpecular(v, surface.metal);
  let ext0 = materialTextures.extended0;
  let film = materialTextures.advanced1;
  if (materialTextures.specularParameters.w != 1.0 || any(materialTextures.specularParameters.xyz != vec3f(1.0))
    || materialTextures.specularRow0.w > 0.5 || materialTextures.specularColorRow0.w > 0.5
    || ext0.y > 0.0 || materialTextures.extended1.y > 0.0 || deepAdvMax3(materialTextures.advanced0.xyz) > 0.0
    || (film.x > 0.0 && film.z > 0.0)) {
    return deepAdvancedShade(v, normal, geometryNormal, surface);
  }
  return deepLegacyExtendedShade(v, normal, geometryNormal, surface);
}
`;
