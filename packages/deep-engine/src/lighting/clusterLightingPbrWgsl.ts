import { FORWARD_PLUS_CLUSTER_ABI_WGSL, FORWARD_PLUS_LIGHTING_BIND_GROUP } from "./clusterAbiWgsl.js";
import { FORWARD_PLUS_LIGHT_ABI_WGSL } from "./lightAbiWgsl.js";
import { LOCAL_SPOT_SHADOW_WGSL } from "../shadows/localSpotShadowShader.js";
import { DEEP_IES_SAMPLING_WGSL } from "./iesSamplingWgsl.js";
import { DEEP_AREA_LIGHTING_WGSL } from "./ltcAreaLightingWgsl.js";

/** Group 3 is reserved for clustered lighting; group 2 remains available for cascaded shadows. */
export const FORWARD_PLUS_PBR_WGSL = /* wgsl */ `${FORWARD_PLUS_LIGHT_ABI_WGSL}
${FORWARD_PLUS_CLUSTER_ABI_WGSL}
${LOCAL_SPOT_SHADOW_WGSL}
@group(${FORWARD_PLUS_LIGHTING_BIND_GROUP}) @binding(0) var<storage, read> deepClusterParams: ClusterParamsAbi;
@group(${FORWARD_PLUS_LIGHTING_BIND_GROUP}) @binding(1) var<storage, read> deepDirectionalLights: array<DirectionalLightAbi>;
@group(${FORWARD_PLUS_LIGHTING_BIND_GROUP}) @binding(2) var<storage, read> deepPointLights: array<PointLightAbi>;
@group(${FORWARD_PLUS_LIGHTING_BIND_GROUP}) @binding(3) var<storage, read> deepSpotLights: array<SpotLightAbi>;
@group(${FORWARD_PLUS_LIGHTING_BIND_GROUP}) @binding(4) var<storage, read> deepClusterHeaders: array<ClusterHeaderAbi>;
@group(${FORWARD_PLUS_LIGHTING_BIND_GROUP}) @binding(5) var<storage, read> deepClusterLightIndices: array<u32>;
// E02 IES 光域网：每灯参数 + 每 profile 元数据 + 展开归一化表（iesShading.ts 打包）。
@group(${FORWARD_PLUS_LIGHTING_BIND_GROUP}) @binding(12) var<storage, read> deepIesShading: array<vec4<f32>>;
// C3 面积光组合数据([灯区][LUT 区]) + cookie 纹理/采样器(pbrLightingBindings 缺省 1×1 白)。
@group(${FORWARD_PLUS_LIGHTING_BIND_GROUP}) @binding(13) var<storage, read> deepAreaLightData: array<vec4<f32>>;
@group(${FORWARD_PLUS_LIGHTING_BIND_GROUP}) @binding(14) var deepAreaCookie: texture_2d<f32>;
@group(${FORWARD_PLUS_LIGHTING_BIND_GROUP}) @binding(15) var deepAreaCookieSampler: sampler;

const DEEP_CLUSTER_PI: f32 = 3.141592653589793;
${DEEP_IES_SAMPLING_WGSL}${DEEP_AREA_LIGHTING_WGSL}fn deepClusterSafeNormalize(value: vec3f, fallback: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  return select(fallback, value * inverseSqrt(max(lengthSquared, 0.00000001)), lengthSquared > 0.00000001);
}
fn deepClusterFresnelSchlick(cosine: f32, f0: vec3f) -> vec3f {
  let factor = exp2((-5.55473 * cosine - 6.98316) * cosine);
  return f0 * (1.0 - factor) + factor;
}
fn deepClusterDistributionGgx(nDotH: f32, roughness: f32) -> f32 {
  let alpha = roughness * roughness; let alpha2 = alpha * alpha;
  let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
  return alpha2 / max(DEEP_CLUSTER_PI * denominator * denominator, 0.000001);
}
fn deepClusterBrdf(baseColor: vec3f, metallic: f32, roughness: f32, normal: vec3f,
  view: vec3f, surfaceToLight: vec3f, radiance: vec3f, dielectric: f32) -> vec3f {
  let nDotL = clamp(dot(normal, surfaceToLight), 0.0, 1.0);
  if (nDotL <= 0.0) { return vec3f(0.0); }
  let halfVector = deepClusterSafeNormalize(view + surfaceToLight, normal);
  let nDotV = clamp(dot(normal, view), 0.0001, 1.0);
  let nDotH = clamp(dot(normal, halfVector), 0.0, 1.0);
  let vDotH = clamp(dot(view, halfVector), 0.0, 1.0);
  let f0 = mix(vec3f(dielectric), baseColor, metallic);
  let fresnel = deepClusterFresnelSchlick(vDotH, f0);
  let distribution = deepClusterDistributionGgx(nDotH, roughness);
  let alpha = roughness * roughness; let alpha2 = alpha * alpha;
  let gv = nDotL * sqrt(alpha2 + (1.0 - alpha2) * nDotV * nDotV);
  let gl = nDotV * sqrt(alpha2 + (1.0 - alpha2) * nDotL * nDotL);
  let visibility = 0.5 / max(gv + gl, 0.000001);
  let specular = distribution * visibility * fresnel;
  let diffuse = (1.0 - metallic) * baseColor / DEEP_CLUSTER_PI;
  return (diffuse + specular) * radiance * nDotL;
}
fn deepClusterRangeAttenuation(distanceSquared: f32, range: f32, decay: f32) -> f32 {
  let falloff = 1.0 / max(pow(max(sqrt(distanceSquared), 0.00000001), decay), 0.01);
  if (range == 0.0) { return falloff; }
  if (distanceSquared >= range * range) { return 0.0; }
  let ratioSquared = distanceSquared / max(range * range, 0.0001);
  let window = max(1.0 - ratioSquared * ratioSquared, 0.0);
  if (decay == 2.0) { return window * window / max(distanceSquared, 0.01); }
  return window * window * falloff;
}
fn deepClusterIndex(fragmentCoordinate: vec2f, positionView: vec3f) -> u32 {
  let clusterCount = deepClusterParams.limits.y; let depth = -positionView.z;
  let viewport = deepClusterParams.grid0.xy;
  if (!(fragmentCoordinate.x >= 0.0 && fragmentCoordinate.y >= 0.0
    && fragmentCoordinate.x < f32(viewport.x) && fragmentCoordinate.y < f32(viewport.y)
    && depth >= deepClusterParams.projection.x && depth <= deepClusterParams.projection.y)) { return clusterCount; }
  let tileX = min(deepClusterParams.grid1.x - 1u, u32(floor(fragmentCoordinate.x)) / deepClusterParams.grid0.z);
  let tileY = min(deepClusterParams.grid1.y - 1u, u32(floor(fragmentCoordinate.y)) / deepClusterParams.grid0.w);
  let normalizedDepth = log(depth / deepClusterParams.projection.x)
    / log(deepClusterParams.projection.y / deepClusterParams.projection.x);
  let slice = min(deepClusterParams.grid1.z - 1u, u32(floor(normalizedDepth * f32(deepClusterParams.grid1.z))));
  return slice * deepClusterParams.grid1.x * deepClusterParams.grid1.y + tileY * deepClusterParams.grid1.x + tileX;
}
fn deepClusterPointContribution(light: PointLightAbi, positionView: vec3f, baseColor: vec3f,
  metallic: f32, roughness: f32, normal: vec3f, view: vec3f, dielectric: f32) -> vec3f {
  let toLight = light.positionRange.xyz - positionView; let distanceSquared = dot(toLight, toLight);
  let attenuation = deepClusterRangeAttenuation(distanceSquared, light.positionRange.w, light.radianceReserved.w + 2.0);
  if (attenuation <= 0.0) { return vec3f(0.0); }
  let surfaceToLight = deepClusterSafeNormalize(toLight, normal);
  return deepClusterBrdf(baseColor, metallic, roughness, normal, view, surfaceToLight, light.radianceReserved.rgb * attenuation, dielectric);
}
fn deepClusterSpotContribution(light: SpotLightAbi, spotIndex: u32, positionView: vec3f, worldPosition: vec3f, baseColor: vec3f,
  metallic: f32, roughness: f32, normal: vec3f, view: vec3f, receiveShadow: bool, dielectric: f32) -> vec3f {
  let toLight = light.positionRange.xyz - positionView; let distanceSquared = dot(toLight, toLight);
  let rangeAttenuation = deepClusterRangeAttenuation(distanceSquared, light.positionRange.w, light.attenuation.x);
  if (rangeAttenuation <= 0.0) { return vec3f(0.0); }
  let surfaceToLight = deepClusterSafeNormalize(toLight, normal);
  // E02：IES 光域网调制（无 ies 时恒等 1.0，乘法逐位不变）。无 ies 灯因子恒等,
  // attenuation * 1.0 与既有单表达式在 IEEE f32 下逐位一致,路径字节不变。
  var attenuation = rangeAttenuation * deepSpotAttenuation(light, surfaceToLight);
  attenuation = attenuation * deepSpotIesFactor(spotIndex, surfaceToLight, light.directionOuterCos.xyz);
  var visibility = 1.0;
  if (receiveShadow) { visibility = deepLocalSpotShadow(spotIndex, worldPosition, dot(normal, surfaceToLight)); }
  return deepClusterBrdf(baseColor, metallic, roughness, normal, view, surfaceToLight,
    light.radianceConeScale.rgb * attenuation * visibility, dielectric);
}

fn deepForwardPlusPbrReceivingF0(fragmentCoordinate: vec2f, positionViewInput: vec3f, normalViewInput: vec3f,
  worldPosition: vec3f, baseInput: vec3f, metallicInput: f32, roughnessInput: f32, receiveShadow: bool, dielectric: f32) -> vec3f {
  let baseColor = max(baseInput, vec3f(0.0)); let metallic = clamp(metallicInput, 0.0, 1.0);
  let roughness = clamp(roughnessInput, 0.045, 1.0);
  let normal = deepClusterSafeNormalize(normalViewInput, vec3f(0.0, 0.0, 1.0));
  let view = deepClusterSafeNormalize(-positionViewInput, vec3f(0.0, 0.0, 1.0));
  var result = vec3f(0.0);
  for (var directionalIndex = 0u; directionalIndex < deepClusterParams.limits.z; directionalIndex++) {
    let light = deepDirectionalLights[directionalIndex];
    let surfaceToLight = -light.directionIntensity.xyz;
    result += deepClusterBrdf(baseColor, metallic, roughness, normal, view, surfaceToLight,
      light.colorReserved.rgb * light.directionIntensity.w, dielectric);
  }
  let cluster = deepClusterIndex(fragmentCoordinate, positionViewInput);
  if (cluster < deepClusterParams.limits.y) {
    let header = deepClusterHeaders[cluster]; let count = min(header.count, deepClusterParams.limits.x);
    for (var slot = 0u; slot < count; slot++) {
      let localIndex = deepClusterLightIndices[header.offset + slot];
      if (localIndex < deepClusterParams.grid1.w) {
        if (localIndex < deepClusterParams.limits.w) {
          result += deepClusterPointContribution(deepPointLights[localIndex], positionViewInput, baseColor, metallic, roughness, normal, view, dielectric);
        } else {
          let spotIndex = localIndex - deepClusterParams.limits.w;
          result += deepClusterSpotContribution(deepSpotLights[spotIndex], spotIndex, positionViewInput,
            worldPosition, baseColor, metallic, roughness, normal, view, receiveShadow, dielectric);
        }
      }
    }
  }
  // C3 面积光:不参与聚簇,固定 ≤8 盏常驻循环(count=0 时零迭代,既有路径逐位不变)。
  // cookie 仅在 FLAG_TEXTURE 灯上采样(textureSampleLevel 显式 LOD,非均匀控制流合法)。
  for (var areaIndex = 0u; areaIndex < deepClusterParams.area.x; areaIndex++) {
    let base = areaIndex * DEEP_AREA_LIGHT_STRIDE;
    var cookie = vec3f(1.0);
    if ((u32(deepAreaLightData[base + 2u].w) & DEEP_AREA_LIGHT_FLAG_TEXTURE) != 0u) {
      cookie = textureSampleLevel(deepAreaCookie, deepAreaCookieSampler, deepAreaLightCookieUv(base, positionViewInput), 0.0).rgb;
    }
    result += deepAreaLightContribution(base, positionViewInput, normal, view, baseColor, metallic, roughness, dielectric, cookie);
  }
  return max(result, vec3f(0.0));
}

fn deepForwardPlusPbr(fragmentCoordinate: vec2f, positionViewInput: vec3f, normalViewInput: vec3f,
  worldPosition: vec3f, baseInput: vec3f, metallicInput: f32, roughnessInput: f32) -> vec3f {
  return deepForwardPlusPbrReceiving(fragmentCoordinate, positionViewInput, normalViewInput,
    worldPosition, baseInput, metallicInput, roughnessInput, true);
}

fn deepForwardPlusPbrWorldReceivingF0(fragmentCoordinate: vec2f, worldPosition: vec3f, worldNormal: vec3f,
  worldToView: mat4x4f, baseColor: vec3f, metallic: f32, roughness: f32, receiveShadow: bool, dielectric: f32) -> vec3f {
  let positionView = (worldToView * vec4f(worldPosition, 1.0)).xyz;
  let normalView = (worldToView * vec4f(worldNormal, 0.0)).xyz;
  return deepForwardPlusPbrReceivingF0(fragmentCoordinate, positionView, normalView, worldPosition, baseColor, metallic, roughness, receiveShadow, dielectric);
}

fn deepForwardPlusPbrWorld(fragmentCoordinate: vec2f, worldPosition: vec3f, worldNormal: vec3f,
  worldToView: mat4x4f, baseColor: vec3f, metallic: f32, roughness: f32) -> vec3f {
  return deepForwardPlusPbrWorldReceiving(fragmentCoordinate, worldPosition, worldNormal,
    worldToView, baseColor, metallic, roughness, true);
}

fn deepForwardPlusPbrReceiving(fragmentCoordinate: vec2f, positionViewInput: vec3f, normalViewInput: vec3f,
  worldPosition: vec3f, baseInput: vec3f, metallicInput: f32, roughnessInput: f32, receiveShadow: bool) -> vec3f {
  return deepForwardPlusPbrReceivingF0(fragmentCoordinate, positionViewInput, normalViewInput,
    worldPosition, baseInput, metallicInput, roughnessInput, receiveShadow, 0.04);
}
fn deepForwardPlusPbrWorldReceiving(fragmentCoordinate: vec2f, worldPosition: vec3f, worldNormal: vec3f,
  worldToView: mat4x4f, baseColor: vec3f, metallic: f32, roughness: f32, receiveShadow: bool) -> vec3f {
  return deepForwardPlusPbrWorldReceivingF0(fragmentCoordinate, worldPosition, worldNormal,
    worldToView, baseColor, metallic, roughness, receiveShadow, 0.04);
}
`;

