export const PBR_DISPLAY_COLOR_WGSL = /* wgsl */ `
struct DeepOutputSettings {
  exposure: f32, bloom: f32, vignette: f32, toneMapping: f32,
  temperature: f32, tint: f32, contrast: f32, saturation: f32,
};
fn deepLinearToSrgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055, c * 12.92,
    c <= vec3f(0.0031308));
}
fn deepThreeAcesFit(source: vec3f, exposure: f32) -> vec3f {
  let input = mat3x3f(vec3f(0.59719, 0.07600, 0.02840), vec3f(0.35458, 0.90834, 0.13383),
    vec3f(0.04823, 0.01566, 0.83777));
  let output = mat3x3f(vec3f(1.60475, -0.10208, -0.00327), vec3f(-0.53108, 1.10813, -0.07276),
    vec3f(-0.07367, -0.00605, 1.07602));
  let value = input * (source * exposure / 0.6);
  let fitted = (value * (value + 0.0245786) - 0.000090537)
    / (value * (0.983729 * value + 0.4329510) + 0.238081);
  return clamp(output * fitted, vec3f(0.0), vec3f(1.0));
}
fn deepApplyColorGrading(source: vec3f, settings: DeepOutputSettings) -> vec3f {
  var color = clamp(source, vec3f(0.0), vec3f(65504.0));
  let gains = vec3f(1.0 + settings.temperature * 0.14 + settings.tint * 0.07,
    1.0 - settings.tint * 0.12, 1.0 - settings.temperature * 0.14 + settings.tint * 0.07);
  let weights = vec3f(0.2126, 0.7152, 0.0722); let sourceLuma = dot(color, weights);
  color *= gains; color *= sourceLuma / max(dot(color, weights), 0.000001);
  let positive = max(color, vec3f(0.0));
  let contrasted = 0.18 * exp2(clamp(log2(max(positive / 0.18, vec3f(0.000001)))
    * settings.contrast, vec3f(-20.0), vec3f(20.0)));
  color = select(contrasted, vec3f(0.0), positive <= vec3f(0.0));
  let luma = dot(color, weights);
  return clamp(mix(vec3f(luma), color, settings.saturation), vec3f(0.0), vec3f(65504.0));
}
fn deepDisplayColor(source: vec3f, settings: DeepOutputSettings) -> vec3f {
  var color = source; var toneExposure = settings.exposure;
  if (settings.temperature != 0.0 || settings.tint != 0.0
    || settings.contrast != 1.0 || settings.saturation != 1.0) {
    color *= toneExposure; color = deepApplyColorGrading(color, settings); toneExposure = 1.0;
  }
  if (settings.toneMapping > 0.5) { color = deepThreeAcesFit(color, toneExposure); }
  else { color *= toneExposure;
    color = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14),
      vec3f(0.0), vec3f(1.0)); }
  return deepLinearToSrgb(color);
}
`;
