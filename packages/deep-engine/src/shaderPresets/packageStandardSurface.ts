import { validateShaderAsset } from "../shader/validation.js";
import type {
  DeepShaderAsset, ShaderNode, ShaderPass, ShaderRenderState, ShaderStageGraph,
} from "../shader/types.js";
import type { ShaderPresetBuildResult, ShaderPresetIssue } from "./types.js";

export interface DeepPbrMeshV1StandardOptions {
  readonly id: string;
  readonly alphaMode: "opaque" | "blend";
  readonly materialMode?: "plain" | "base-color-texture";
  readonly normalMapped?: boolean;
}

function issue(path: string, message: string): ShaderPresetIssue {
  return Object.freeze({
    severity: "error", code: "invalid-asset", path, feature: "deep-pbr-mesh-v1", message,
  });
}

function state(alphaMode: DeepPbrMeshV1StandardOptions["alphaMode"]): ShaderRenderState {
  return {
    topology: "triangle-list", cullMode: "back", frontFace: "ccw",
    depthCompare: "less", depthWrite: alphaMode === "opaque", colorWriteMask: 15,
    ...(alphaMode === "blend" ? { blend: {
      color: { srcFactor: "src-alpha" as const, dstFactor: "one-minus-src-alpha" as const, operation: "add" as const },
      alpha: { srcFactor: "one" as const, dstFactor: "one-minus-src-alpha" as const, operation: "add" as const },
    } } : {}),
  };
}

function vertexGraph(
  materialMode: NonNullable<DeepPbrMeshV1StandardOptions["materialMode"]>,
  normalMapped: boolean,
): ShaderStageGraph {
  const transformNodes: ShaderNode[] = [0, 1, 2].flatMap((index) => [
    { id: `modelRow${index}`, op: "attribute" as const, type: "vec4f" as const, name: `modelRow${index}` },
    { id: `normalColumn${index}`, op: "attribute" as const, type: "vec4f" as const, name: `normalColumn${index}` },
  ]);
  const tangentNodes: ShaderNode[] = normalMapped ? [
    { id: "tangent", op: "attribute", type: "vec4f", name: "tangent" },
    { id: "tangentDirection", op: "swizzle", type: "vec3f", mask: "xyz", inputs: ["tangent"] },
    { id: "zero", op: "literal", type: "f32", value: 0 },
    { id: "tangentDirection4", op: "compose-vec4", type: "vec4f", inputs: ["tangentDirection", "zero"] },
    ...[0, 1, 2].flatMap<ShaderNode>((index) => [
      { id: `tangentWorldComponent${index}`, op: "dot", type: "f32", inputs: [`modelRow${index}`, "tangentDirection4"] },
      { id: `tangentWorldBasis${index}`, op: "literal", type: "vec3f",
        value: [Number(index === 0), Number(index === 1), Number(index === 2)] },
      { id: `tangentWorldAxis${index}`, op: "scale", type: "vec3f",
        inputs: [`tangentWorldBasis${index}`, `tangentWorldComponent${index}`] },
    ]),
    { id: "tangentWorld01", op: "add", type: "vec3f",
      inputs: ["tangentWorldAxis0", "tangentWorldAxis1"] },
    { id: "tangentWorldDirection", op: "add", type: "vec3f",
      inputs: ["tangentWorld01", "tangentWorldAxis2"] },
    { id: "tangentSign", op: "swizzle", type: "f32", mask: "w", inputs: ["tangent"] },
    { id: "tangentWorld", op: "compose-vec4", type: "vec4f",
      inputs: ["tangentWorldDirection", "tangentSign"] },
  ] : [];
  return {
    nodes: [
      { id: "position", op: "attribute", type: "vec3f", name: "position" },
      { id: "normal", op: "attribute", type: "vec3f", name: "normal" },
      ...transformNodes,
      { id: "colorMetal", op: "attribute", type: "vec4f", name: "colorMetal" },
      { id: "material", op: "attribute", type: "vec4f", name: "material" },
      { id: "emissiveAlpha", op: "attribute", type: "vec4f", name: "emissiveAlpha" },
      ...(materialMode === "base-color-texture" ? [
        { id: "uv0", op: "attribute" as const, type: "vec2f" as const, name: "uv0" },
        { id: "uv1", op: "attribute" as const, type: "vec2f" as const, name: "uv1" },
      ] : []),
      ...tangentNodes,
      { id: "one", op: "literal", type: "f32", value: 1 },
      { id: "position4", op: "compose-vec4", type: "vec4f", inputs: ["position", "one"] },
      ...[0, 1, 2].flatMap<ShaderNode>((index) => [
        { id: `worldComponent${index}`, op: "dot", type: "f32", inputs: [`modelRow${index}`, "position4"] },
        { id: `worldBasis${index}`, op: "literal", type: "vec3f", value: [Number(index === 0), Number(index === 1), Number(index === 2)] },
        { id: `worldAxis${index}`, op: "scale", type: "vec3f", inputs: [`worldBasis${index}`, `worldComponent${index}`] },
      ]),
      { id: "worldPosition01", op: "add", type: "vec3f", inputs: ["worldAxis0", "worldAxis1"] },
      { id: "worldPosition", op: "add", type: "vec3f", inputs: ["worldPosition01", "worldAxis2"] },
      ...[0, 1, 2].flatMap<ShaderNode>((index) => [
        { id: `normalComponent${index}`, op: "swizzle", type: "f32", mask: "xyz"[index]!, inputs: ["normal"] },
        { id: `normalBasis${index}`, op: "swizzle", type: "vec3f", mask: "xyz", inputs: [`normalColumn${index}`] },
        { id: `normalAxis${index}`, op: "scale", type: "vec3f", inputs: [`normalBasis${index}`, `normalComponent${index}`] },
      ]),
      { id: "normalWorld01", op: "add", type: "vec3f", inputs: ["normalAxis0", "normalAxis1"] },
      { id: "normalWorldRaw", op: "add", type: "vec3f", inputs: ["normalWorld01", "normalAxis2"] },
      { id: "normalWorld", op: "normalize", type: "vec3f", inputs: ["normalWorldRaw"] },
      { id: "pbrFrameView", op: "pbr-frame-view", type: "mat4x4f" },
      { id: "clipPosition", op: "transform-position", type: "vec4f", inputs: ["pbrFrameView", "worldPosition"] },
    ],
    outputs: [
      { semantic: "position", node: "clipPosition" },
      { semantic: "varying", name: "worldPosition", node: "worldPosition" },
      { semantic: "varying", name: "normalWorld", node: "normalWorld" },
      { semantic: "varying", name: "surfaceColorMetal", node: "colorMetal" },
      { semantic: "varying", name: "surfaceMaterial", node: "material" },
      { semantic: "varying", name: "surfaceEmissiveAlpha", node: "emissiveAlpha" },
      ...(materialMode === "base-color-texture" ? [
        { semantic: "varying" as const, name: "surfaceUv0", node: "uv0" },
        { semantic: "varying" as const, name: "surfaceUv1", node: "uv1" },
      ] : []),
      ...(normalMapped ? [
        { semantic: "varying" as const, name: "surfaceTangent", node: "tangentWorld" },
      ] : []),
    ],
  };
}

