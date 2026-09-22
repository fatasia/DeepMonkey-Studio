/**
 * 级 1 纹理数组化 WGSL 双轨（波次5 bindless）：
 * - 默认路径不经过本文件，sceneShader 逐字节保持不变（合同测试断言默认字符串不含数组采样）。
 * - 开启 textureArrays 特性时，composeTextureArraySceneShader 把材质纹理声明换成 5 个
 *   texture_2d_array（槽位→绑定号静态固定：0..4 数组、5..9 采样器、10 为共享
 *   192B 行表：原 160B 材质参数 + 32B MaterialArrayIndices；11/12 保留给变形流）。
 *   内嵌的 160B material ABI 块与 SHA-256 指纹不变；默认关闭路径完全不创建行表。
 * - 所有锚点必须恰好命中一次；缺失或多处命中立即抛错（fail-closed，绝不静默产出错位
 *   shader）。上游采样代码变化会在此显式失败，由合同测试定位。
 * - 槽位层号从 MaterialArrayIndices（vec4i）动态读取；texture_2d_array 的 array_index
 *   是 i32，宿主侧以 Uint32 位型上传非负层号。
 * - materialRow 是 primitive-flat，材质存在位因此对同一 primitive 恒定；Dawn 的保守
 *   uniformity 分析不会从 storage load 推导这一点，数组变体显式关闭该诊断以保留隐式
 *   导数和完整 mip/各向异性采样质量。
 */

/** 槽位固定绑定映射，与 textureArrayResources.ts 的 TEXTURE_ARRAY_SLOT_BINDINGS 一一对应。 */
export const TEXTURE_ARRAY_SHADER_SLOTS = Object.freeze(
  ["baseColor", "metallicRoughness", "occlusion", "normal", "emissive"] as const);

const MATERIAL_TEXTURE_DECLARATIONS = `@group(1) @binding(0) var baseColorMap: texture_2d<f32>;
@group(1) @binding(1) var baseColorSampler: sampler;
@group(1) @binding(2) var metallicRoughnessMap: texture_2d<f32>;
@group(1) @binding(3) var metallicRoughnessSampler: sampler;
@group(1) @binding(4) var<uniform> materialTextures: MaterialTextures;
@group(1) @binding(5) var occlusionMap: texture_2d<f32>;
@group(1) @binding(6) var occlusionSampler: sampler;
@group(1) @binding(7) var normalMap: texture_2d<f32>;
@group(1) @binding(8) var normalSampler: sampler;
@group(1) @binding(9) var emissiveMap: texture_2d<f32>;
@group(1) @binding(10) var emissiveSampler: sampler;`;

const MATERIAL_ARRAY_DECLARATIONS = `@group(1) @binding(0) var deepArrayMap0: texture_2d_array<f32>;
@group(1) @binding(5) var deepArraySampler0: sampler;
@group(1) @binding(1) var deepArrayMap1: texture_2d_array<f32>;
@group(1) @binding(6) var deepArraySampler1: sampler;
@group(1) @binding(2) var deepArrayMap2: texture_2d_array<f32>;
@group(1) @binding(7) var deepArraySampler2: sampler;
@group(1) @binding(3) var deepArrayMap3: texture_2d_array<f32>;
@group(1) @binding(8) var deepArraySampler3: sampler;
@group(1) @binding(4) var deepArrayMap4: texture_2d_array<f32>;
@group(1) @binding(9) var deepArraySampler4: sampler;
struct MaterialArrayIndices { layerRow: vec4i, emissiveLayerRow: vec4i };
struct MaterialTableRow { textures: MaterialTextures, indices: MaterialArrayIndices };
@group(1) @binding(10) var<storage, read> materialTable: array<MaterialTableRow>;`;

