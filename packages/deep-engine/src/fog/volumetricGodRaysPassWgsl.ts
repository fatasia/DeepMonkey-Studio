import { VOLUMETRIC_GOD_RAYS_MARCH_WGSL, DEEP_GOD_RAYS_PARAMS_BYTES } from "../lighting/volumetricGodRaysWgsl.js";
import { CASCADED_SHADOW_WGSL } from "../shadows/cascadedShadowShader.js";

export const GOD_RAYS_HOST_PARAMETER_BYTES = DEEP_GOD_RAYS_PARAMS_BYTES + 64;
const start = VOLUMETRIC_GOD_RAYS_MARCH_WGSL.indexOf("fn shadowVisibility(");
const end = VOLUMETRIC_GOD_RAYS_MARCH_WGSL.indexOf("@group(0)", start);
if (start < 0 || end < start) throw new Error("Canonical god-rays shadow hook is missing.");
const hook = /* wgsl */ `fn shadowVisibility(viewPosition: vec3f) -> f32 {
  if (godRaysParams.tuning.y == 0u) { return 1.0; }
  let count = clamp(u32(deepCascade.params.x), 1u, DEEP_MAX_CASCADES);
  let depth = -viewPosition.z;
  let far = deepCascadeValue(deepCascade.splitDepths0, deepCascade.splitDepths1, count - 1u);
  if (depth > far) { return 1.0; }
  let index = deepCascadeIndex(depth);
  let world = godRaysParams.viewToWorld * vec4f(viewPosition, 1.0);
  let clip = deepCascade.matrices[index] * world;
  if (abs(clip.w) <= 0.000001) { return 1.0; }
  let ndc = clip.xyz / clip.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0) { return 1.0; }
  let dimensions = textureDimensions(deepShadowMap);
  let texel = clamp(vec2i(floor(uv * vec2f(dimensions))), vec2i(0), vec2i(dimensions) - vec2i(1));
  let stored = textureLoad(deepShadowMap, texel, i32(index), 0);
  let authored = deepCascade.params.w > 1.5;
  let bias = select(-deepCascade.params.y, deepCascade.params.y, authored);
  let visible = select(0.0, 1.0, ndc.z + bias <= stored);
  return select(visible, mix(1.0, visible, deepCascade.texelWorld1.y), authored);
}
`;
/** Canonical march is unchanged; only the shadow hook/bindings adapt to the existing real CSM. */
export const VOLUMETRIC_GOD_RAYS_CSM_WGSL = CASCADED_SHADOW_WGSL.replaceAll("@group(2)", "@group(1)")
  + (VOLUMETRIC_GOD_RAYS_MARCH_WGSL.slice(0, start) + hook + VOLUMETRIC_GOD_RAYS_MARCH_WGSL.slice(end))
    .replace("tuning: vec4<u32>,", "tuning: vec4<u32>,\n  viewToWorld: mat4x4f,")
    .replace("@group(0) @binding(1) var shadowMap: texture_2d<f32>;", "");
