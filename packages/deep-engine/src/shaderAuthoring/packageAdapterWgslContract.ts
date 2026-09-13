import { DEEP_PBR_MESH_V1 } from "../shaderAbi/contract.js";
import type { CompiledShaderPass, DeepShaderAsset, ShaderCompilerBindingLayoutEntry } from "../shader/types.js";

export interface StandardPlainWgslAdapterOptions {
  readonly alphaMode: "opaque" | "mask" | "blend";
  readonly doubleSided: boolean;
  readonly materialMode?: "plain" | "base-color-texture";
  readonly normalMapped?: boolean;
}

export function exactlyOnce(source: string, token: string): boolean {
  return source.indexOf(token) >= 0 && source.indexOf(token) === source.lastIndexOf(token);
}

const plainAttributes = Object.freeze([
  ["POSITION", "position"], ["NORMAL", "normal"],
  ["MODEL_ROW_0", "modelRow0"], ["MODEL_ROW_1", "modelRow1"], ["MODEL_ROW_2", "modelRow2"],
  ["NORMAL_COLUMN_0", "normalColumn0"], ["NORMAL_COLUMN_1", "normalColumn1"], ["NORMAL_COLUMN_2", "normalColumn2"],
  ["BASE_COLOR_METALLIC", "colorMetal"],
  ["ROUGHNESS_ALPHA_CUTOFF_HANDEDNESS_FLAGS", "material"], ["EMISSIVE_ALPHA", "emissiveAlpha"],
] as const);

const textureAttributes = Object.freeze([
  ...plainAttributes,
  ["TEXCOORD_0", "uv0"], ["TEXCOORD_1", "uv1"],
] as const);

const normalTextureAttributes = Object.freeze([
  ...textureAttributes,
  ["TANGENT", "tangent"],
] as const);

function resourceSignature(binding: ShaderCompilerBindingLayoutEntry): string {
  return [binding.group, binding.binding, binding.name, binding.visibility.join("+"), binding.resource,
    binding.dataLayout ?? "", binding.minBindingSize ?? ""].join(":");
}

function abiResourceSignature(binding: typeof DEEP_PBR_MESH_V1.bindGroupLayouts[0]["bindings"][number]): string {
  const resource = binding.resource;
  const kind = resource.kind === "uniform-buffer" ? "uniform-buffer"
    : resource.kind === "texture"
      ? resource.sampleType === "depth" ? "texture-depth-2d"
        : resource.viewDimension === "cube" ? "texture-cube-f32" : "texture-2d-f32"
      : resource.samplerType === "comparison" ? "comparison-sampler" : "sampler";
  return [0, binding.binding, binding.name, binding.visibility.join("+"), kind,
    resource.kind === "uniform-buffer" ? resource.dataLayout : "",
    resource.kind === "uniform-buffer" ? resource.minBindingSize : ""].join(":");
}

function matchesForwardFrame(pass: CompiledShaderPass): boolean {
  const expected = DEEP_PBR_MESH_V1.bindGroupLayouts.find((layout) => layout.id === "forward-frame")!;
  const expectedFrame = DEEP_PBR_MESH_V1.dataLayouts.find((layout) => layout.id === "frame")!;
  const lighting = pass.lightingContext;
  if (!lighting || lighting.frameAbi !== "deep.pbr.mesh.v1/forward-frame"
    || lighting.packageCompatibility !== "requires-layout-adapter"
    || lighting.bindings.length !== expected.bindings.length
    || lighting.dataLayouts.length !== 1) return false;
  const frame = lighting.dataLayouts[0];
  const frameMatches = frame?.id === "frame" && frame.byteSize === expectedFrame.byteSize
    && frame.byteAlignment === expectedFrame.byteAlignment
    && frame.members.length === expectedFrame.members.length
    && frame.members.every((member, index) => {
      const expectedMember = expectedFrame.members[index];
      const expectedType = expectedMember?.format === "mat4x4<f32>" ? "mat4x4f" : "vec4f";
      return member.name === expectedMember?.name && member.type === expectedType
        && member.byteOffset === expectedMember.byteOffset && member.byteSize === expectedMember.byteSize;
    });
  if (!frameMatches) return false;
  return lighting.bindings.map(resourceSignature).join("|")
    === expected.bindings.map(abiResourceSignature).join("|");
}

