import type { DeepWgslModuleDescriptor } from "../shader/types.js";

export interface UnlitPackageWgslOptions {
  readonly alphaMode: "opaque" | "mask" | "blend";
  readonly textured: boolean;
}

const FRAME = /* wgsl */ `
struct DeepUnlitFrame {
  view: mat4x4f,
  light: mat4x4f,
  eye: vec4f,
  background: vec4f,
  floor: vec4f,
  lightDirection: vec4f,
  tuning: vec4f,
};
@group(0) @binding(0) var<uniform> deepPbrFrame: DeepUnlitFrame;
`;

const MATERIAL = /* wgsl */ `
struct DeepUnlitMaterialTextures {
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
@group(1) @binding(4) var<uniform> deepMaterialTextures: DeepUnlitMaterialTextures;
@group(1) @binding(5) var deepOcclusionMap: texture_2d<f32>;
@group(1) @binding(6) var deepOcclusionSampler: sampler;
@group(1) @binding(7) var deepNormalMap: texture_2d<f32>;
@group(1) @binding(8) var deepNormalSampler: sampler;
@group(1) @binding(9) var deepEmissiveMap: texture_2d<f32>;
@group(1) @binding(10) var deepEmissiveSampler: sampler;
fn deepUnlitUv(uv0: vec2f, uv1: vec2f, row0: vec4f, row1: vec4f) -> vec2f {
  let uv = vec3f(select(uv0, uv1, row0.w > 1.5), 1.0);
  return vec2f(dot(row0.xyz, uv), dot(row1.xyz, uv));
}
`;

function vertex(textured: boolean): string {
  return /* wgsl */ `
struct DeepUnlitVertexInput {
  @location(0) position: vec3f,
  @location(2) modelRow0: vec4f,
  @location(3) modelRow1: vec4f,
  @location(4) modelRow2: vec4f,
  @location(8) baseColorMetallic: vec4f,
  @location(9) material: vec4f,
  ${textured ? "@location(10) uv0: vec2f," : ""}
  @location(12) emissiveAlpha: vec4f,
  ${textured ? "@location(13) uv1: vec2f," : ""}
};
struct DeepUnlitVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) baseColorAlpha: vec4f,
  @location(1) emissive: vec3f,
  @location(2) alphaCutoff: f32,
  ${textured ? "@location(3) uv0: vec2f," : ""}
  ${textured ? "@location(4) uv1: vec2f," : ""}
};
@vertex fn vertexMain(input: DeepUnlitVertexInput) -> DeepUnlitVertexOutput {
  let position = vec4f(input.position, 1.0);
  let world = vec3f(dot(input.modelRow0, position), dot(input.modelRow1, position), dot(input.modelRow2, position));
  var output: DeepUnlitVertexOutput;
  output.position = deepPbrFrame.view * vec4f(world, 1.0);
  output.baseColorAlpha = vec4f(input.baseColorMetallic.rgb, input.emissiveAlpha.a);
  output.emissive = input.emissiveAlpha.rgb;
  output.alphaCutoff = input.material.y;
  ${textured ? "output.uv0 = input.uv0; output.uv1 = input.uv1;" : ""}
  return output;
}
`;
}

function fragment(options: UnlitPackageWgslOptions): string {
  const entry = options.textured ? "fragmentMaterial" : "fragmentMain";
  const samples = options.textured ? /* wgsl */ `
  var baseSample = vec4f(1.0);
  if (deepMaterialTextures.baseRow0.w > 0.5) {
    baseSample = textureSample(deepBaseColorMap, deepBaseColorSampler,
      deepUnlitUv(input.uv0, input.uv1, deepMaterialTextures.baseRow0, deepMaterialTextures.baseRow1));
  }
  var emissiveSample = vec3f(1.0);
  if (deepMaterialTextures.emissiveRow0.w > 0.5) {
    emissiveSample = textureSample(deepEmissiveMap, deepEmissiveSampler,
      deepUnlitUv(input.uv0, input.uv1, deepMaterialTextures.emissiveRow0, deepMaterialTextures.emissiveRow1)).rgb;
  }
  let color = input.baseColorAlpha.rgb * baseSample.rgb
    + input.emissive * emissiveSample * deepMaterialTextures.emissiveRow1.w;
  let alpha = input.baseColorAlpha.a * baseSample.a;` : /* wgsl */ `
  let color = input.baseColorAlpha.rgb + input.emissive;
  let alpha = input.baseColorAlpha.a;`;
  const mask = options.alphaMode === "mask" ? "if (alpha < input.alphaCutoff) { discard; }" : "";
  const outputAlpha = options.alphaMode === "blend" ? "alpha" : "1.0";
  return /* wgsl */ `
@fragment fn ${entry}(input: DeepUnlitVertexOutput) -> @location(0) vec4f {${samples}
  ${mask}
  return vec4f(color, ${outputAlpha});
}
`;
}

