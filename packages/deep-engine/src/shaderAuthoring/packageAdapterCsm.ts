import type { DeepWgslModuleDescriptor } from "../shader/types.js";
import { exactlyOnce } from "./packageAdapterWgslContract.js";

/** Byte-for-byte layout and sampling equations match native_cascaded_shadow_v1.wgsl. */
export const DEEP_PACKAGE_CSM_WGSL = /* wgsl */ `
struct DeepCascadedShadowData {
  matrices: array<mat4x4f, 4>,
  split_depths: vec4f,
  blend_starts: vec4f,
  texel_world: vec4f,
  params: vec4f,
  camera_forward: vec4f,
};
@group(0) @binding(7) var<uniform> deepCascadedShadow: DeepCascadedShadowData;
fn deepCascadeIndex(viewDepth: f32) -> u32 {
  let count = clamp(u32(deepCascadedShadow.params.x), 1u, 4u);
  for (var index = 0u; index < count; index++) {
    if (viewDepth <= deepCascadedShadow.split_depths[index]) { return index; }
  }
  return count - 1u;
}
fn deepSampleCascade(index: u32, world: vec3f, normal: vec3f, nDotL: f32) -> f32 {
  let receiver = world + normal * deepCascadedShadow.texel_world[index] * (1.0 - clamp(nDotL, 0.0, 1.0));
  let clip = deepCascadedShadow.matrices[index] * vec4f(receiver, 1.0);
  let projected = clip.xyz / clip.w;
  let uv = projected.xy * vec2f(0.5, -0.5) + 0.5;
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && projected.z >= 0.0 && projected.z <= 1.0;
  if (!inside) { return 1.0; }
  var visibility = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      visibility += textureSampleCompareLevel(deepShadowMap, deepShadowSampler,
        uv + vec2f(f32(x), f32(y)) * deepCascadedShadow.params.z,
        i32(index), projected.z - deepCascadedShadow.params.y);
    }
  }
  return visibility / 9.0;
}
fn deepShadowVisibility(world: vec3f, normal: vec3f, nDotL: f32) -> f32 {
  let count = clamp(u32(deepCascadedShadow.params.x), 1u, 4u);
  let viewDepth = dot(world - deepPbrFrame.eye.xyz, deepCascadedShadow.camera_forward.xyz);
  if (viewDepth > deepCascadedShadow.split_depths[count - 1u]) { return 1.0; }
  let index = deepCascadeIndex(viewDepth);
  let current = deepSampleCascade(index, world, normal, nDotL);
  if (index + 1u >= count) { return current; }
  let blendStart = deepCascadedShadow.blend_starts[index];
  let split = deepCascadedShadow.split_depths[index];
  return mix(current, deepSampleCascade(index + 1u, world, normal, nDotL), smoothstep(blendStart, split, viewDepth));
}
`;

export function adaptCsmWgsl(module: DeepWgslModuleDescriptor): DeepWgslModuleDescriptor | undefined {
  const declaration = "@group(0) @binding(1) var deepShadowMap: texture_depth_2d;";
  const start = "fn deepShadowVisibility(worldPosition: vec3f, nDotL: f32) -> f32 {";
  const next = "fn deepLowerStandardPbr(";
  const call = "deepShadowVisibility(worldPosition, nDotL)";
  if (![declaration, start, next, call].every(token => exactlyOnce(module.code, token))) return undefined;
  const from = module.code.indexOf(start), to = module.code.indexOf(next);
  if (to <= from) return undefined;
  // Keep graph/source-map line positions intact; append the new declarations after existing entry points.
  const gap = "\n".repeat(module.code.slice(from, to).split("\n").length - 1);
  const code = (module.code.slice(0, from) + gap + module.code.slice(to))
    .replace(declaration, declaration.replace("texture_depth_2d", "texture_depth_2d_array"))
    .replace(call, "deepShadowVisibility(worldPosition, normal, nDotL)") + DEEP_PACKAGE_CSM_WGSL;
  return Object.freeze({ label: module.label.replace("deep-pbr-mesh-v1", "deep-pbr-mesh-v2"), code });
}