function fragmentGraph(alphaMode: DeepPbrMeshV1StandardOptions["alphaMode"]): ShaderStageGraph {
  const alphaNode: ShaderNode = alphaMode === "blend"
    ? { id: "alpha", op: "swizzle", type: "f32", mask: "a", inputs: ["emissiveAlpha"] }
    : { id: "alpha", op: "literal", type: "f32", value: 1 };
  return {
    nodes: [
      { id: "worldPosition", op: "varying", type: "vec3f", name: "worldPosition" },
      { id: "normalInput", op: "varying", type: "vec3f", name: "normalWorld" },
      { id: "surfaceNormal", op: "normalize", type: "vec3f", inputs: ["normalInput"] },
      { id: "colorMetal", op: "varying", type: "vec4f", name: "surfaceColorMetal" },
      { id: "material", op: "varying", type: "vec4f", name: "surfaceMaterial" },
      { id: "emissiveAlpha", op: "varying", type: "vec4f", name: "surfaceEmissiveAlpha" },
      { id: "baseColor", op: "swizzle", type: "vec3f", mask: "rgb", inputs: ["colorMetal"] },
      { id: "metallic", op: "swizzle", type: "f32", mask: "a", inputs: ["colorMetal"] },
      { id: "roughness", op: "swizzle", type: "f32", mask: "x", inputs: ["material"] },
      { id: "emission", op: "swizzle", type: "vec3f", mask: "rgb", inputs: ["emissiveAlpha"] },
      alphaNode,
      { id: "occlusion", op: "literal", type: "f32", value: 1 },
    ],
    outputs: [{
      semantic: "surface", model: "standard-pbr", context: "deep-lighting-v1",
      fields: { baseColor: "baseColor", normal: "surfaceNormal", metallic: "metallic", roughness: "roughness",
        occlusion: "occlusion", emission: "emission", alpha: "alpha" },
    }],
  };
}

