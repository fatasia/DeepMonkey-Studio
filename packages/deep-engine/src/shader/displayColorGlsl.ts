/** C8 paired GLSL source. WGSL authority: wgsl/displayColor.wgsl; numerical drift is GPU-gated. */
export const DISPLAY_COLOR_GLSL = /* glsl */ `
struct DeepOutputSettings {
  float exposure; float bloom; float vignette; float toneMapping;
  float temperature; float tint; float contrast; float saturation;
};
vec3 deepLinearToSrgb(vec3 c) {
  return mix(1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    c * 12.92, lessThanEqual(c, vec3(0.0031308)));
}
vec3 deepThreeAcesFit(vec3 source, float exposure) {
  mat3 inputMatrix = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  mat3 outputMatrix = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602));
  vec3 value = inputMatrix * (source * exposure / 0.6);
  vec3 fitted = (value * (value + 0.0245786) - 0.000090537)
    / (value * (0.983729 * value + 0.4329510) + 0.238081);
  return clamp(outputMatrix * fitted, vec3(0.0), vec3(1.0));
}
vec3 deepApplyColorGrading(vec3 source, DeepOutputSettings settings) {
  vec3 color = clamp(source, vec3(0.0), vec3(65504.0));
  vec3 gains = vec3(1.0 + settings.temperature * 0.14 + settings.tint * 0.07,
    1.0 - settings.tint * 0.12, 1.0 - settings.temperature * 0.14 + settings.tint * 0.07);
  vec3 weights = vec3(0.2126, 0.7152, 0.0722); float sourceLuma = dot(color, weights);
  color *= gains; color *= sourceLuma / max(dot(color, weights), 0.000001);
  vec3 positive = max(color, vec3(0.0));
  vec3 contrasted = 0.18 * exp2(clamp(log2(max(positive / 0.18, vec3(0.000001)))
    * settings.contrast, vec3(-20.0), vec3(20.0)));
  color = mix(contrasted, vec3(0.0), lessThanEqual(positive, vec3(0.0)));
  float luma = dot(color, weights);
  return clamp(mix(vec3(luma), color, settings.saturation), vec3(0.0), vec3(65504.0));
}
vec3 deepDisplayColor(vec3 source, DeepOutputSettings settings) {
  vec3 color = source; float toneExposure = settings.exposure;
  if (settings.temperature != 0.0 || settings.tint != 0.0
    || settings.contrast != 1.0 || settings.saturation != 1.0) {
    color *= toneExposure; color = deepApplyColorGrading(color, settings); toneExposure = 1.0;
  }
  if (settings.toneMapping > 0.5) { color = deepThreeAcesFit(color, toneExposure); }
  else { color *= toneExposure;
    color = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14),
      vec3(0.0), vec3(1.0)); }
  return deepLinearToSrgb(color);
}
`;