const SHADOW_SOLID = /* wgsl */ `
struct DeepUnlitShadowInput {
  @location(0) position: vec3f,
  @location(2) modelRow0: vec4f,
  @location(3) modelRow1: vec4f,
  @location(4) modelRow2: vec4f,
};
@vertex fn shadowMain(input: DeepUnlitShadowInput) -> @builtin(position) vec4f {
  let position = vec4f(input.position, 1.0);
  let world = vec3f(dot(input.modelRow0, position), dot(input.modelRow1, position), dot(input.modelRow2, position));
  return deepPbrFrame.light * vec4f(world, 1.0);
}
`;

function shadowMask(textured: boolean): string {
  return /* wgsl */ `
struct DeepUnlitMaskShadowInput {
  @location(0) position: vec3f,
  @location(2) modelRow0: vec4f,
  @location(3) modelRow1: vec4f,
  @location(4) modelRow2: vec4f,
  @location(9) material: vec4f,
  ${textured ? "@location(10) uv0: vec2f," : ""}
  @location(12) emissiveAlpha: vec4f,
  ${textured ? "@location(13) uv1: vec2f," : ""}
};
struct DeepUnlitMaskShadowOutput {
  @builtin(position) position: vec4f,
  @location(0) alphaCutoff: vec2f,
  ${textured ? "@location(1) uv0: vec2f," : ""}
  ${textured ? "@location(2) uv1: vec2f," : ""}
};
@vertex fn shadowMaskMain(input: DeepUnlitMaskShadowInput) -> DeepUnlitMaskShadowOutput {
  let position = vec4f(input.position, 1.0);
  let world = vec3f(dot(input.modelRow0, position), dot(input.modelRow1, position), dot(input.modelRow2, position));
  var output: DeepUnlitMaskShadowOutput;
  output.position = deepPbrFrame.light * vec4f(world, 1.0);
  output.alphaCutoff = vec2f(input.emissiveAlpha.a, input.material.y);
  ${textured ? "output.uv0 = input.uv0; output.uv1 = input.uv1;" : ""}
  return output;
}
@fragment fn ${textured ? "shadowMaskTextured" : "shadowMaskPlain"}(input: DeepUnlitMaskShadowOutput) {
  var alpha = input.alphaCutoff.x;
  ${textured ? `if (deepMaterialTextures.baseRow0.w > 0.5) {
    alpha *= textureSample(deepBaseColorMap, deepBaseColorSampler,
      deepUnlitUv(input.uv0, input.uv1, deepMaterialTextures.baseRow0, deepMaterialTextures.baseRow1)).a;
  }` : ""}
  if (alpha < input.alphaCutoff.y) { discard; }
}
`;
}

export function buildUnlitPackageWgsl(options: UnlitPackageWgslOptions): DeepWgslModuleDescriptor {
  const shadow = options.alphaMode === "blend" ? ""
    : options.alphaMode === "mask" ? shadowMask(options.textured) : SHADOW_SOLID;
  return Object.freeze({
    label: `deep.deepsl.unlit/${options.textured ? "textures" : "plain"}`,
    code: FRAME + (options.textured ? MATERIAL : "") + vertex(options.textured) + fragment(options) + shadow,
  });
}
