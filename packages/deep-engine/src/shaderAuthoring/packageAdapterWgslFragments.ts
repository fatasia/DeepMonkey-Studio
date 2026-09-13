export const SHADOW_ENTRY = `
struct DeepPackageSolidShadowInput {
  @location(0) a_position: vec3f,
  @location(2) a_modelRow0: vec4f,
  @location(3) a_modelRow1: vec4f,
  @location(4) a_modelRow2: vec4f,
};
@vertex fn shadowMain(input: DeepPackageSolidShadowInput) -> @builtin(position) vec4f {
  let deepPackagePosition = vec4f(input.a_position, 1.0);
  let deepPackageWorld = vec3f(
    dot(input.a_modelRow0, deepPackagePosition),
    dot(input.a_modelRow1, deepPackagePosition),
    dot(input.a_modelRow2, deepPackagePosition),
  );
  return deepPbrFrame.light * vec4f(deepPackageWorld, 1.0);
}
`;

export const SHADOW_MASK_ENTRY = `
struct DeepPackagePlainShadowInput {
  @location(0) a_position: vec3f,
  @location(2) a_modelRow0: vec4f,
  @location(3) a_modelRow1: vec4f,
  @location(4) a_modelRow2: vec4f,
  @location(9) a_material: vec4f,
  @location(12) a_emissiveAlpha: vec4f,
};
struct DeepShadowMaskVertexOut {
  @builtin(position) position: vec4f,
  @location(0) alphaCutoff: vec2f,
};
@vertex fn shadowMaskMain(input: DeepPackagePlainShadowInput) -> DeepShadowMaskVertexOut {
  let deepPackagePosition = vec4f(input.a_position, 1.0);
  let deepPackageWorld = vec3f(
    dot(input.a_modelRow0, deepPackagePosition),
    dot(input.a_modelRow1, deepPackagePosition),
    dot(input.a_modelRow2, deepPackagePosition),
  );
  var output: DeepShadowMaskVertexOut;
  output.position = deepPbrFrame.light * vec4f(deepPackageWorld, 1.0);
  output.alphaCutoff = vec2f(input.a_emissiveAlpha.a, input.a_material.y);
  return output;
}
@fragment fn shadowMaskPlain(input: DeepShadowMaskVertexOut) {
  if (input.alphaCutoff.x < input.alphaCutoff.y) { discard; }
}
`;

