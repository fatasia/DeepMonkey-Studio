/** T08 GPU 联测切片 · 扩展材质参数的最小 WGSL 求值核。
 * 与 CPU 参考 materialEvaluate.evaluateExtendedMaterialDirect 逐公式镜像:
 * GGX D + Schlick-Smith G(k=(r+1)²/8)+ Schlick F、roughness 夹取 [0.045,1]、
 * nDotV 下限 1e-4;clearcoat 层叠复用 evaluateClearcoatReference 的同公式
 * (dfg=[0,0] 的 direct 分支);各向异性 Burley D(ax=α·(1+s), ay=α, TBN 支持旋转);
 * 薄壁透射朗伯 lobe;介电 F0 复用既有 MATERIAL_DIELECTRIC_WGSL(deepDielectricF0)。
 * 输出四 lobe 分量与 rgb(分量和恒等 rgb)。本模块是函数库,不定义 @compute 入口;
 * 管线侧自带入口调用 deepEvaluateExtendedMaterial。所有函数名带 deepMaterial 前缀,
 * 避免与 surfaceLowering 的 deep* 主干同名冲突。 */

import { MATERIAL_DIELECTRIC_WGSL } from "../materialDielectric.js";
import { EXTENDED_PARAMETER_WGSL_STRUCT } from "./materialParameterAbi.js";

