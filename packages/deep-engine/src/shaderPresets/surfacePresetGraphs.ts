import type {
  ShaderNode, ShaderPass, ShaderRenderState, ShaderStageGraph, ShaderStageOutput,
} from "../shader/types.js";
import type { SurfaceAlphaMode } from "./types.js";

export type SurfacePresetKind = "standard-surface" | "unlit";

export function surfaceState(alpha: SurfaceAlphaMode, doubleSided: boolean, color: boolean): ShaderRenderState {
  return {
    topology: "triangle-list", cullMode: doubleSided ? "none" : "back", frontFace: "ccw",
    depthCompare: "less-equal", depthWrite: alpha !== "blend", colorWriteMask: color ? 15 : 0,
    ...(alpha === "blend" ? { blend: {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    } } : {}),
  };
}

function unlitVertexGraph(textured: boolean): ShaderStageGraph {
  return {
    nodes: [
      { id: "position", op: "attribute", type: "vec3f", name: "position" },
      { id: "one", op: "literal", type: "f32", value: 1 },
      { id: "clipPosition", op: "compose-vec4", type: "vec4f", inputs: ["position", "one"] },
      ...(textured ? [{ id: "uv0", op: "attribute", type: "vec2f", name: "uv0" } as const] : []),
    ],
    outputs: [
      { semantic: "position", node: "clipPosition" },
      ...(textured ? [{ semantic: "varying", name: "surfaceUv", node: "uv0" } as const] : []),
    ],
  };
}

function standardWorldNodes(): ShaderNode[] {
  return [
    { id: "position", op: "attribute", type: "vec3f", name: "position" },
    { id: "one", op: "literal", type: "f32", value: 1 },
    { id: "position4", op: "compose-vec4", type: "vec4f", inputs: ["position", "one"] },
    ...[0, 1, 2].flatMap<ShaderNode>((index) => [
      { id: `modelRow${index}`, op: "attribute", type: "vec4f", name: `modelRow${index}` },
      { id: `worldComponent${index}`, op: "dot", type: "f32", inputs: [`modelRow${index}`, "position4"] },
      { id: `worldBasis${index}`, op: "literal", type: "vec3f", value: [Number(index === 0), Number(index === 1), Number(index === 2)] },
      { id: `worldAxis${index}`, op: "scale", type: "vec3f", inputs: [`worldBasis${index}`, `worldComponent${index}`] },
    ]),
    { id: "worldPosition01", op: "add", type: "vec3f", inputs: ["worldAxis0", "worldAxis1"] },
    { id: "worldPosition", op: "add", type: "vec3f", inputs: ["worldPosition01", "worldAxis2"] },
  ];
}

function standardVertexGraph(textured: boolean, auxiliary: boolean): ShaderStageGraph {
  const normalNodes: ShaderNode[] = auxiliary ? [] : [
    { id: "normal", op: "attribute", type: "vec3f", name: "normal" },
    ...[0, 1, 2].flatMap<ShaderNode>((index) => [
      { id: `normalColumn${index}`, op: "attribute", type: "vec4f", name: `normalColumn${index}` },
      { id: `normalComponent${index}`, op: "swizzle", type: "f32", mask: "xyz"[index]!, inputs: ["normal"] },
      { id: `normalBasis${index}`, op: "swizzle", type: "vec3f", mask: "xyz", inputs: [`normalColumn${index}`] },
      { id: `normalAxis${index}`, op: "scale", type: "vec3f", inputs: [`normalBasis${index}`, `normalComponent${index}`] },
    ]),
    { id: "normalWorld01", op: "add", type: "vec3f", inputs: ["normalAxis0", "normalAxis1"] },
    { id: "normalWorldRaw", op: "add", type: "vec3f", inputs: ["normalWorld01", "normalAxis2"] },
    { id: "normalWorld", op: "normalize", type: "vec3f", inputs: ["normalWorldRaw"] },
  ];
  const viewNode: ShaderNode = auxiliary
    ? { id: "passViewProjection", op: "property", type: "mat4x4f", name: "passViewProjection" }
    : { id: "pbrFrameView", op: "pbr-frame-view", type: "mat4x4f" };
  return {
    nodes: [
      ...standardWorldNodes(), ...normalNodes, viewNode,
      { id: "clipPosition", op: "transform-position", type: "vec4f", inputs: [auxiliary ? "passViewProjection" : "pbrFrameView", "worldPosition"] },
      ...(textured ? [{ id: "uv0", op: "attribute", type: "vec2f", name: "uv0" } as const] : []),
    ],
    outputs: [
      { semantic: "position", node: "clipPosition" },
      ...(!auxiliary ? [
        { semantic: "varying", name: "worldPosition", node: "worldPosition" } as const,
        { semantic: "varying", name: "normalWorld", node: "normalWorld" } as const,
      ] : []),
      ...(textured ? [{ semantic: "varying", name: "surfaceUv", node: "uv0" } as const] : []),
    ],
  };
}