export const MATERIAL_DECLARATIONS = `
struct DeepPackageMaterialTextures {
  baseRow0: vec4f,
  baseRow1: vec4f,
  mrRow0: vec4f,
  mrRow1: vec4f,
  occlusionRow0: vec4f,
  occlusionRow1: vec4f,
  normalRow0: vec4f,
  normalRow1: vec4f,
  emissiveRow0: vec4f,
  emissiveRow1: vec4f,
};
@group(1) @binding(0) var deepBaseColorMap: texture_2d<f32>;
@group(1) @binding(1) var deepBaseColorSampler: sampler;
@group(1) @binding(2) var deepMetallicRoughnessMap: texture_2d<f32>;
@group(1) @binding(3) var deepMetallicRoughnessSampler: sampler;
@group(1) @binding(4) var<uniform> deepMaterialTextures: DeepPackageMaterialTextures;
@group(1) @binding(5) var deepOcclusionMap: texture_2d<f32>;
@group(1) @binding(6) var deepOcclusionSampler: sampler;
@group(1) @binding(7) var deepNormalMap: texture_2d<f32>;
@group(1) @binding(8) var deepNormalSampler: sampler;
@group(1) @binding(9) var deepEmissiveMap: texture_2d<f32>;
@group(1) @binding(10) var deepEmissiveSampler: sampler;
fn deepPackageSlotUv(uv0: vec2f, uv1: vec2f, row0: vec4f, row1: vec4f) -> vec2f {
  let uv = vec3f(select(uv0, uv1, row0.w > 1.5), 1.0);
  return vec2f(
    dot(row0.xyz, uv),
    dot(row1.xyz, uv),
  );
}
fn deepPackageSafeNormalize(value: vec3f, fallback: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  return select(fallback, value * inverseSqrt(max(lengthSquared, 0.00000001)), lengthSquared > 0.00000001);
}
fn deepPackageTangentFallback(normal: vec3f) -> vec3f {
  let axis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(normal.x) > 0.9);
  return deepPackageSafeNormalize(cross(axis, normal), vec3f(0.0, 0.0, 1.0));
}
fn deepPackageMappedNormal(
  geometricNormal: vec3f,
  tangentInput: vec4f,
  modelHandedness: f32,
  uv0: vec2f,
  uv1: vec2f,
) -> vec3f {
  let normalUv = deepPackageSlotUv(
    uv0, uv1, deepMaterialTextures.normalRow0, deepMaterialTextures.normalRow1,
  );
  let sourceTangent = deepPackageSafeNormalize(
    tangentInput.xyz - geometricNormal * dot(geometricNormal, tangentInput.xyz),
    deepPackageTangentFallback(geometricNormal),
  );
  let sourceHandedness = tangentInput.w * modelHandedness;
  let sourceBitangent = cross(geometricNormal, sourceTangent) * sourceHandedness;
  let determinant = deepMaterialTextures.normalRow0.x * deepMaterialTextures.normalRow1.y
    - deepMaterialTextures.normalRow0.y * deepMaterialTextures.normalRow1.x;
  let determinantSign = select(-1.0, 1.0, determinant >= 0.0);
  let tangent = deepPackageSafeNormalize(
    (sourceTangent * deepMaterialTextures.normalRow1.y
      - sourceBitangent * deepMaterialTextures.normalRow1.x) * determinantSign,
    deepPackageTangentFallback(geometricNormal),
  );
  let bitangent = cross(geometricNormal, tangent) * sourceHandedness * determinantSign;
  let sampled = textureSample(deepNormalMap, deepNormalSampler, normalUv).rgb * 2.0 - 1.0;
  let tangentNormal = deepPackageSafeNormalize(
    vec3f(sampled.xy * deepMaterialTextures.normalRow1.w, sampled.z), vec3f(0.0, 0.0, 1.0),
  );
  return deepPackageSafeNormalize(
    tangent * tangentNormal.x + bitangent * tangentNormal.y + geometricNormal * tangentNormal.z,
    geometricNormal,
  );
}
`;

export const SHADOW_MASK_TEXTURE_ENTRY = `
struct DeepPackageTexturedShadowInput {
  @location(0) a_position: vec3f,
  @location(2) a_modelRow0: vec4f,
  @location(3) a_modelRow1: vec4f,
  @location(4) a_modelRow2: vec4f,
  @location(9) a_material: vec4f,
  @location(10) a_uv0: vec2f,
  @location(12) a_emissiveAlpha: vec4f,
  @location(13) a_uv1: vec2f,
};
struct DeepShadowMaskMaterialVertexOut {
  @builtin(position) position: vec4f,
  @location(0) alphaCutoff: vec2f,
  @location(1) uv0: vec2f,
  @location(2) uv1: vec2f,
};
@vertex fn shadowMaskMain(input: DeepPackageTexturedShadowInput) -> DeepShadowMaskMaterialVertexOut {
  let deepPackagePosition = vec4f(input.a_position, 1.0);
  let deepPackageWorld = vec3f(
    dot(input.a_modelRow0, deepPackagePosition),
    dot(input.a_modelRow1, deepPackagePosition),
    dot(input.a_modelRow2, deepPackagePosition),
  );
  var output: DeepShadowMaskMaterialVertexOut;
  output.position = deepPbrFrame.light * vec4f(deepPackageWorld, 1.0);
  output.alphaCutoff = vec2f(input.a_emissiveAlpha.a, input.a_material.y);
  output.uv0 = input.a_uv0;
  output.uv1 = input.a_uv1;
  return output;
}
@fragment fn shadowMaskTextured(input: DeepShadowMaskMaterialVertexOut) {
  var sampledAlpha = 1.0;
  if (deepMaterialTextures.baseRow0.w > 0.5) {
    sampledAlpha = textureSample(
      deepBaseColorMap,
      deepBaseColorSampler,
      deepPackageSlotUv(
        input.uv0, input.uv1, deepMaterialTextures.baseRow0, deepMaterialTextures.baseRow1,
      ),
    ).a;
  }
  if (input.alphaCutoff.x * sampledAlpha < input.alphaCutoff.y) { discard; }
}
`;
