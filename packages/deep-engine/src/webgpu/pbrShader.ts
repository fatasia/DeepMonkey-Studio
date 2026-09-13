import { GROUND_ALBEDO_WGSL } from "./pbrGroundAlbedo.js";
import { WEIGHTED_OIT_FRAGMENT_WGSL } from "./weightedOitWgsl.js";
import { composeForwardPlusPbrShader } from "../lighting/clusterLightingPbrWgsl.js";
import { CASCADED_SHADOW_WGSL } from "../shadows/cascadedShadowShader.js";

/** 自研验证管线：GGX / Smith / Schlick，线性 HDR，中间过程不做显示编码。 */
export const sceneShaderCore = /* wgsl */ `
${WEIGHTED_OIT_FRAGMENT_WGSL}
struct Frame {
  currentViewProjection: mat4x4f, previousViewProjection: mat4x4f,
  worldToView: mat4x4f, light: mat4x4f,
  eye: vec4f, background: vec4f, floor: vec4f, lightDirection: vec4f, tuning: vec4f, sunColor: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(0) @binding(3) var specularEnvironment: texture_cube<f32>;
@group(0) @binding(4) var diffuseEnvironment: texture_cube<f32>;
@group(0) @binding(5) var brdfLut: texture_2d<f32>;
@group(0) @binding(6) var environmentSampler: sampler;
struct MaterialTextures {
  baseRow0: vec4f, baseRow1: vec4f, mrRow0: vec4f, mrRow1: vec4f,
  occlusionRow0: vec4f, occlusionRow1: vec4f,
  normalRow0: vec4f, normalRow1: vec4f,
  emissiveRow0: vec4f, emissiveRow1: vec4f,
};
@group(1) @binding(0) var baseColorMap: texture_2d<f32>;
@group(1) @binding(1) var baseColorSampler: sampler;
@group(1) @binding(2) var metallicRoughnessMap: texture_2d<f32>;
@group(1) @binding(3) var metallicRoughnessSampler: sampler;
@group(1) @binding(4) var<uniform> materialTextures: MaterialTextures;
@group(1) @binding(5) var occlusionMap: texture_2d<f32>;
@group(1) @binding(6) var occlusionSampler: sampler;
@group(1) @binding(7) var normalMap: texture_2d<f32>;
@group(1) @binding(8) var normalSampler: sampler;
@group(1) @binding(9) var emissiveMap: texture_2d<f32>;
@group(1) @binding(10) var emissiveSampler: sampler;
struct Input {
  @location(0) position: vec3f, @location(1) normal: vec3f,
  @location(2) row0: vec4f, @location(3) row1: vec4f, @location(4) row2: vec4f,
  @location(5) normal0: vec4f, @location(6) normal1: vec4f, @location(7) normal2: vec4f,
  @location(8) colorMetal: vec4f, @location(9) material: vec4f,
  @location(10) uvSets: vec4f, @location(12) emissiveAlpha: vec4f,
};
struct TangentInput {
  @location(0) position: vec3f, @location(1) normal: vec3f,
  @location(2) row0: vec4f, @location(3) row1: vec4f, @location(4) row2: vec4f,
  @location(5) normal0: vec4f, @location(6) normal1: vec4f, @location(7) normal2: vec4f,
  @location(8) colorMetal: vec4f, @location(9) material: vec4f,
  @location(10) uvSets: vec4f, @location(11) tangent: vec4f, @location(12) emissiveAlpha: vec4f,
};
struct Vertex {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f, @location(1) normal: vec3f,
  @location(2) colorMetal: vec4f, @location(3) material: vec4f, @location(4) uv0: vec2f,
  @location(5) tangent: vec4f, @location(6) emissiveAlpha: vec4f, @location(7) uv1: vec2f,
  @location(8) currentClip: vec4f, @location(9) previousClip: vec4f, @location(10) viewDepth: f32,
};
struct PreviousInstanceInput {
  @location(13) row0: vec4f, @location(14) row1: vec4f, @location(15) row2: vec4f,
};
fn flag(value: f32, bit: u32) -> bool { return (u32(round(value)) & bit) != 0u; }
fn safeNormalize(value: vec3f, fallback: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  let normalized = value * inverseSqrt(max(lengthSquared, 0.00000001));
  return select(fallback, normalized, lengthSquared > 0.00000001);
}
fn tangentFallback(normal: vec3f) -> vec3f {
  let axis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(normal.x) > 0.9);
  return safeNormalize(cross(axis, normal), vec3f(0.0, 0.0, 1.0));
}
@vertex fn vertexMain(v: Input, previous: PreviousInstanceInput) -> Vertex {
  var out: Vertex;
  let p = vec4f(v.position, 1.0);
  out.world = vec3f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p));
  out.clip = frame.currentViewProjection * vec4f(out.world, 1.0); out.currentClip = out.clip;
  let previousWorld = vec3f(dot(previous.row0, p), dot(previous.row1, p), dot(previous.row2, p));
  out.previousClip = frame.previousViewProjection * vec4f(previousWorld, 1.0);
  out.viewDepth = max(-(frame.worldToView * vec4f(out.world, 1.0)).z, 0.0);
  out.normal = safeNormalize(mat3x3f(v.normal0.xyz, v.normal1.xyz, v.normal2.xyz) * v.normal, vec3f(0.0, 1.0, 0.0));
  out.tangent = vec4f(1.0, 0.0, 0.0, v.material.z);
  out.colorMetal = v.colorMetal; out.material = v.material; out.uv0 = v.uvSets.xy; out.uv1 = v.uvSets.zw; out.emissiveAlpha = v.emissiveAlpha;
  return out;
}
@vertex fn vertexNormalMapped(v: TangentInput, previous: PreviousInstanceInput) -> Vertex {
  var out: Vertex;
  let p = vec4f(v.position, 1.0);
  out.world = vec3f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p));
  out.clip = frame.currentViewProjection * vec4f(out.world, 1.0); out.currentClip = out.clip;
  let previousWorld = vec3f(dot(previous.row0, p), dot(previous.row1, p), dot(previous.row2, p));
  out.previousClip = frame.previousViewProjection * vec4f(previousWorld, 1.0);
  out.viewDepth = max(-(frame.worldToView * vec4f(out.world, 1.0)).z, 0.0);
  let n = safeNormalize(mat3x3f(v.normal0.xyz, v.normal1.xyz, v.normal2.xyz) * v.normal, vec3f(0.0, 1.0, 0.0));
  let rawTangent = vec3f(dot(v.row0.xyz, v.tangent.xyz), dot(v.row1.xyz, v.tangent.xyz), dot(v.row2.xyz, v.tangent.xyz));
  out.normal = n;
  out.tangent = vec4f(safeNormalize(rawTangent - n * dot(n, rawTangent), tangentFallback(n)), v.tangent.w * v.material.z);
  out.colorMetal = v.colorMetal; out.material = v.material; out.uv0 = v.uvSets.xy; out.uv1 = v.uvSets.zw; out.emissiveAlpha = v.emissiveAlpha;
  return out;
}
@vertex fn shadowMain(v: Input) -> @builtin(position) vec4f {
  let p = vec4f(v.position, 1.0);
  return frame.light * vec4f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p), 1.0);
}
struct ShadowVertex {
  @builtin(position) clip: vec4f, @location(0) uv0: vec2f, @location(1) uv1: vec2f, @location(2) alphaCutoff: vec2f,
};
@vertex fn shadowMaskMain(v: Input) -> ShadowVertex {
  var out: ShadowVertex; let p = vec4f(v.position, 1.0);
  out.clip = frame.light * vec4f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p), 1.0);
  out.uv0 = v.uvSets.xy; out.uv1 = v.uvSets.zw; out.alphaCutoff = vec2f(v.emissiveAlpha.w, v.material.y); return out;
}
@fragment fn shadowMaskPlain(v: ShadowVertex) { if (v.alphaCutoff.x < v.alphaCutoff.y) { discard; } }
@fragment fn shadowMaskTextured(v: ShadowVertex) {
  let uv = vec3f(select(v.uv0, v.uv1, materialTextures.baseRow0.w > 1.5), 1.0);
  let baseUv = vec2f(dot(materialTextures.baseRow0.xyz, uv), dot(materialTextures.baseRow1.xyz, uv));
  var sampledAlpha = 1.0;
  if (materialTextures.baseRow0.w > 0.5) { sampledAlpha = textureSample(baseColorMap, baseColorSampler, baseUv).a; }
  if (v.alphaCutoff.x * sampledAlpha < v.alphaCutoff.y) { discard; }
}
fn fresnel(cosine: f32, f0: vec3f) -> vec3f { return f0 + (1.0 - f0) * pow(1.0 - cosine, 5.0); }
fn brdf(n: vec3f, v: vec3f, l: vec3f, base: vec3f, metal: f32, rough: f32) -> vec3f {
  let h = safeNormalize(v + l, n); let nv = clamp(dot(n, v), 0.0001, 1.0); let nl = clamp(dot(n, l), 0.0, 1.0);
  let nh = clamp(dot(n, h), 0.0, 1.0); let vh = clamp(dot(v, h), 0.0, 1.0);
  let alpha = rough * rough; let a2 = alpha * alpha; let denom = nh * nh * (a2 - 1.0) + 1.0;
  let distribution = a2 / max(3.14159265 * denom * denom, 0.000001);
  let k = (rough + 1.0) * (rough + 1.0) / 8.0;
  let geometry = (nv / (nv * (1.0 - k) + k)) * (nl / max(nl * (1.0 - k) + k, 0.0001));
  let f = fresnel(vh, mix(vec3f(0.04), base, metal));
  let specular = distribution * geometry * f / max(4.0 * nv * nl, 0.0001);
  return ((1.0 - f) * (1.0 - metal) * base / 3.14159265 + specular) * nl;
}
fn orientedNormal(normalInput: vec3f, material: vec4f, frontFacing: bool) -> vec3f {
  let gltfFront = select(!frontFacing, frontFacing, material.z > 0.0);
  let reverseBackFace = flag(material.w, 1u) && !gltfFront;
  return safeNormalize(select(normalInput, -normalInput, reverseBackFace), vec3f(0.0, 1.0, 0.0));
}
${GROUND_ALBEDO_WGSL}
fn shade(fragmentCoordinate: vec2f, world: vec3f, normalInput: vec3f, ground: bool, baseInput: vec3f, metalInput: f32,
  roughInput: f32, occlusionInput: f32, emissive: vec3f) -> vec3f {
  let n = safeNormalize(normalInput, vec3f(0.0, 1.0, 0.0));
  let view = safeNormalize(frame.eye.xyz - world, vec3f(0.0, 0.0, 1.0));
  let l = safeNormalize(frame.lightDirection.xyz, vec3f(0.0, 1.0, 0.0));
  let metal = select(metalInput, 0.0, ground); let rough = select(clamp(roughInput, 0.06, 1.0), 0.9, ground);
  let gridDistance = abs(fract(world.xz / 2.4 - 0.5) - 0.5) / max(fwidth(world.xz / 2.4), vec2f(0.0001));
  let grid = (1.0 - min(min(gridDistance.x, gridDistance.y), 1.0)) * exp(-length(world.xz) * 0.06) * frame.floor.w;
  let base = groundGridAlbedo(select(baseInput, frame.floor.rgb, ground), grid, ground);
  let visibility = deepCascadedShadow(max(-(frame.worldToView * vec4f(world, 1.0)).z, 0.0), world, n, dot(n, l));
  var color = brdf(n, view, l, base, metal, rough) * frame.sunColor.rgb * frame.sunColor.w * visibility;
  color += deepForwardPlusPbrWorld(fragmentCoordinate, world, n, frame.worldToView, base, metal, rough);
  let nv = clamp(dot(n, view), 0.001, 1.0); let f0 = mix(vec3f(0.04), base, metal);
  let f = f0 + (max(vec3f(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
  let irradiance = textureSampleLevel(diffuseEnvironment, environmentSampler, n, 0.0).rgb;
  let occlusion = clamp(occlusionInput, 0.0, 1.0);
  color += (1.0 - f) * (1.0 - metal) * base * irradiance * occlusion * frame.eye.w;
  let reflection = reflect(-view, n);
  let maxSpecularLod = f32(textureNumLevels(specularEnvironment) - 1u);
  let radiance = textureSampleLevel(specularEnvironment, environmentSampler, reflection, rough * maxSpecularLod).rgb;
  let dfg = textureSampleLevel(brdfLut, environmentSampler, vec2f(nv, rough), 0.0).rg;
  let energyCompensation = vec3f(1.0) + f0 * (1.0 / max(dfg.x + dfg.y, 0.05) - 1.0);
  color += radiance * (f0 * dfg.x + dfg.y) * energyCompensation * occlusion * frame.eye.w;
  color += select(emissive, vec3f(0.0), ground);
  let distance = length(frame.eye.xyz - world); let fog = 1.0 - exp(-pow(distance * frame.tuning.w, 2.0));
  return mix(color, frame.background.rgb, min(fog, 0.95));
}
fn coverage(alpha: f32, material: vec4f) -> f32 {
  if (flag(material.w, 2u) && alpha < material.y) { discard; }
  return select(1.0, alpha, flag(material.w, 4u));
}
fn slotUv(uv0: vec2f, uv1: vec2f, row0: vec4f, row1: vec4f) -> vec2f {
  let uv = vec3f(select(uv0, uv1, row0.w > 1.5), 1.0);
  return vec2f(dot(row0.xyz, uv), dot(row1.xyz, uv));
}
struct GeometryOutput {
  @location(0) color: vec4f, @location(1) viewDepth: f32,
  @location(2) viewNormal: vec4f, @location(3) motion: vec2f,
};
fn clipUv(clip: vec4f) -> vec2f {
  let safeW = select(-max(abs(clip.w), 0.00000001), max(abs(clip.w), 0.00000001), clip.w >= 0.0);
  return clip.xy / safeW * vec2f(0.5, -0.5) + 0.5;
}
fn geometryOutput(v: Vertex, color: vec4f, worldNormal: vec3f) -> GeometryOutput {
  var out: GeometryOutput; out.color = color; out.viewDepth = v.viewDepth;
  let viewNormal = safeNormalize((frame.worldToView * vec4f(worldNormal, 0.0)).xyz, vec3f(0.0, 0.0, 1.0));
  out.viewNormal = vec4f(viewNormal * 0.5 + 0.5, 0.0);
  let projectionJitterDeltaUv = frame.tuning.xy;
  out.motion = clamp(clipUv(v.previousClip) - clipUv(v.currentClip) - projectionJitterDeltaUv, vec2f(-2.0), vec2f(2.0)); return out;
}
@fragment fn fragmentMain(v: Vertex, @builtin(front_facing) frontFacing: bool) -> GeometryOutput {
  let ground = flag(v.material.w, 8u);
  let normal = orientedNormal(v.normal, v.material, frontFacing);
  let color = shade(v.clip.xy, v.world, normal, ground,
    v.colorMetal.rgb, v.colorMetal.w, v.material.x, 1.0, v.emissiveAlpha.rgb);
  return geometryOutput(v, vec4f(color, coverage(v.emissiveAlpha.w, v.material)), normal);
}
@fragment fn fragmentMainTransparent(v: Vertex, @builtin(front_facing) frontFacing: bool) -> DeepWeightedOitOutput {
  let ground = flag(v.material.w, 8u); let normal = orientedNormal(v.normal, v.material, frontFacing);
  let color = shade(v.clip.xy, v.world, normal, ground, v.colorMetal.rgb, v.colorMetal.w, v.material.x, 1.0, v.emissiveAlpha.rgb);
  let depth = clamp(v.clip.z, 0.0, 1.0);
  return deepWeightedOit(color, coverage(v.emissiveAlpha.w, v.material), depth);
}
struct SurfaceSample { base: vec3f, metal: f32, rough: f32, alpha: f32, occlusion: f32, emissive: vec3f };
fn sampleSurface(v: Vertex) -> SurfaceSample {
  let baseUv = slotUv(v.uv0, v.uv1, materialTextures.baseRow0, materialTextures.baseRow1);
  let mrUv = slotUv(v.uv0, v.uv1, materialTextures.mrRow0, materialTextures.mrRow1);
  var baseSample = vec4f(1.0); var mrSample = vec4f(1.0); var occlusion = 1.0; var emission = vec3f(1.0);
  if (materialTextures.baseRow0.w > 0.5) { baseSample = textureSample(baseColorMap, baseColorSampler, baseUv); }
  if (materialTextures.mrRow0.w > 0.5) { mrSample = textureSample(metallicRoughnessMap, metallicRoughnessSampler, mrUv); }
  if (materialTextures.occlusionRow0.w > 0.5) {
    let aoUv = slotUv(v.uv0, v.uv1, materialTextures.occlusionRow0, materialTextures.occlusionRow1);
    let sampled = textureSample(occlusionMap, occlusionSampler, aoUv).r;
    occlusion = 1.0 + materialTextures.occlusionRow1.w * (sampled - 1.0);
  }
  if (materialTextures.emissiveRow0.w > 0.5) {
    let emissiveUv = slotUv(v.uv0, v.uv1, materialTextures.emissiveRow0, materialTextures.emissiveRow1);
    emission = textureSample(emissiveMap, emissiveSampler, emissiveUv).rgb;
  }
  return SurfaceSample(v.colorMetal.rgb * baseSample.rgb, v.colorMetal.w * mrSample.b,
    v.material.x * mrSample.g, v.emissiveAlpha.w * baseSample.a, occlusion,
    v.emissiveAlpha.rgb * emission * materialTextures.emissiveRow1.w);
}
fn mappedNormal(v: Vertex, frontFacing: bool) -> vec3f {
  let normalUv = slotUv(v.uv0, v.uv1, materialTextures.normalRow0, materialTextures.normalRow1);
  let n = orientedNormal(v.normal, v.material, frontFacing);
  let sourceTangent = safeNormalize(v.tangent.xyz - n * dot(n, v.tangent.xyz), tangentFallback(n));
  let sourceBitangent = cross(n, sourceTangent) * v.tangent.w;
  let determinant = materialTextures.normalRow0.x * materialTextures.normalRow1.y - materialTextures.normalRow0.y * materialTextures.normalRow1.x;
  let determinantSign = select(-1.0, 1.0, determinant >= 0.0);
  let tangent = safeNormalize((sourceTangent * materialTextures.normalRow1.y - sourceBitangent * materialTextures.normalRow1.x) * determinantSign, tangentFallback(n));
  let bitangent = cross(n, tangent) * v.tangent.w * determinantSign;
  let sampled = textureSample(normalMap, normalSampler, normalUv).rgb * 2.0 - 1.0;
  let tangentNormal = safeNormalize(vec3f(sampled.xy * materialTextures.normalRow1.w, sampled.z), vec3f(0.0, 0.0, 1.0));
  return safeNormalize(tangent * tangentNormal.x + bitangent * tangentNormal.y + n * tangentNormal.z, n);
}
@fragment fn fragmentMaterial(v: Vertex, @builtin(front_facing) frontFacing: bool) -> GeometryOutput {
  let surface = sampleSurface(v); var normal = orientedNormal(v.normal, v.material, frontFacing);
  if (materialTextures.normalRow0.w > 0.5) { normal = mappedNormal(v, frontFacing); }
  let color = shade(v.clip.xy, v.world, normal, false, surface.base, surface.metal, surface.rough, surface.occlusion, surface.emissive);
  return geometryOutput(v, vec4f(color, coverage(surface.alpha, v.material)), normal);
}
@fragment fn fragmentMaterialTransparent(v: Vertex, @builtin(front_facing) frontFacing: bool) -> DeepWeightedOitOutput {
  let surface = sampleSurface(v); var normal = orientedNormal(v.normal, v.material, frontFacing);
  if (materialTextures.normalRow0.w > 0.5) { normal = mappedNormal(v, frontFacing); }
  let color = shade(v.clip.xy, v.world, normal, false, surface.base, surface.metal, surface.rough, surface.occlusion, surface.emissive);
  let depth = clamp(v.clip.z, 0.0, 1.0);
  return deepWeightedOit(color, coverage(surface.alpha, v.material), depth);
}
`;

