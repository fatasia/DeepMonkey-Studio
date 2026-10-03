import { MATERIAL_METAL_REFLECTION_WGSL } from "../shader/materialMetalReflectionWgsl.js";
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
// Layer-only wrapper; ordinary material entrypoints cannot reach layer bindings.
fn deepLayerMetalShade(v: Vertex, normal: vec3f, geometryNormal: vec3f,
  surface: SurfaceSample, params0: vec4f, params1: vec4f) -> vec3f {
  let dielectric = select(v.dielectric, deepDielectricF0(params0.x), params0.x >= 1.0);
  let original = shade(v.clip.xy, v.world, normal, geometryNormal, false, surface.base, surface.metal, surface.rough,
    surface.occlusion, surface.emissive, v.authorShadow, v.material.w, dielectric, false);
  if (flag(v.material.w, 64u)) { return deepApplySceneFog(surface.base, v.world, v.material.w); }
  let view = safeNormalize(frame.eye.xyz - v.world, vec3f(0.0, 0.0, 1.0));
  let light = safeNormalize(frame.lightDirection.xyz, vec3f(0.0, 1.0, 0.0));
  let visibility = deepPrimaryShadow(v.world, normal, dot(normal, light), v.authorShadow, v.clip.xy, v.material.w);
  let stockRough = min(1.0, clamp(surface.rough, 0.06, 1.0) + deepViewGeometryRoughness(geometryNormal));
  let stockDirect = (brdfWithDielectricF0(normal, view, light, surface.base, surface.metal, stockRough, dielectric)
    + deepSampleDirectMultiscattering(normal, view, light, surface.base, surface.metal, stockRough, dielectric))
    * frame.sunColor.rgb * frame.sunColor.w * visibility;
  let reflected = deepMetalReflectionDirect(surface.base, surface.rough, normal, view, light,
    v.metalTangent, frame.sunColor.rgb * frame.sunColor.w, params0.w, params1.x);
  return deepApplySceneFog(original - stockDirect + reflected * visibility, v.world, v.material.w);
}

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
    let layerSurface = SurfaceSample(base, metal, rough, surface.alpha, surface.occlusion, surface.emissive);
    var layer: vec3f;
    if ((flags & 8u) != 0u) {
      layer = deepLayerMetalShade(v, normal, geometryNormal, layerSurface, row.params0, row.params1);
    } else {
      layer = deepLayerBaseShade(v, normal, geometryNormal, layerSurface, row.params0, row.params1);
    }
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
function replaceFunctionOnce(source: string, name: string, anchor: string, replacement: string): string {
  const marker = `fn ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) {
    throw new Error(`Layered PBR shader function anchor changed: ${name}`);
  }
  const open = source.indexOf("{", start);
  if (open < 0) throw new Error(`Layered PBR shader function boundary changed: ${name}`);
  let end = open + 1;
  let depth = 1;
  while (end > 0 && end < source.length && depth > 0) {
    if (source[end] === "{") depth += 1;
    else if (source[end] === "}") depth -= 1;
    end += 1;
  }
  if (depth !== 0) throw new Error(`Layered PBR shader function boundary changed: ${name}`);
  return source.slice(0, start) + replaceOnce(source.slice(start, end), anchor, replacement) + source.slice(end);
}

/** Opt-in composition preserves the entire ordinary shader module when the capability is absent. */
export function composeLayeredMaterialSceneShader(source: string): string {
  // A separate varying fixes explicit model instance directions without changing legacy tangent semantics.
  source = replaceOnce(source, "  @location(12) @interpolate(flat) dielectric: f32,\n",
    "  @location(12) @interpolate(flat) dielectric: f32,\n  @location(13) metalTangent: vec3f,\n");
  source = replaceFunctionOnce(source, "vertexMain", "  out.tangent = vec4f(1.0, 0.0, 0.0, v.material.z);\n",
    "  out.tangent = vec4f(1.0, 0.0, 0.0, v.material.z);\n  let metalTangent = vec3f(v.row0.x, v.row1.x, v.row2.x);\n  out.metalTangent = safeNormalize(metalTangent - out.normal * dot(out.normal, metalTangent), tangentFallback(out.normal));\n");
  source = replaceFunctionOnce(source, "vertexNormalMapped", "  out.normal = n;\n", "  out.normal = n;\n  out.metalTangent = safeNormalize(rawTangent - n * dot(n, rawTangent), tangentFallback(n));\n");
  if (source.includes("fn deepPoseVertex(")) {
    source = replaceFunctionOnce(source, "deepPoseVertex", "  out.normal = n;\n",
      "  out.normal = n;\n  let metalTangent = vec3f(dot(v.row0.xyz, pose.tangent.xyz), dot(v.row1.xyz, pose.tangent.xyz), dot(v.row2.xyz, pose.tangent.xyz));\n  out.metalTangent = safeNormalize(metalTangent - n * dot(n, metalTangent), tangentFallback(n));\n");
  }
  let shader = replaceOnce(source,
    "fn extendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {",
    "fn deepLayerBaseShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample, params: vec4f, coatAndTransmission: vec4f) -> vec3f {");
  shader = replaceOnce(shader, "  let params = materialTextures.extended0;\n  let coatAndTransmission = materialTextures.extended1;\n", "");
  const start = shader.indexOf("fn deepLayerBaseShade("), end = shader.indexOf("@fragment fn fragmentMaterial", start);
  if (start < 0 || end < 0) throw new Error("Layered base shading boundary changed.");
  let base = shader.slice(start, end).replaceAll("v.dielectric", "dielectric");
  base = replaceOnce(base, " -> vec3f {\n", " -> vec3f {\n  let dielectric = select(v.dielectric, deepDielectricF0(params.x), params.x >= 1.0);\n");
  shader = shader.slice(0, start) + base + shader.slice(end);
  return `diagnostic(off, derivative_uniformity);\n${layerDeclarations}\n${MATERIAL_LAYER_BLEND_WGSL}\n${MATERIAL_METAL_REFLECTION_WGSL}\n${shader}\n${layerShade}`;
}