export const EXTENDED_MATERIAL_EVALUATION_WGSL = /* wgsl */ `${EXTENDED_PARAMETER_WGSL_STRUCT}

struct DeepMaterialEvalResult {
  rgb: vec3f,
  diffuse: vec3f,
  specular: vec3f,
  clearcoatLobe: vec3f,
  transmissionLobe: vec3f,
}

struct DeepMaterialAnisoFrame {
  t: vec3f,
  b: vec3f,
}

${MATERIAL_DIELECTRIC_WGSL}

const DEEP_MATERIAL_PI: f32 = 3.141592653589793;

fn deepMaterialSafeNormalize(value: vec3f, fallback: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  let normalized = value * (1.0 / sqrt(lengthSquared));
  return select(fallback, normalized, lengthSquared > 0.00000001);
}

fn deepMaterialCross(a: vec3f, b: vec3f) -> vec3f {
  return vec3f(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

fn deepMaterialSchlick(f0: f32, cosine: f32) -> f32 {
  return f0 + (1.0 - f0) * pow(1.0 - cosine, 5.0);
}

fn deepMaterialDistributionGgx(nDotH: f32, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
  return alpha2 / max(DEEP_MATERIAL_PI * denominator * denominator, 0.000001);
}

fn deepMaterialDistributionGgxAnisotropic(tDotH: f32, bDotH: f32, nDotH: f32, alpha: f32, strength: f32) -> f32 {
  let ax = max(alpha * (1.0 + strength), 0.001);
  let ay = max(alpha, 0.001);
  let d = (tDotH / ax) * (tDotH / ax) + (bDotH / ay) * (bDotH / ay) + nDotH * nDotH;
  return 1.0 / max(DEEP_MATERIAL_PI * ax * ay * d * d, 0.000000000001);
}

fn deepMaterialGeometrySchlick(nDotX: f32, roughness: f32) -> f32 {
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  return nDotX / max(nDotX * (1.0 - k) + k, 0.0001);
}

fn deepMaterialAnisotropicFrame(rotation: f32, tangent: vec3f, normal: vec3f) -> DeepMaterialAnisoFrame {
  let projection = dot(tangent, normal);
  let projected = deepMaterialSafeNormalize(tangent - normal * projection, vec3f(1.0, 0.0, 0.0));
  let bitangent = deepMaterialSafeNormalize(deepMaterialCross(normal, projected), vec3f(0.0, 1.0, 0.0));
  let cosRotation = cos(rotation);
  let sinRotation = sin(rotation);
  return DeepMaterialAnisoFrame(projected * cosRotation + bitangent * sinRotation,
    bitangent * cosRotation - projected * sinRotation);
}

/// clearcoat 直接光分支(evaluateClearcoatReference,dfg=[0,0]);返回 (baseAttenuation, directLobe)。
fn deepMaterialClearcoatDirect(factor: f32, roughnessIn: f32, nDotLIn: f32, nDotVIn: f32, nDotHIn: f32, vDotHIn: f32) -> vec2f {
  let roughness = clamp(roughnessIn, 0.045, 1.0);
  let nDotL = clamp(nDotLIn, 0.0, 1.0);
  let nDotV = clamp(nDotVIn, 0.0001, 1.0);
  let nDotH = clamp(nDotHIn, 0.0, 1.0);
  let fresnel = 0.04 + 0.96 * pow(1.0 - clamp(vDotHIn, 0.0, 1.0), 5.0);
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
  let distribution = alpha2 / max(DEEP_MATERIAL_PI * denominator * denominator, 0.000001);
  let directSpecular = distribution * deepMaterialGeometrySchlick(nDotV, roughness)
    * deepMaterialGeometrySchlick(nDotL, roughness) * fresnel / max(4.0 * nDotV * nDotL, 0.0001);
  return vec2f(1.0 - factor * fresnel, factor * directSpecular);
}

fn deepEvaluateExtendedMaterial(baseColorIn: vec3f, metallicIn: f32, roughnessIn: f32,
  normalIn: vec3f, viewIn: vec3f, lightIn: vec3f, tangent: vec3f, radiance: vec3f,
  params: DeepMaterialEvalParams) -> DeepMaterialEvalResult {
  let baseColor = max(baseColorIn, vec3f(0.0));
  let normal = deepMaterialSafeNormalize(normalIn, vec3f(0.0, 1.0, 0.0));
  let view = deepMaterialSafeNormalize(viewIn, vec3f(0.0, 0.0, 1.0));
  let light = deepMaterialSafeNormalize(lightIn, vec3f(0.0, 1.0, 0.0));
  let halfVector = deepMaterialSafeNormalize(view + light, normal);
  let metallic = clamp(metallicIn, 0.0, 1.0);
  let roughness = clamp(roughnessIn, 0.045, 1.0);
  let nDotL = clamp(dot(normal, light), 0.0, 1.0);
  let nDotV = clamp(dot(normal, view), 0.0001, 1.0);
  let nDotH = clamp(dot(normal, halfVector), 0.0, 1.0);
  let vDotH = clamp(dot(view, halfVector), 0.0, 1.0);
  let f0Dielectric = deepDielectricF0(params.ior);
  let f0 = vec3f(f0Dielectric) + (baseColor - vec3f(f0Dielectric)) * metallic;
  let fresnel = vec3f(deepMaterialSchlick(f0.r, vDotH), deepMaterialSchlick(f0.g, vDotH),
    deepMaterialSchlick(f0.b, vDotH));
  let alpha = roughness * roughness;
  var distribution = deepMaterialDistributionGgx(nDotH, roughness);
  if (params.anisotropyStrength != 0.0) {
    let frame = deepMaterialAnisotropicFrame(params.anisotropyRotation, tangent, normal);
    distribution = deepMaterialDistributionGgxAnisotropic(dot(frame.t, halfVector),
      dot(frame.b, halfVector), nDotH, alpha, params.anisotropyStrength);
  }
  let geometryTerm = deepMaterialGeometrySchlick(nDotV, roughness)
    * deepMaterialGeometrySchlick(nDotL, roughness);
  let specularScalar = distribution * geometryTerm / max(4.0 * nDotV * nDotL, 0.0001);
  let specular = fresnel * specularScalar;
  let diffuse = (vec3f(1.0) - fresnel) * baseColor * ((1.0 - metallic) / DEEP_MATERIAL_PI);
  let transmission = params.transmissionFactor;
  let transmittance = deepMaterialSchlick(f0Dielectric, nDotV);
  let transmissionLobe = baseColor * vec3f(1.0 - metallic)
    * (transmission * (1.0 - transmittance) / DEEP_MATERIAL_PI);
  let scaledDiffuse = diffuse * (1.0 - transmission);
  let coat = deepMaterialClearcoatDirect(params.clearcoatFactor, params.clearcoatRoughness,
    nDotL, nDotV, nDotH, vDotH);
  let base = scaledDiffuse + specular + transmissionLobe;
  let layered = base * coat.x + vec3f(coat.y);
  let litFactor = radiance * nDotL;
  var result: DeepMaterialEvalResult;
  result.rgb = layered * litFactor;
  result.diffuse = scaledDiffuse * coat.x * litFactor;
  result.specular = specular * coat.x * litFactor;
  result.clearcoatLobe = vec3f(coat.y) * litFactor;
  result.transmissionLobe = transmissionLobe * coat.x * litFactor;
  return result;
}`;
