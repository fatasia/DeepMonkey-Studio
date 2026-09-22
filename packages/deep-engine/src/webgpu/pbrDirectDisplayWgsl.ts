import { PBR_DIFFUSE_IRRADIANCE_WGSL } from "./pbrDiffuseIrradiance.js";

/** Lean plain-material presentation path: no motion history or unused interpolants. */
export const PBR_DIRECT_DISPLAY_WGSL = /* wgsl */ `
${PBR_DIFFUSE_IRRADIANCE_WGSL}
fn deepPrimaryShadow(world: vec3f, normal: vec3f, nDotL: f32, authorShadow: vec4f, pixel: vec2f, flags: f32) -> f32 {
  if (frame.background.w <= 0.0 || flag(flags, 16u)) { return 1.0; }
  if (deepCascade.params.w > 1.5) { return deepAuthorShadowVisibility(authorShadow, pixel); }
  return deepCascadedShadow(max(-(frame.worldToView * vec4f(world, 1.0)).z, 0.0), world, normal, nDotL);
}
struct DirectDisplayVertex {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f, @location(1) normal: vec3f,
  @location(2) @interpolate(flat) colorMetal: vec4f,
  @location(3) @interpolate(flat) material: vec4f,
  @location(4) @interpolate(flat) emissiveAlpha: vec4f,
  @location(5) authorShadow: vec4f,
  @location(6) @interpolate(flat) dielectric: f32,
};
@vertex fn vertexDirectDisplay(v: Input) -> DirectDisplayVertex {
  var out: DirectDisplayVertex; let p = vec4f(v.position, 1.0);
  out.world = vec3f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p));
  out.clip = frame.currentViewProjection * vec4f(out.world, 1.0);
  out.normal = safeNormalize(mat3x3f(v.normal0.xyz, v.normal1.xyz, v.normal2.xyz) * v.normal,
    vec3f(0.0, 1.0, 0.0));
  out.dielectric = deepDielectricF0(v.normal0.w); out.colorMetal = v.colorMetal; out.material = v.material; out.emissiveAlpha = v.emissiveAlpha;
  out.authorShadow = deepAuthorShadowCoordinate(out.world, out.normal);
  return out;
}
@vertex fn vertexMaterialDirectDisplay(v: Input) -> Vertex {
  var out: Vertex; let p = vec4f(v.position, 1.0);
  out.world = vec3f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p));
  out.clip = frame.currentViewProjection * vec4f(out.world, 1.0);
  out.normal = safeNormalize(mat3x3f(v.normal0.xyz, v.normal1.xyz, v.normal2.xyz) * v.normal,
    vec3f(0.0, 1.0, 0.0));
  out.dielectric = deepDielectricF0(v.normal0.w); out.colorMetal = v.colorMetal; out.material = v.material; out.uv0 = v.uvSets.xy;
  out.tangent = vec4f(1.0, 0.0, 0.0, v.material.z); out.emissiveAlpha = v.emissiveAlpha; out.uv1 = v.uvSets.zw;
  out.currentClip = out.clip; out.previousClip = out.clip; out.viewDepth = 0.0; out.authorShadow = deepAuthorShadowCoordinate(out.world, out.normal); return out;
}
@vertex fn vertexNormalMaterialDirectDisplay(v: TangentInput) -> Vertex {
  var out: Vertex; let p = vec4f(v.position, 1.0);
  out.world = vec3f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p));
  out.clip = frame.currentViewProjection * vec4f(out.world, 1.0);
  let n = safeNormalize(mat3x3f(v.normal0.xyz, v.normal1.xyz, v.normal2.xyz) * v.normal,
    vec3f(0.0, 1.0, 0.0));
  let rawTangent = vec3f(dot(v.row0.xyz, v.tangent.xyz), dot(v.row1.xyz, v.tangent.xyz), dot(v.row2.xyz, v.tangent.xyz));
  out.normal = n; out.tangent = vec4f(safeNormalize(rawTangent - n * dot(n, rawTangent), tangentFallback(n)),
    v.tangent.w * v.material.z);
  out.dielectric = deepDielectricF0(v.normal0.w); out.colorMetal = v.colorMetal; out.material = v.material; out.uv0 = v.uvSets.xy;
  out.emissiveAlpha = v.emissiveAlpha; out.uv1 = v.uvSets.zw;
  out.currentClip = out.clip; out.previousClip = out.clip; out.viewDepth = 0.0; out.authorShadow = deepAuthorShadowCoordinate(out.world, out.normal); return out;
}
@fragment fn fragmentMainDisplay(v: DirectDisplayVertex,
  @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  let ground = flag(v.material.w, 8u); let normal = orientedNormal(v.normal, v.material, frontFacing);
  let color = shade(v.clip.xy, v.world, normal, ground,
    v.colorMetal.rgb, v.colorMetal.w, v.material.x, 1.0, v.emissiveAlpha.rgb, v.authorShadow, v.material.w, v.dielectric);
  return vec4f(deepDisplayColor(color, frame.output), coverage(v.emissiveAlpha.w, v.material));
}
fn shadeDirectNoEffects(fragmentCoordinate: vec2f, world: vec3f, normalInput: vec3f, ground: bool,
  baseInput: vec3f, metalInput: f32, roughInput: f32, emissive: vec3f, authorShadow: vec4f, flags: f32, dielectric: f32) -> vec3f {
  let n = safeNormalize(normalInput, vec3f(0.0, 1.0, 0.0));
  let view = safeNormalize(frame.eye.xyz - world, vec3f(0.0, 0.0, 1.0));
  let l = safeNormalize(frame.lightDirection.xyz, vec3f(0.0, 1.0, 0.0));
  let metal = select(metalInput, 0.0, ground);
  let rough = min(1.0, select(clamp(roughInput, 0.06, 1.0), 0.9, ground) + deepGeometryRoughness(n));
  let base = select(baseInput, frame.floor.rgb, ground);
  let visibility = deepPrimaryShadow(world, n, dot(n, l), authorShadow, fragmentCoordinate, flags);
  var color = brdfWithDielectricF0(n, view, l, base, metal, rough, dielectric) * frame.sunColor.rgb * frame.sunColor.w * visibility;
  if (deepClusterParams.limits.z > 0u || deepClusterParams.grid1.w > 0u) {
    color += deepForwardPlusPbrWorldReceivingF0(fragmentCoordinate, world, n, frame.worldToView, base, metal, rough, !flag(flags, 16u), dielectric);
  }
  return select(color + deepAuthoredDiffuse(n, base, metal, 1.0) + select(emissive, vec3f(0.0), ground), baseInput, flag(flags, 64u));
}
fn deepSingleCascadeShadow(world: vec3f, normal: vec3f, nDotL: f32) -> f32 {
  let receiver = world + normal * deepCascade.texelWorld0.x
    * select(1.0 - clamp(nDotL, 0.0, 1.0), 1.0, deepCascade.params.w > 0.5);
  let clip = deepCascade.matrices[0] * vec4f(receiver, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0) { return 1.0; }
  let texel = deepCascade.params.z; let depth = ndc.z - deepCascade.params.y;
  var visibility = textureSampleCompareLevel(deepShadowMap, deepShadowSampler, uv + vec2f(-texel, -texel), 0, depth);
  visibility += textureSampleCompareLevel(deepShadowMap, deepShadowSampler, uv + vec2f(0.0, -texel), 0, depth);
  visibility += textureSampleCompareLevel(deepShadowMap, deepShadowSampler, uv + vec2f(texel, -texel), 0, depth);
  visibility += textureSampleCompareLevel(deepShadowMap, deepShadowSampler, uv + vec2f(-texel, 0.0), 0, depth);
  visibility += textureSampleCompareLevel(deepShadowMap, deepShadowSampler, uv, 0, depth);
  visibility += textureSampleCompareLevel(deepShadowMap, deepShadowSampler, uv + vec2f(texel, 0.0), 0, depth);
  visibility += textureSampleCompareLevel(deepShadowMap, deepShadowSampler, uv + vec2f(-texel, texel), 0, depth);
  visibility += textureSampleCompareLevel(deepShadowMap, deepShadowSampler, uv + vec2f(0.0, texel), 0, depth);
  visibility += textureSampleCompareLevel(deepShadowMap, deepShadowSampler, uv + vec2f(texel, texel), 0, depth);
  return visibility / 9.0;
}
@fragment fn fragmentMainDisplayNoEffects(v: DirectDisplayVertex,
  @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  let ground = flag(v.material.w, 8u); let normal = orientedNormal(v.normal, v.material, frontFacing);
  let color = shadeDirectNoEffects(v.clip.xy, v.world, normal, ground,
    v.colorMetal.rgb, v.colorMetal.w, v.material.x, v.emissiveAlpha.rgb, v.authorShadow, v.material.w, v.dielectric);
  return vec4f(deepDisplayColor(color, frame.output), coverage(v.emissiveAlpha.w, v.material));
}
@fragment fn fragmentMainDisplayNoEffectsOneCascade(v: DirectDisplayVertex,
  @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  let ground = flag(v.material.w, 8u);
  let n = safeNormalize(orientedNormal(v.normal, v.material, frontFacing), vec3f(0.0, 1.0, 0.0));
  var color = shadeDirectOneCascade(v.world, n, ground, v.colorMetal, v.material.x, v.emissiveAlpha.rgb, v.authorShadow, v.clip.xy, v.material.w, v.dielectric);
  let metal = select(v.colorMetal.w, 0.0, ground);
  let rough = min(1.0, select(clamp(v.material.x, 0.06, 1.0), 0.9, ground) + deepGeometryRoughness(n));
  let base = select(v.colorMetal.rgb, frame.floor.rgb, ground);
  if (deepClusterParams.limits.z > 0u || deepClusterParams.grid1.w > 0u) {
    color += deepForwardPlusPbrWorldReceivingF0(v.clip.xy, v.world, n, frame.worldToView, base, metal, rough, !flag(v.material.w, 16u), v.dielectric);
  }
  return vec4f(deepDisplayColor(select(color, v.colorMetal.rgb, flag(v.material.w, 64u)), frame.output), coverage(v.emissiveAlpha.w, v.material));
}
fn shadeDirectOneCascade(world: vec3f, n: vec3f, ground: bool, colorMetal: vec4f,
  roughInput: f32, emissive: vec3f, authorShadow: vec4f, pixel: vec2f, flags: f32, dielectric: f32) -> vec3f {
  let view = safeNormalize(frame.eye.xyz - world, vec3f(0.0, 0.0, 1.0));
  let l = safeNormalize(frame.lightDirection.xyz, vec3f(0.0, 1.0, 0.0));
  let metal = select(colorMetal.w, 0.0, ground);
  let rough = min(1.0, select(clamp(roughInput, 0.06, 1.0), 0.9, ground) + deepGeometryRoughness(n));
  let base = select(colorMetal.rgb, frame.floor.rgb, ground);
  let viewDepth = max(-(frame.worldToView * vec4f(world, 1.0)).z, 0.0);
  var visibility = 1.0;
  if (frame.background.w > 0.0 && !flag(flags, 16u)) {
    if (deepCascade.params.w > 1.5) { visibility = deepAuthorShadowVisibility(authorShadow, pixel); }
    else if (viewDepth <= deepCascade.splitDepths0.x) { visibility = deepSingleCascadeShadow(world, n, dot(n, l)); }
  }
  return select(brdfWithDielectricF0(n, view, l, base, metal, rough, dielectric) * frame.sunColor.rgb * frame.sunColor.w * visibility
    + deepAuthoredDiffuse(n, base, metal, 1.0) + select(emissive, vec3f(0.0), ground), colorMetal.rgb, flag(flags, 64u));
}
@fragment fn fragmentMainDisplayDirectional(v: DirectDisplayVertex,
  @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  let ground = flag(v.material.w, 8u);
  let n = safeNormalize(orientedNormal(v.normal, v.material, frontFacing), vec3f(0.0, 1.0, 0.0));
  let color = shadeDirectOneCascade(v.world, n, ground, v.colorMetal, v.material.x, v.emissiveAlpha.rgb, v.authorShadow, v.clip.xy, v.material.w, v.dielectric);
  return vec4f(deepDisplayColor(color, frame.output), coverage(v.emissiveAlpha.w, v.material));
}
`;
