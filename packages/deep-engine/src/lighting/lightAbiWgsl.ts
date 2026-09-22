export const FORWARD_PLUS_LIGHT_ABI_VERSION = 2;

/** Matches clusterPacking.ts. Radiance is color * intensity; spot scale is 1 / (innerCos - outerCos). */
export const FORWARD_PLUS_LIGHT_ABI_WGSL = /* wgsl */ `
struct DirectionalLightAbi {
  directionIntensity: vec4<f32>,
  colorReserved: vec4<f32>,
};
struct PointLightAbi {
  positionRange: vec4<f32>,
  radianceReserved: vec4<f32>,
};
struct SpotLightAbi {
  positionRange: vec4<f32>,
  directionOuterCos: vec4<f32>,
  radianceConeScale: vec4<f32>,
  attenuation: vec4<f32>,
};
fn deepSpotAttenuation(light: SpotLightAbi, surfaceToLightDirection: vec3<f32>) -> f32 {
  let coneCos = dot(-surfaceToLightDirection, light.directionOuterCos.xyz);
  if (light.radianceConeScale.w == 0.0) { return select(0.0, 1.0, coneCos >= light.directionOuterCos.w); }
  let coneWeight = clamp((coneCos - light.directionOuterCos.w) * light.radianceConeScale.w, 0.0, 1.0);
  return coneWeight * coneWeight * (3.0 - 2.0 * coneWeight);
}
`;