const SINGLE_DIRECT_RETURN = "  return (diffuse + specular) * radiance * nDotL;";
const MULTIPLE_DIRECT_RETURN = `  var multiple = vec3f(0.0);
  if (any(radiance > vec3f(0.0))) {
    multiple = deepClusterDirectMultiscattering(nDotV, nDotL, roughness, f0);
  }
  return (diffuse + specular + multiple) * radiance * nDotL;`;

/** The formal host supplies canonical energy and its existing DFG resource. */
export function forwardPlusPbrLibrary(profile?: "direct-multiscattering"): string {
  if (profile === undefined) return FORWARD_PLUS_PBR_WGSL;
  if (profile !== "direct-multiscattering") throw Error("Unknown Forward+ material profile");
  if (FORWARD_PLUS_PBR_WGSL.split(SINGLE_DIRECT_RETURN).length !== 2) throw Error("Forward+ direct return seam drifted");
  return FORWARD_PLUS_PBR_WGSL.replace(SINGLE_DIRECT_RETURN, MULTIPLE_DIRECT_RETURN);
}

/** Adds the fixed group-3 Forward+ library to a renderer-owned WGSL module. */
export function composeForwardPlusPbrShader(shader: string, profile?: "direct-multiscattering"): string {
  if (!shader.trim()) throw new Error("Forward+ PBR renderer shader must not be empty.");
  const library = forwardPlusPbrLibrary(profile);
  if (profile && !shader.includes("fn deepClusterDirectMultiscattering(")) throw Error("Forward+ material host adapter missing");
  return `${library}\n${shader}`;
}