export function matchesVertexStreams(asset: DeepShaderAsset, textured: boolean, normalMapped: boolean): boolean {
  const requiredAttributes = normalMapped ? normalTextureAttributes : textured ? textureAttributes : plainAttributes;
  if (asset.properties.length !== 0 || asset.resources.length !== 0
    || asset.attributes.length !== requiredAttributes.length) return false;
  const abiAttributes = new Map(DEEP_PBR_MESH_V1.vertexStreams
    .filter((stream) => stream.id === "geometry" || stream.id === "instance" || (normalMapped && stream.id === "tangent"))
    .flatMap((stream) => stream.attributes.map((attribute) => [attribute.semantic, attribute] as const)));
  return requiredAttributes.every(([semantic, name]) => {
    const actual = asset.attributes.find((attribute) => attribute.semantic === semantic);
    const expected = abiAttributes.get(semantic);
    const expectedType = expected?.format === "float32x3" ? "vec3f"
      : expected?.format === "float32x4" ? "vec4f" : "vec2f";
    return actual?.name === name && actual.location === expected?.shaderLocation && actual.format === expected?.format
      && actual?.type === expectedType;
  });
}

export function matchesGeneratedInterface(
  pass: CompiledShaderPass,
  asset: DeepShaderAsset,
  options: StandardPlainWgslAdapterOptions,
): boolean {
  const code = pass.module.code;
  if (pass.kind !== "forward" || pass.passId !== "forward"
    || pass.entryPoints.vertex !== "deepVertex" || pass.entryPoints.fragment !== "deepFragment"
    || pass.propertyLayout.length !== 0 || !matchesForwardFrame(pass)
    || code.includes("fn shadowMain(") || code.includes("fn shadowMaskMain(")) return false;
  const bindings = [...code.matchAll(/@group\((\d+)\)\s+@binding\((\d+)\)/gu)]
    .map((match) => `${match[1]}:${match[2]}`);
  if (bindings.join("|") !== "0:0|0:1|0:2|0:3|0:4|0:5|0:6") return false;
  if (!code.includes("var<uniform> deepPbrFrame: DeepPbrFrame;")) return false;
  for (const attribute of asset.attributes) {
    const type = attribute.type === "vec2f" ? "vec2f" : attribute.type === "vec3f" ? "vec3f" : "vec4f";
    if (!code.includes(`@location(${attribute.location}) a_${attribute.name}: ${type}`)) return false;
  }
  if (options.materialMode === "base-color-texture" && (
    !exactlyOnce(code, "@location(5) v_surfaceUv0: vec2f,")
    || !exactlyOnce(code, "@location(6) v_surfaceUv1: vec2f,")
    || !exactlyOnce(code, "output.v_surfaceUv0 = n_uv0;")
    || !exactlyOnce(code, "output.v_surfaceUv1 = n_uv1;")
  )) return false;
  if (options.normalMapped && (
    !exactlyOnce(code, "@location(7) v_surfaceTangent: vec4f,")
    || !exactlyOnce(code, "output.v_surfaceTangent = n_tangentWorld;")
  )) return false;
  const expectedAlpha = options.alphaMode === "opaque"
    ? "let n_alpha: f32 = 1.0;"
    : "let n_alpha: f32 = n_emissiveAlpha.a;";
  return exactlyOnce(code, "@vertex fn deepVertex(")
    && exactlyOnce(code, "@fragment fn deepFragment(")
    && exactlyOnce(code, expectedAlpha)
    && exactlyOnce(code, "let n_surfaceNormal: vec3f = normalize(n_normalInput);")
    && exactlyOnce(code, "return deepLowerStandardPbr(input.v_worldPosition, n_baseColor, n_surfaceNormal,");
}

export function validOptions(options: StandardPlainWgslAdapterOptions): boolean {
  return (options.alphaMode === "opaque" || options.alphaMode === "mask" || options.alphaMode === "blend")
    && typeof options.doubleSided === "boolean"
    && (options.normalMapped === undefined || typeof options.normalMapped === "boolean")
    && (!options.normalMapped || options.materialMode === "base-color-texture")
    && (options.materialMode === undefined || options.materialMode === "plain"
      || options.materialMode === "base-color-texture");
}
