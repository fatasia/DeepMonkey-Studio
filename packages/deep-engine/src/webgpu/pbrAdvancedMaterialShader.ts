import { ADVANCED_MATERIAL_STRUCT_FIELDS_WGSL, ADVANCED_MATERIAL_WGSL } from "../shader/materialAdvancedWgsl.js";

function replaceOnce(source: string, anchor: string, replacement: string): string {
  const parts = source.split(anchor);
  if (parts.length !== 2) throw new Error("Advanced PBR shader anchor changed: " + anchor.slice(0, 72));
  return parts.join(replacement);
}

/** 选择性变体:仅 advancedMaterials 管线编译 sheen / iridescence / clearcoat IBL / 体积透射。
 * 未启用时场景 shader 字节与原样一致;启用时材质 uniform 由 192B 扩到 240B(advanced0..2)。
 * 与 layered / textureArrays 变体互斥(pipelines 层 fail-closed)。 */
export function composeAdvancedMaterialSceneShader(source: string): string {
  let shader = replaceOnce(source, "extended0: vec4f, extended1: vec4f,", ADVANCED_MATERIAL_STRUCT_FIELDS_WGSL);
  // IBL 高光/漫反射的 F0 在 shade 内统一替换为薄膜 F0(factor=0 时 mix 恒等,普通材质逐位不变)。
  shader = replaceOnce(shader, "    let f0 = mix(vec3f(dielectric), base, metal);\n    // C12",
    "    let f0 = mix(mix(vec3f(dielectric), base, metal), deepAdvIridF0, deepAdvIridFactor);\n    // C12");
  shader = replaceOnce(shader, "fn extendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {",
    "fn deepLegacyExtendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {");
  return `${shader}\n${ADVANCED_MATERIAL_WGSL}`;
}