function colorNodes(textured: boolean): { nodes: ShaderNode[]; color: string } {
  const nodes: ShaderNode[] = [
    ...(textured ? [
      { id: "surfaceUv", op: "varying" as const, type: "vec2f" as const, name: "surfaceUv" },
      { id: "baseColorSample", op: "texture-sample" as const, type: "color" as const, texture: "baseColorTexture", sampler: "surfaceSampler", inputs: ["surfaceUv"] as const },
    ] : []),
    { id: "baseColor", op: "property", type: "color", name: "baseColor" },
    ...(textured ? [{ id: "tintedBaseColor", op: "multiply" as const, type: "color" as const, inputs: ["baseColorSample", "baseColor"] as const }] : []),
  ];
  return { nodes, color: textured ? "tintedBaseColor" : "baseColor" };
}

function clipGraphParts(color: string): { nodes: ShaderNode[]; output: ShaderStageOutput } {
  return {
    nodes: [
      { id: "alpha", op: "swizzle", type: "f32", mask: "a", inputs: [color] },
      { id: "alphaCutoff", op: "property", type: "f32", name: "alphaCutoff" },
    ],
    output: { semantic: "alpha-clip", alpha: "alpha", cutoff: "alphaCutoff" },
  };
}

function unlitFragmentGraph(textured: boolean, masked: boolean): ShaderStageGraph {
  const base = colorNodes(textured);
  const clip = clipGraphParts(base.color);
  return {
    nodes: [...base.nodes, ...(masked ? clip.nodes : [])],
    outputs: [{ semantic: "color", node: base.color }, ...(masked ? [clip.output] : [])],
  };
}

function standardFragmentGraph(textured: boolean, masked: boolean): ShaderStageGraph {
  const base = colorNodes(textured);
  const clip = clipGraphParts(base.color);
  return {
    nodes: [
      ...base.nodes, { id: "surfaceBaseColor", op: "swizzle", type: "vec3f", mask: "rgb", inputs: [base.color] },
      { id: "alpha", op: "swizzle", type: "f32", mask: "a", inputs: [base.color] },
      { id: "normalInput", op: "varying", type: "vec3f", name: "normalWorld" },
      { id: "surfaceNormal", op: "normalize", type: "vec3f", inputs: ["normalInput"] },
      { id: "metallic", op: "property", type: "f32", name: "metallic" },
      { id: "roughness", op: "property", type: "f32", name: "roughness" },
      { id: "occlusion", op: "literal", type: "f32", value: 1 },
      { id: "emission", op: "literal", type: "vec3f", value: [0, 0, 0] },
      ...(masked ? [{ id: "alphaCutoff", op: "property" as const, type: "f32" as const, name: "alphaCutoff" }] : []),
    ],
    outputs: [{
      semantic: "surface", model: "standard-pbr", context: "deep-lighting-v1",
      fields: { baseColor: "surfaceBaseColor", normal: "surfaceNormal", metallic: "metallic", roughness: "roughness", occlusion: "occlusion", emission: "emission", alpha: "alpha" },
    }, ...(masked ? [clip.output] : [])],
  };
}

function auxiliaryFragmentGraph(textured: boolean, picking: boolean): ShaderStageGraph {
  const base = colorNodes(textured);
  const clip = clipGraphParts(base.color);
  return {
    nodes: [...base.nodes, ...clip.nodes, ...(picking ? [{ id: "objectId", op: "property" as const, type: "color" as const, name: "objectId" }] : [])],
    outputs: [...(picking ? [{ semantic: "color" as const, node: "objectId" }] : []), clip.output],
  };
}

function pickingGraph(): ShaderStageGraph {
  return { nodes: [{ id: "objectId", op: "property", type: "color", name: "objectId" }], outputs: [{ semantic: "color", node: "objectId" }] };
}

export function makeSurfacePass(
  preset: SurfacePresetKind, id: string, kind: ShaderPass["kind"], alpha: SurfaceAlphaMode,
  hasTextureIo: boolean, samplesTexture: boolean, doubleSided: boolean, predicate?: ShaderPass["predicate"],
): ShaderPass {
  const color = kind === "forward" || kind === "picking";
  const masked = alpha === "mask";
  const vertex = preset === "standard-surface"
    ? standardVertexGraph(hasTextureIo, kind !== "forward") : unlitVertexGraph(hasTextureIo);
  const fragment = kind === "forward"
    ? preset === "standard-surface" ? standardFragmentGraph(samplesTexture, masked) : unlitFragmentGraph(samplesTexture, masked)
    : masked ? auxiliaryFragmentGraph(samplesTexture, kind === "picking") : kind === "picking" ? pickingGraph() : undefined;
  return { id, kind, ...(predicate ? { predicate } : {}), state: surfaceState(alpha, doubleSided, color), vertex, ...(fragment ? { fragment } : {}) };
}