/** 采样改写对：锚点逐一从现路径精确文本提取；替换保持同一控制流与同名局部变量。 */
const SAMPLING_REWRITES: readonly (readonly [string, string])[] = Object.freeze([
  ["baseSample = textureSample(baseColorMap, baseColorSampler, baseUv);",
    "baseSample = textureSample(deepArrayMap0, deepArraySampler0, baseUv, materialTable[v.materialRow].indices.layerRow.x);"],
  ["mrSample = textureSample(metallicRoughnessMap, metallicRoughnessSampler, mrUv);",
    "mrSample = textureSample(deepArrayMap1, deepArraySampler1, mrUv, materialTable[v.materialRow].indices.layerRow.y);"],
  ["let sampled = textureSample(occlusionMap, occlusionSampler, aoUv).r;",
    "let sampled = textureSample(deepArrayMap2, deepArraySampler2, aoUv, materialTable[v.materialRow].indices.layerRow.z).r;"],
  ["let sampled = textureSample(normalMap, normalSampler, normalUv).rgb * 2.0 - 1.0;",
    "let sampled = textureSample(deepArrayMap3, deepArraySampler3, normalUv, materialTable[v.materialRow].indices.layerRow.w).rgb * 2.0 - 1.0;"],
  ["emission = textureSample(emissiveMap, emissiveSampler, emissiveUv).rgb;",
    "emission = textureSample(deepArrayMap4, deepArraySampler4, emissiveUv, materialTable[v.materialRow].indices.emissiveLayerRow.x).rgb;"],
  ["sampledAlpha = textureSample(baseColorMap, baseColorSampler, baseUv).a;",
    "sampledAlpha = textureSample(deepArrayMap0, deepArraySampler0, baseUv, materialTable[v.materialRow].indices.layerRow.x).a;"],
]);

function replaceExactlyOnce(shader: string, anchor: string, replacement: string): string {
  const parts = shader.split(anchor);
  if (parts.length !== 2) {
    throw new Error(`Texture array shader anchor must occur exactly once: ${
      JSON.stringify(anchor.slice(0, 72))} (found ${parts.length - 1}).`);
  }
  return parts.join(replacement);
}

/** 把任意含现路径材质采样的 PBR 模块改写为 texture_2d_array 变体；锚点缺失即抛错。 */
export function composeTextureArraySceneShader(shader: string): string {
  let composed = `diagnostic(off, derivative_uniformity);\n${
    replaceExactlyOnce(shader, MATERIAL_TEXTURE_DECLARATIONS, MATERIAL_ARRAY_DECLARATIONS)}`;
  composed = replaceExactlyOnce(composed,
    "@location(12) @interpolate(flat) dielectric: f32,",
    "@location(12) @interpolate(flat) dielectric: f32, @location(13) @interpolate(flat) materialRow: u32,");
  composed = replaceExactlyOnce(composed,
    "@location(6) @interpolate(flat) dielectric: f32,",
    "@location(6) @interpolate(flat) dielectric: f32, @location(7) @interpolate(flat) materialRow: u32,");
  composed = replaceExactlyOnce(composed,
    "@builtin(position) clip: vec4f, @location(0) uv0: vec2f, @location(1) uv1: vec2f, @location(2) alphaCutoff: vec2f,",
    "@builtin(position) clip: vec4f, @location(0) uv0: vec2f, @location(1) uv1: vec2f, @location(2) alphaCutoff: vec2f, @location(3) @interpolate(flat) materialRow: u32,");
  composed = composed.replaceAll("out.material = v.material;",
    "out.material = v.material; out.materialRow = u32(round(v.material.w)) >> 10u;");
  composed = replaceExactlyOnce(composed,
    "out.uv0 = v.uvSets.xy; out.uv1 = v.uvSets.zw; out.alphaCutoff = vec2f(v.emissiveAlpha.w, v.material.y);",
    "out.uv0 = v.uvSets.xy; out.uv1 = v.uvSets.zw; out.alphaCutoff = vec2f(v.emissiveAlpha.w, v.material.y); out.materialRow = u32(round(v.material.w)) >> 10u;");
  composed = composed.replaceAll("materialTextures.", "materialTable[v.materialRow].textures.");
  for (const [anchor, replacement] of SAMPLING_REWRITES) {
    composed = replaceExactlyOnce(composed, anchor, replacement);
  }
  return composed;
}
