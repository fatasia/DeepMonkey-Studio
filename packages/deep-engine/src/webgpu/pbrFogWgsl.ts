/** Composer fog mixes linear HDR; direct author frames mix after tone/display conversion. */
import { FOG_OPTICAL_DEPTH_WGSL } from "../fog/fogOpticalDepthWgsl.js";

export const PBR_FOG_WGSL = FOG_OPTICAL_DEPTH_WGSL + /* wgsl */ `
struct DeepFog { colorMode: vec4f, parameters: vec4f };
@group(0) @binding(8) var<uniform> deepFog: DeepFog;
fn deepApplyAuthorFogColor(color: vec3f, viewDepth: f32, fogColor: vec3f) -> vec3f {
  if (deepFog.colorMode.w < 0.5) { return color; }
  var factor = 0.0;
  if (deepFog.colorMode.w < 1.5) {
    factor = smoothstep(deepFog.parameters.x, deepFog.parameters.y, viewDepth);
  } else if (deepFog.colorMode.w < 2.5) {
    let opticalDepth = deepFog.parameters.z * viewDepth;
    factor = 1.0 - deepFogTransmittance(opticalDepth * opticalDepth);
  } else {
    let opticalDepth = deepFog.parameters.z * viewDepth;
    let stepDepth = opticalDepth / 8.0;
    var transmittance = 1.0;
    for (var step = 0; step < 8; step++) {
      transmittance *= deepFogTransmittance(stepDepth);
    }
    factor = 1.0 - transmittance;
  }
  return mix(color, fogColor, factor);
}
fn deepApplyAuthorFog(color: vec3f, viewDepth: f32) -> vec3f {
  return deepApplyAuthorFogColor(color, viewDepth, deepFog.colorMode.rgb);
}
fn deepApplySceneFog(color: vec3f, world: vec3f, materialFlags: f32) -> vec3f {
  if (deepFog.parameters.w > 0.5) {
    let output = DeepOutputSettings(frame.output.exposure, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0);
    let display = deepDisplayColor(color, output);
    if (flag(materialFlags, 32u)) { return display; }
    return deepApplyAuthorFogDisplay(display, -(frame.worldToView * vec4f(world, 1.0)).z);
  }
  if (flag(materialFlags, 32u)) { return color; }
  if (deepFog.colorMode.w < 4.5) { return deepApplyAuthorFog(color, -(frame.worldToView * vec4f(world, 1.0)).z); }
  if (frame.tuning.w <= 0.0) { return color; }
  let distance = length(frame.eye.xyz - world); let fog = 1.0 - deepFogTransmittance(pow(distance * frame.tuning.w, 2.0));
  return mix(color, frame.background.rgb, min(fog, 0.95));
}
fn deepApplyAuthorFogDisplay(color: vec3f, viewDepth: f32) -> vec3f {
  return deepApplyAuthorFogColor(color, viewDepth, deepLinearToSrgb(deepFog.colorMode.rgb));
}
`;
