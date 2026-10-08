/** Borrow the completed opaque source; no second scene render or mip pyramid. */
export const PBR_SCENE_TRANSMISSION_WGSL = /* wgsl */ `
@group(0) @binding(15) var deepSceneOpaqueColor: texture_2d<f32>;
fn deepSceneTransmissionSample(world: vec3f, normal: vec3f, view: vec3f,
  ior: f32, thickness: f32, roughness: f32) -> vec4f {
  let ray = refract(-view, normal, 1.0 / max(ior, 1.0));
  let exit = world + safeNormalize(ray, -view) * max(thickness, 0.0);
  let clip = frame.currentViewProjection * vec4f(exit, 1.0);
  if (clip.w <= 0.00000001) { return vec4f(0.0); }
  let uv = clipUv(clip);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec4f(0.0); }
  let size = vec2f(textureDimensions(deepSceneOpaqueColor));
  let halfTexel = 0.5 / size;
  let center = clamp(uv, halfTexel, vec2f(1.0) - halfTexel);
  let rough = clamp(roughness * clamp(ior * 2.0 - 2.0, 0.0, 1.0), 0.0, 1.0);
  if (rough <= 0.0001) {
    return vec4f(textureSampleLevel(deepSceneOpaqueColor, environmentSampler, center, 0.0).rgb, 1.0);
  }
  let radius = rough * rough * 32.0 / size;
  var color = vec3f(0.0);
  color += textureSampleLevel(deepSceneOpaqueColor, environmentSampler, clamp(center + vec2f(radius.x, 0.0), halfTexel, vec2f(1.0) - halfTexel), 0.0).rgb;
  color += textureSampleLevel(deepSceneOpaqueColor, environmentSampler, clamp(center - vec2f(radius.x, 0.0), halfTexel, vec2f(1.0) - halfTexel), 0.0).rgb;
  color += textureSampleLevel(deepSceneOpaqueColor, environmentSampler, clamp(center + vec2f(0.0, radius.y), halfTexel, vec2f(1.0) - halfTexel), 0.0).rgb;
  color += textureSampleLevel(deepSceneOpaqueColor, environmentSampler, clamp(center - vec2f(0.0, radius.y), halfTexel, vec2f(1.0) - halfTexel), 0.0).rgb;
  return vec4f(color * 0.25, 1.0);
}
`;
