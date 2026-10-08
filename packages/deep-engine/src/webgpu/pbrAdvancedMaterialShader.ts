import { ADVANCED_MATERIAL_STRUCT_FIELDS_WGSL, ADVANCED_MATERIAL_WGSL } from "../shader/materialAdvancedWgsl.js";
import { PBR_SCENE_TRANSMISSION_WGSL } from "./pbrSceneTransmissionWgsl.js";
import { SPECULAR_MATERIAL_WGSL, composeSpecularMaterialResponses } from "../shader/materialSpecularWgsl.js";
import { composeReflectionArrayShader } from "./pbrReflectionArray.js";
import { resolveAdvancedMaterialFeatures, specializeAdvancedMaterialShader } from "./advancedMaterialFeatures.js";

function replaceOnce(source: string, anchor: string, replacement: string): string {
  const parts = source.split(anchor);
  if (parts.length !== 2) throw new Error("Advanced PBR shader anchor changed: " + anchor.slice(0, 72));
  return parts.join(replacement);
}

/** 选择性变体:仅 advancedMaterials 管线编译 sheen / iridescence / clearcoat IBL / 体积透射。
 * 未启用时场景 shader 字节与原样一致;启用时材质 uniform 由 192B 扩到 320B(高级材质与高光贴图)。
 * 与 layered / textureArrays 变体互斥(pipelines 层 fail-closed)。 */
export function composeAdvancedMaterialSceneShader(source: string, features?: number): string {
  let shader = replaceOnce(source, "extended0: vec4f, extended1: vec4f,", ADVANCED_MATERIAL_STRUCT_FIELDS_WGSL);
  if (resolveAdvancedMaterialFeatures(features) === 0) {
    shader = replaceOnce(shader, "fn extendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {",
      "fn deepLegacyExtendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {");
    return specializeAdvancedMaterialShader(composeReflectionArrayShader(`${composeSpecularMaterialResponses(shader)}\n${SPECULAR_MATERIAL_WGSL}\n
fn extendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {
  deepAdvSampleSpecular(v, surface.metal);
  return deepLegacyExtendedShade(v, normal, geometryNormal, surface);
}`), 0);
  }
  // IBL 高光/漫反射的 F0 在 shade 内统一替换为薄膜 F0(factor=0 时 mix 恒等,普通材质逐位不变)。
  shader = replaceOnce(shader, "    let f0 = mix(vec3f(dielectric), base, metal);\n    // C12",
    "    let f0 = mix(mix(vec3f(dielectric), base, metal), deepAdvIridF0, deepAdvIridFactor);\n    // C12");
  shader = replaceOnce(shader, "fn extendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {",
    "fn deepLegacyExtendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {");
  // Without anisotropy the advanced response also covers ordinary materials.
  // A runtime legacy/advanced dispatch duplicates the entire lighting graph in
  // driver compilation, even when the scene only uses standard PBR and glass.
  const advanced = !(resolveAdvancedMaterialFeatures(features) & 16)
    ? ADVANCED_MATERIAL_WGSL.slice(0, ADVANCED_MATERIAL_WGSL.indexOf("fn extendedShade(")) + `
fn extendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {
  deepAdvSampleSpecular(v, surface.metal);
  return deepAdvancedShade(v, normal, geometryNormal, surface);
}` : ADVANCED_MATERIAL_WGSL;
  return specializeAdvancedMaterialShader(composeReflectionArrayShader(`${composeSpecularMaterialResponses(shader)}\n${PBR_SCENE_TRANSMISSION_WGSL}\n${SPECULAR_MATERIAL_WGSL}\n${advanced}`), features);
}