/** Ready-to-compile default module with the fixed Forward+ group-3 library. */
export const sceneShader = composeForwardPlusPbrShader(`${CASCADED_SHADOW_WGSL}\n${sceneShaderCore}`);

export const outputShader = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
struct OutputSettings { exposure: f32, bloom: f32, vignette: f32, pad: f32 };
@group(0) @binding(2) var<uniform> settings: OutputSettings;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> Vertex {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: Vertex; out.position = vec4f(positions[i], 0.0, 1.0);
  out.uv = positions[i] * vec2f(0.5, -0.5) + 0.5; return out;
}
fn linearToSrgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}
fn threeAcesFit(source: vec3f, exposure: f32) -> vec3f {
  let input = mat3x3f(vec3f(0.59719, 0.07600, 0.02840), vec3f(0.35458, 0.90834, 0.13383),
    vec3f(0.04823, 0.01566, 0.83777));
  let output = mat3x3f(vec3f(1.60475, -0.10208, -0.00327), vec3f(-0.53108, 1.10813, -0.07276),
    vec3f(-0.07367, -0.00605, 1.07602));
  let value = input * (source * exposure / 0.6);
  let fitted = (value * (value + 0.0245786) - 0.000090537)
    / (value * (0.983729 * value + 0.4329510) + 0.238081);
  return clamp(output * fitted, vec3f(0.0), vec3f(1.0));
}
@fragment fn fragmentMain(v: Vertex) -> @location(0) vec4f {
  var color = textureSample(source, sourceSampler, v.uv).rgb;
  let radial = dot(v.uv - 0.5, v.uv - 0.5);
  color *= 1.0 - settings.vignette * smoothstep(0.05, 0.5, radial);
  if (settings.pad > 0.5) { color = threeAcesFit(color, settings.exposure); }
  else { color *= settings.exposure;
    color = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), vec3f(0.0), vec3f(1.0)); }
  return vec4f(linearToSrgb(color), 1.0);
}
`;

/** CPU contract mirror used by camera-history integration tests and diagnostics. */
export function currentToPreviousUvMotion(currentClip: readonly number[], previousClip: readonly number[], jitterDeltaUv: readonly [number, number] = [0, 0]): readonly [number, number] {
  if (currentClip.length !== 4 || previousClip.length !== 4 || ![...currentClip, ...previousClip].every(Number.isFinite)
    || !jitterDeltaUv.every(Number.isFinite) || Math.abs(currentClip[3]!) < 1e-8 || Math.abs(previousClip[3]!) < 1e-8) throw new Error("Motion clip positions are invalid.");
  const uv = (clip: readonly number[]): readonly [number, number] => [
    clip[0]! / clip[3]! * 0.5 + 0.5, clip[1]! / clip[3]! * -0.5 + 0.5,
  ];
  const current = uv(currentClip), previous = uv(previousClip);
  return Object.freeze([Math.max(-2, Math.min(2, previous[0] - current[0] - jitterDeltaUv[0])),
    Math.max(-2, Math.min(2, previous[1] - current[1] - jitterDeltaUv[1]))]);
}
