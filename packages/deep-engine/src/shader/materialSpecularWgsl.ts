/** Advanced-only dielectric specular state; private globals belong to one fragment invocation. */
export const SPECULAR_MATERIAL_WGSL = /* wgsl */ `
@group(1) @binding(16) var deepSpecularMap: texture_2d<f32>;
@group(1) @binding(17) var deepSpecularSampler: sampler;
@group(1) @binding(18) var deepSpecularColorMap: texture_2d<f32>;
@group(1) @binding(19) var deepSpecularColorSampler: sampler;
var<private> deepAdvSpecularActive: bool;
var<private> deepAdvSpecularColor: vec3f;
var<private> deepAdvSpecularFactor: f32;
var<private> deepAdvSpecularF90: f32;
fn deepAdvCurrentSpecularF90() -> f32 { return select(1.0, deepAdvSpecularF90, deepAdvSpecularActive); }
fn deepAdvMaterialF0(base: vec3f, metal: f32, dielectric: f32) -> vec3f {
  if (!deepAdvSpecularActive) { return mix(vec3f(dielectric), base, metal); }
  let dielectricColor = min(vec3f(dielectric) * deepAdvSpecularColor, vec3f(1.0)) * deepAdvSpecularFactor;
  return mix(dielectricColor, base, metal);
}
fn deepAdvSampleSpecular(v: Vertex, metal: f32) {
  let parameters = materialTextures.specularParameters;
  var factor = parameters.w;
  var color = parameters.xyz;
  if (materialTextures.specularRow0.w > 0.5) {
    let uv = slotUv(v.uv0, v.uv1, materialTextures.specularRow0, materialTextures.specularRow1);
    factor *= textureSample(deepSpecularMap, deepSpecularSampler, uv).a;
  }
  if (materialTextures.specularColorRow0.w > 0.5) {
    let uv = slotUv(v.uv0, v.uv1, materialTextures.specularColorRow0, materialTextures.specularColorRow1);
    color *= textureSample(deepSpecularColorMap, deepSpecularColorSampler, uv).rgb;
  }
  deepAdvSpecularActive = factor != 1.0 || any(color != vec3f(1.0));
  deepAdvSpecularColor = color;
  deepAdvSpecularFactor = factor;
  deepAdvSpecularF90 = mix(factor, 1.0, metal);
}
`;

/** Patch only the optional advanced variant; shared Native/stock WGSL remains unchanged. */
export function composeSpecularMaterialResponses(source: string): string {
  let shader = source.replaceAll("mix(vec3f(dielectric), base, metal)", "deepAdvMaterialF0(base, metal, dielectric)")
    .replaceAll("mix(vec3f(dielectric), baseColor, metallic)", "deepAdvMaterialF0(baseColor, metallic, dielectric)")
    .replaceAll("mix(vec3f(dielectric), max(baseColor, vec3f(0.0)), metallic)", "deepAdvMaterialF0(max(baseColor, vec3f(0.0)), metallic, dielectric)")
    .replaceAll("return f0 * (1.0 - factor) + factor;", "return f0 * (1.0 - factor) + deepAdvCurrentSpecularF90() * factor;")
    .replaceAll("f0 + (vec3f(1.0) - f0) * pow(1.0 - dominant, 5.0)", "f0 + (vec3f(deepAdvCurrentSpecularF90()) - f0) * pow(1.0 - dominant, 5.0)")
    .replaceAll("f0 * dfgView.x + dfgView.y", "f0 * dfgView.x + deepAdvCurrentSpecularF90() * dfgView.y")
    .replaceAll("f0 * dfgLight.x + dfgLight.y", "f0 * dfgLight.x + deepAdvCurrentSpecularF90() * dfgLight.y")
    .replaceAll("f0 + (1.0 - f0) * 0.047619", "f0 + (deepAdvCurrentSpecularF90() - f0) * 0.047619")
    .replaceAll("f0 * dfg.x + dfg.y", "f0 * dfg.x + deepAdvCurrentSpecularF90() * dfg.y");
  return shader;
}
