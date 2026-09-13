import type { StandardPlainWgslAdapterOptions } from "./packageAdapterWgslContract.js";
import { exactlyOnce } from "./packageAdapterWgslContract.js";

const FRAGMENT_ENTRY = "@fragment fn deepFragment(input: DeepVertexOut) -> @location(0) vec4f {";
const STANDARD_RETURN = "return deepLowerStandardPbr(input.v_worldPosition, n_baseColor, n_surfaceNormal,";
const MATERIAL_SAMPLING = [
  "  var deepBaseColorSample = vec4f(1.0);",
  "  var deepMetallicRoughnessSample = vec4f(1.0);",
  "  var deepOcclusionSample = 1.0;",
  "  var deepEmissiveSample = vec3f(1.0);",
  "  if (deepMaterialTextures.baseRow0.w > 0.5) {",
  "    deepBaseColorSample = textureSample(",
  "      deepBaseColorMap, deepBaseColorSampler,",
  "      deepPackageSlotUv(input.v_surfaceUv0, input.v_surfaceUv1, deepMaterialTextures.baseRow0, deepMaterialTextures.baseRow1),",
  "    );",
  "  }",
  "  if (deepMaterialTextures.mrRow0.w > 0.5) {",
  "    deepMetallicRoughnessSample = textureSample(",
  "      deepMetallicRoughnessMap, deepMetallicRoughnessSampler,",
  "      deepPackageSlotUv(input.v_surfaceUv0, input.v_surfaceUv1, deepMaterialTextures.mrRow0, deepMaterialTextures.mrRow1),",
  "    );",
  "  }",
  "  if (deepMaterialTextures.occlusionRow0.w > 0.5) {",
  "    let deepSampledOcclusion = textureSample(",
  "      deepOcclusionMap, deepOcclusionSampler,",
  "      deepPackageSlotUv(input.v_surfaceUv0, input.v_surfaceUv1, deepMaterialTextures.occlusionRow0, deepMaterialTextures.occlusionRow1),",
  "    ).r;",
  "    deepOcclusionSample = 1.0 + deepMaterialTextures.occlusionRow1.w * (deepSampledOcclusion - 1.0);",
  "  }",
  "  if (deepMaterialTextures.emissiveRow0.w > 0.5) {",
  "    deepEmissiveSample = textureSample(",
  "      deepEmissiveMap, deepEmissiveSampler,",
  "      deepPackageSlotUv(input.v_surfaceUv0, input.v_surfaceUv1, deepMaterialTextures.emissiveRow0, deepMaterialTextures.emissiveRow1),",
  "    ).rgb;",
  "  }",
  "  let n_baseColor: vec3f = n_colorMetal.rgb * deepBaseColorSample.rgb;",
].join("\n");

function renameFragmentEntry(code: string, options: StandardPlainWgslAdapterOptions): string | undefined {
  if (!exactlyOnce(code, FRAGMENT_ENTRY) || !exactlyOnce(code, STANDARD_RETURN)) return undefined;
  const name = options.materialMode === "base-color-texture" ? "fragmentMaterial" : "fragmentMain";
  const entry = options.doubleSided
    ? `@fragment fn ${name}(input: DeepVertexOut, @builtin(front_facing) deepFrontFacing: bool) -> @location(0) vec4f {`
    : `@fragment fn ${name}(input: DeepVertexOut) -> @location(0) vec4f {`;
  return code.replace(FRAGMENT_ENTRY, entry);
}

function adaptMaterialInputs(code: string, options: StandardPlainWgslAdapterOptions): string | undefined {
  if (options.materialMode !== "base-color-texture") return code;
  const baseColor = "  let n_baseColor: vec3f = n_colorMetal.rgb;";
  const metallic = "  let n_metallic: f32 = n_colorMetal.a;";
  const roughness = "  let n_roughness: f32 = n_material.x;";
  const occlusion = "  let n_occlusion: f32 = 1.0;";
  const emission = "  let n_emission: vec3f = n_emissiveAlpha.rgb;";
  if (!exactlyOnce(code, baseColor) || !exactlyOnce(code, metallic) || !exactlyOnce(code, roughness)
    || !exactlyOnce(code, occlusion) || !exactlyOnce(code, emission)) return undefined;
  let adapted = code.replace(baseColor, MATERIAL_SAMPLING)
    .replace(metallic, "  let n_metallic: f32 = n_colorMetal.a * deepMetallicRoughnessSample.b;")
    .replace(roughness, "  let n_roughness: f32 = n_material.x * deepMetallicRoughnessSample.g;")
    .replace(occlusion, "  let n_occlusion: f32 = deepOcclusionSample;")
    .replace(emission, "  let n_emission: vec3f = n_emissiveAlpha.rgb * deepEmissiveSample * deepMaterialTextures.emissiveRow1.w;");
  if (options.alphaMode !== "opaque") {
    const alpha = "  let n_alpha: f32 = n_emissiveAlpha.a;";
    if (!exactlyOnce(adapted, alpha)) return undefined;
    adapted = adapted.replace(alpha, "  let n_alpha: f32 = n_emissiveAlpha.a * deepBaseColorSample.a;");
  }
  return adapted;
}

function adaptSurfaceReturn(code: string, options: StandardPlainWgslAdapterOptions): string | undefined {
  const statements: string[] = [];
  let normal = "n_surfaceNormal";
  if (options.doubleSided) {
    statements.push(
      "  let deepPackageGltfFront = select(!deepFrontFacing, deepFrontFacing, n_material.z > 0.0);",
      "  let deepPackageGeometricNormal = select(-n_surfaceNormal, n_surfaceNormal, deepPackageGltfFront);",
    );
    normal = "deepPackageGeometricNormal";
  }
  if (options.normalMapped) {
    statements.push(
      `  var deepPackageNormal = ${normal};`,
      "  if (deepMaterialTextures.normalRow0.w > 0.5) {",
      "    deepPackageNormal = deepPackageMappedNormal(",
      `      ${normal}, input.v_surfaceTangent, n_material.z, input.v_surfaceUv0, input.v_surfaceUv1,`,
      "    );",
      "  }",
    );
    normal = "deepPackageNormal";
  }
  if (options.alphaMode === "mask") statements.push("  if (n_alpha < n_material.y) { discard; }");
  const prefix = `${statements.length > 0 ? `${statements.join("\n")}\n` : ""}  return deepLowerStandardPbr(input.v_worldPosition, n_baseColor, ${normal},`;
  let adapted = code.replace(`  ${STANDARD_RETURN}`, prefix);
  if (options.alphaMode === "mask") {
    const maskAlpha = ", n_occlusion, n_emission, n_alpha);";
    if (!exactlyOnce(adapted, maskAlpha)) return undefined;
    adapted = adapted.replace(maskAlpha, ", n_occlusion, n_emission, 1.0);");
  }
  return adapted;
}

export function adaptFragment(code: string, options: StandardPlainWgslAdapterOptions): string | undefined {
  const renamed = renameFragmentEntry(code, options);
  if (!renamed) return undefined;
  const material = adaptMaterialInputs(renamed, options);
  return material === undefined ? undefined : adaptSurfaceReturn(material, options);
}
