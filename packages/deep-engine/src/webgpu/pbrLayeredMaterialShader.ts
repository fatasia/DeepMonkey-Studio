import { MATERIAL_LAYER_BLEND_WGSL } from "../shader/materialLayerBlendWgsl.js";

const layerDeclarations = /* wgsl */ `
struct DeepLayerSurfaceRow {
  params0: vec4f, params1: vec4f, colorCoverage: vec4f, surfaceMode: vec4f,
  baseRow0: vec4f, baseRow1: vec4f, mrRow0: vec4f, mrRow1: vec4f, indices: vec4u,
};
struct DeepLayerSurfaceBlock { header: vec4u, rows: array<DeepLayerSurfaceRow, 2> };
@group(1) @binding(13) var<uniform> deepLayerSurface: DeepLayerSurfaceBlock;
@group(1) @binding(14) var deepLayerBase0: texture_2d<f32>;
@group(1) @binding(15) var deepLayerBaseSampler0: sampler;
@group(1) @binding(16) var deepLayerMr0: texture_2d<f32>;
@group(1) @binding(17) var deepLayerMrSampler0: sampler;
@group(1) @binding(18) var deepLayerBase1: texture_2d<f32>;
@group(1) @binding(19) var deepLayerBaseSampler1: sampler;
@group(1) @binding(20) var deepLayerMr1: texture_2d<f32>;
@group(1) @binding(21) var deepLayerMrSampler1: sampler;
`;
const layerShade = /* wgsl */ `
fn extendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {
  var result = deepLayerBaseShade(v, normal, geometryNormal, surface, materialTextures.extended0, materialTextures.extended1);
  for (var index = 0u; index < min(deepLayerSurface.header.x, 2u); index++) {
    let row = deepLayerSurface.rows[index]; let flags = u32(row.surfaceMode.w);
    var base = select(surface.base, row.colorCoverage.rgb, (flags & 1u) != 0u);
    var metal = select(surface.metal, row.surfaceMode.x, (flags & 2u) != 0u);
    var rough = select(surface.rough, row.surfaceMode.y, (flags & 4u) != 0u);
    var coverage = row.colorCoverage.w;
    if (row.baseRow0.w > 0.5) {
      let uv = slotUv(v.uv0, v.uv1, row.baseRow0, row.baseRow1);
      var color: vec4f;
      if (index == 0u) { color = textureSample(deepLayerBase0, deepLayerBaseSampler0, uv); }
      else { color = textureSample(deepLayerBase1, deepLayerBaseSampler1, uv); }
      base *= color.rgb; coverage *= color.a;
    }
    if (row.mrRow0.w > 0.5) {
      let uv = slotUv(v.uv0, v.uv1, row.mrRow0, row.mrRow1);
      var mr: vec4f;
      if (index == 0u) { mr = textureSample(deepLayerMr0, deepLayerMrSampler0, uv); }
      else { mr = textureSample(deepLayerMr1, deepLayerMrSampler1, uv); }
      metal *= mr.b; rough *= mr.g;
    }
    let layer = deepLayerBaseShade(v, normal, geometryNormal,
      SurfaceSample(base, metal, rough, surface.alpha, surface.occlusion, surface.emissive), row.params0, row.params1);
    result = deepLayerBlend(result, layer, layer, coverage, u32(row.surfaceMode.z));
  }
  return result;
}
`;
function replaceOnce(source: string, anchor: string, replacement: string): string {
  const parts = source.split(anchor);
  if (parts.length !== 2) throw new Error("Layered PBR shader anchor changed: " + anchor.slice(0, 72));
  return parts.join(replacement);
}
/** Opt-in composition preserves the entire ordinary shader module when the capability is absent. */
export function composeLayeredMaterialSceneShader(source: string): string {
  let shader = replaceOnce(source,
    "fn extendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {",
    "fn deepLayerBaseShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample, params: vec4f, coatAndTransmission: vec4f) -> vec3f {");
  shader = replaceOnce(shader, "  let params = materialTextures.extended0;\n  let coatAndTransmission = materialTextures.extended1;\n", "");
  const start = shader.indexOf("fn deepLayerBaseShade("), end = shader.indexOf("@fragment fn fragmentMaterial", start);
  if (start < 0 || end < 0) throw new Error("Layered base shading boundary changed.");
  let base = shader.slice(start, end).replaceAll("v.dielectric", "dielectric");
  base = replaceOnce(base, " -> vec3f {\n", " -> vec3f {\n  let dielectric = select(v.dielectric, deepDielectricF0(params.x), params.x >= 1.0);\n");
  shader = shader.slice(0, start) + base + shader.slice(end);
  return `diagnostic(off, derivative_uniformity);\n${layerDeclarations}\n${MATERIAL_LAYER_BLEND_WGSL}\n${shader}\n${layerShade}`;
}