/**
 * Property-free Standard Surface IR whose material inputs come from the canonical
 * deep.pbr.mesh.v1 instance stream. This is the executable plain-material subset.
 */
export function buildDeepPbrMeshV1StandardShader(
  options: DeepPbrMeshV1StandardOptions,
): ShaderPresetBuildResult {
  const materialMode = options.materialMode ?? "plain";
  const normalMapped = options.normalMapped ?? false;
  if (options.alphaMode !== "opaque" && options.alphaMode !== "blend") return Object.freeze({
    ok: false,
    issues: Object.freeze([issue("$.alphaMode", "deep.pbr.mesh.v1 Standard accepts opaque or blend alpha only.")]),
  });
  if (materialMode !== "plain" && materialMode !== "base-color-texture") return Object.freeze({
    ok: false,
    issues: Object.freeze([issue("$.materialMode", "deep.pbr.mesh.v1 Standard accepts plain or base-color-texture material input only.")]),
  });
  if (typeof normalMapped !== "boolean" || (normalMapped && materialMode !== "base-color-texture")) return Object.freeze({
    ok: false,
    issues: Object.freeze([issue("$.normalMapped", "Normal mapping requires the fixed material texture ABI.")]),
  });
  const forward: ShaderPass = {
    id: "forward", kind: "forward", state: state(options.alphaMode),
    vertex: vertexGraph(materialMode, normalMapped), fragment: fragmentGraph(options.alphaMode),
  };
  const asset: DeepShaderAsset = {
    schemaVersion: 1, id: options.id, properties: [], resources: [],
    attributes: [
      { name: "position", semantic: "POSITION", location: 0, format: "float32x3", type: "vec3f" },
      { name: "normal", semantic: "NORMAL", location: 1, format: "float32x3", type: "vec3f" },
      ...[0, 1, 2].map((index) => (
        { name: `modelRow${index}`, semantic: `MODEL_ROW_${index}`, location: 2 + index, format: "float32x4" as const, type: "vec4f" as const }
      )),
      ...[0, 1, 2].map((index) => (
        { name: `normalColumn${index}`, semantic: `NORMAL_COLUMN_${index}`, location: 5 + index, format: "float32x4" as const, type: "vec4f" as const }
      )),
      { name: "colorMetal", semantic: "BASE_COLOR_METALLIC", location: 8, format: "float32x4", type: "vec4f" },
      { name: "material", semantic: "ROUGHNESS_ALPHA_CUTOFF_HANDEDNESS_FLAGS", location: 9, format: "float32x4", type: "vec4f" },
      { name: "emissiveAlpha", semantic: "EMISSIVE_ALPHA", location: 12, format: "float32x4", type: "vec4f" },
      ...(materialMode === "base-color-texture" ? [
        { name: "uv0", semantic: "TEXCOORD_0", location: 10, format: "float32x2" as const, type: "vec2f" as const },
        { name: "uv1", semantic: "TEXCOORD_1", location: 13, format: "float32x2" as const, type: "vec2f" as const },
      ] : []),
      ...(normalMapped ? [
        { name: "tangent", semantic: "TANGENT", location: 11, format: "float32x4" as const, type: "vec4f" as const },
      ] : []),
    ],
    varyings: [
      { name: "worldPosition", location: 0, type: "vec3f" },
      { name: "normalWorld", location: 1, type: "vec3f" },
      { name: "surfaceColorMetal", location: 2, type: "vec4f" },
      { name: "surfaceMaterial", location: 3, type: "vec4f" },
      { name: "surfaceEmissiveAlpha", location: 4, type: "vec4f" },
      ...(materialMode === "base-color-texture" ? [
        { name: "surfaceUv0", location: 5, type: "vec2f" as const },
        { name: "surfaceUv1", location: 6, type: "vec2f" as const },
      ] : []),
      ...(normalMapped ? [
        { name: "surfaceTangent", location: 7, type: "vec4f" as const },
      ] : []),
    ],
    keywords: [], techniques: [{ id: "webgpu", requirements: { webgpu: true }, passes: [forward] }],
  };
  const validation = validateShaderAsset(asset);
  if (!validation.valid || !validation.value) return Object.freeze({
    ok: false,
    issues: Object.freeze(validation.diagnostics.map((entry) => issue(entry.path, entry.message))),
  });
  return Object.freeze({ ok: true, asset: validation.value, issues: Object.freeze([]) });
}
