import { validateShaderAsset } from "../shader/validation.js";
import type {
  DeepShaderAsset, ShaderFeaturePredicate, ShaderNode, ShaderPass, ShaderRenderState, ShaderStageGraph,
} from "../shader/types.js";
import type {
  ShaderPresetBuildResult, ShaderPresetIssue, StandardSurfaceShaderOptions,
  SurfaceAlphaMode, SurfaceShaderOptions, UnlitShaderOptions,
} from "./types.js";

type PresetKind = "standard-surface" | "unlit";
type RuntimeAlpha = Exclude<SurfaceAlphaMode, "mask">;

function error(path: string, feature: string, message: string, code: ShaderPresetIssue["code"] = "unsupported-feature"): ShaderPresetIssue {
  return Object.freeze({ severity: "error", code, path, feature, message });
}

function validUnit(value: number | undefined, path: string, issues: ShaderPresetIssue[]): void {
  if (value !== undefined && (!Number.isFinite(value) || Object.is(value, -0) || value < 0 || value > 1)) {
    issues.push(error(path, path.slice(2), "Expected a finite value from 0 to 1.", "invalid-option"));
  }
}

function validateOptions(kind: PresetKind, options: StandardSurfaceShaderOptions | UnlitShaderOptions, issues: ShaderPresetIssue[]): void {
  if (options.baseColor !== undefined && (options.baseColor.length !== 4
    || options.baseColor.some((value) => !Number.isFinite(value) || Object.is(value, -0) || value < 0 || value > 1))) {
    issues.push(error("$.baseColor", "base-color", "Expected four finite linear color components from 0 to 1.", "invalid-option"));
  }
  if (options.alphaMode === "mask") {
    issues.push(error("$.alphaMode", "alpha-mask", "Alpha mask needs discard/alpha-clip support, which Shader IR schema v1 does not expose."));
  }
  if (options.normalTexture) {
    issues.push(error("$.normalTexture", "normal-texture", "Normal mapping needs tangent-space and lighting nodes that are outside the current compiler subset."));
  }
  if (options.occlusionTexture) {
    issues.push(error("$.occlusionTexture", "occlusion-texture", "Occlusion sampling is not represented by the current surface compiler subset."));
  }
  if (kind === "standard-surface") {
    const standard = options as StandardSurfaceShaderOptions;
    validUnit(standard.metallic, "$.metallic", issues);
    validUnit(standard.roughness, "$.roughness", issues);
    if (standard.metallicRoughnessTexture) {
      issues.push(error("$.metallicRoughnessTexture", "metallic-roughness-texture", "Metallic/roughness texture channels need PBR lighting nodes that are not available in Shader IR schema v1."));
    }
    if (standard.passes && (standard.passes.depth || standard.passes.shadow || standard.passes.picking)) {
      issues.push(error("$.passes", "pbr-auxiliary-passes", "Standard Surface auxiliary passes need explicit deep.pbr.mesh.v1 pass ABI lowering; this preset currently emits forward passes only."));
    }
  }
  const fixedBlend = options.alphaMode === "blend" && !options.switchableAlpha;
  if (fixedBlend && (options.passes?.depth || options.passes?.shadow)) {
    issues.push(error("$.passes", "transparent-depth-shadow", "The current depth/shadow passes cannot alpha-clip blended surfaces; omit them or use switchable alpha so they are opaque-only."));
  }
}

function state(alpha: RuntimeAlpha, doubleSided: boolean, color: boolean): ShaderRenderState {
  return {
    topology: "triangle-list", cullMode: doubleSided ? "none" : "back", frontFace: "ccw",
    depthCompare: "less-equal", depthWrite: alpha === "opaque", colorWriteMask: color ? 15 : 0,
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

function standardVertexGraph(textured: boolean): ShaderStageGraph {
  return {
    nodes: [
      { id: "position", op: "attribute", type: "vec3f", name: "position" },
      { id: "normal", op: "attribute", type: "vec3f", name: "normal" },
      ...[0, 1, 2].flatMap<ShaderNode>((index) => [
        { id: `modelRow${index}`, op: "attribute" as const, type: "vec4f" as const, name: `modelRow${index}` },
        { id: `normalColumn${index}`, op: "attribute" as const, type: "vec4f" as const, name: `normalColumn${index}` },
      ]),
      { id: "one", op: "literal", type: "f32", value: 1 },
      { id: "position4", op: "compose-vec4", type: "vec4f", inputs: ["position", "one"] },
      ...[0, 1, 2].flatMap<ShaderNode>((index) => [
        { id: `worldComponent${index}`, op: "dot", type: "f32", inputs: [`modelRow${index}`, "position4"] },
        { id: `worldBasis${index}`, op: "literal" as const, type: "vec3f" as const, value: [Number(index === 0), Number(index === 1), Number(index === 2)] },
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
      ...(textured ? [{ id: "uv0", op: "attribute", type: "vec2f", name: "uv0" } as const] : []),
    ],
    outputs: [
      { semantic: "position", node: "clipPosition" },
      { semantic: "varying", name: "worldPosition", node: "worldPosition" },
      { semantic: "varying", name: "normalWorld", node: "normalWorld" },
      ...(textured ? [{ semantic: "varying", name: "surfaceUv", node: "uv0" } as const] : []),
    ],
  };
}

function unlitFragmentGraph(textured: boolean): ShaderStageGraph {
  if (!textured) return {
    nodes: [{ id: "baseColor", op: "property", type: "color", name: "baseColor" }],
    outputs: [{ semantic: "color", node: "baseColor" }],
  };
  return {
    nodes: [
      { id: "surfaceUv", op: "varying", type: "vec2f", name: "surfaceUv" },
      { id: "baseColorSample", op: "texture-sample", type: "color", texture: "baseColorTexture", sampler: "surfaceSampler", inputs: ["surfaceUv"] },
      { id: "baseColor", op: "property", type: "color", name: "baseColor" },
      { id: "tintedBaseColor", op: "multiply", type: "color", inputs: ["baseColorSample", "baseColor"] },
    ],
    outputs: [{ semantic: "color", node: "tintedBaseColor" }],
  };
}

function standardFragmentGraph(textured: boolean): ShaderStageGraph {
  const colorNode = textured ? "tintedBaseColor" : "baseColor";
  const textureNodes: ShaderNode[] = textured ? [
    { id: "surfaceUv", op: "varying", type: "vec2f", name: "surfaceUv" },
    { id: "baseColorSample", op: "texture-sample", type: "color", texture: "baseColorTexture", sampler: "surfaceSampler", inputs: ["surfaceUv"] },
  ] : [];
  const tintNodes: ShaderNode[] = textured
    ? [{ id: "tintedBaseColor", op: "multiply", type: "color", inputs: ["baseColorSample", "baseColor"] }]
    : [];
  return {
    nodes: [
      ...textureNodes,
      { id: "baseColor", op: "property", type: "color", name: "baseColor" },
      ...tintNodes,
      { id: "surfaceBaseColor", op: "swizzle", type: "vec3f", mask: "rgb", inputs: [colorNode] },
      { id: "alpha", op: "swizzle", type: "f32", mask: "a", inputs: [colorNode] },
      { id: "normalInput", op: "varying", type: "vec3f", name: "normalWorld" },
      { id: "surfaceNormal", op: "normalize", type: "vec3f", inputs: ["normalInput"] },
      { id: "metallic", op: "property", type: "f32", name: "metallic" },
      { id: "roughness", op: "property", type: "f32", name: "roughness" },
      { id: "occlusion", op: "literal", type: "f32", value: 1 },
      { id: "emission", op: "literal", type: "vec3f", value: [0, 0, 0] },
    ],
    outputs: [{
      semantic: "surface", model: "standard-pbr", context: "deep-lighting-v1",
      fields: {
        baseColor: "surfaceBaseColor", normal: "surfaceNormal", metallic: "metallic",
        roughness: "roughness", occlusion: "occlusion", emission: "emission", alpha: "alpha",
      },
    }],
  };
}

function pickingGraph(): ShaderStageGraph {
  return {
    nodes: [{ id: "objectId", op: "property", type: "color", name: "objectId" }],
    outputs: [{ semantic: "color", node: "objectId" }],
  };
}

function predicate(alpha: RuntimeAlpha, textured: boolean, alphaVariant: boolean, textureVariant: boolean): ShaderFeaturePredicate | undefined {
  const terms: ShaderFeaturePredicate[] = [];
  if (alphaVariant) terms.push({ op: "keyword", name: "ALPHA_MODE", equals: alpha.toUpperCase() });
  if (textureVariant) terms.push({ op: "keyword", name: "BASE_COLOR_TEXTURE", equals: textured ? "ON" : "OFF" });
  if (terms.length === 0) return undefined;
  return terms.length === 1 ? terms[0] : { op: "all", terms };
}

function forwardId(alpha: RuntimeAlpha, textured: boolean, alphaVariant: boolean, textureVariant: boolean): string {
  if (!alphaVariant && !textureVariant) return "forward";
  return `forward${alphaVariant ? alpha[0]!.toUpperCase() + alpha.slice(1) : ""}${textureVariant ? (textured ? "Textured" : "Color") : ""}`;
}

function makePass(
  presetKind: PresetKind,
  id: string,
  kind: ShaderPass["kind"],
  alpha: RuntimeAlpha,
  hasTextureIo: boolean,
  samplesTexture: boolean,
  doubleSided: boolean,
  passPredicate?: ShaderFeaturePredicate,
): ShaderPass {
  const color = kind === "forward" || kind === "picking";
  return {
    id, kind, ...(passPredicate ? { predicate: passPredicate } : {}), state: state(alpha, doubleSided, color),
    vertex: presetKind === "standard-surface" ? standardVertexGraph(hasTextureIo) : unlitVertexGraph(hasTextureIo),
    ...(kind === "forward" ? {
      fragment: presetKind === "standard-surface" ? standardFragmentGraph(samplesTexture) : unlitFragmentGraph(samplesTexture),
    } : kind === "picking" ? { fragment: pickingGraph() } : {}),
  };
}

function build(kind: PresetKind, options: StandardSurfaceShaderOptions | UnlitShaderOptions): ShaderPresetBuildResult {
  const issues: ShaderPresetIssue[] = [];
  validateOptions(kind, options, issues);
  if (issues.some((entry) => entry.severity === "error")) return Object.freeze({ ok: false, issues: Object.freeze(issues) });

  const alphaVariant = options.switchableAlpha === true;
  const textureVariant = options.baseColorTexture === "switchable";
  const fixedAlpha: RuntimeAlpha = options.alphaMode === "blend" ? "blend" : "opaque";
  const alphas: readonly RuntimeAlpha[] = alphaVariant ? ["opaque", "blend"] : [fixedAlpha];
  const textures: readonly boolean[] = textureVariant ? [false, true] : [options.baseColorTexture === true];
  const usesTexture = textures.includes(true);
  const passes: ShaderPass[] = [];
  for (const alpha of alphas) for (const textured of textures) {
    passes.push(makePass(kind, forwardId(alpha, textured, alphaVariant, textureVariant), "forward", alpha, usesTexture, textured, options.doubleSided === true,
      predicate(alpha, textured, alphaVariant, textureVariant)));
  }
  if (options.passes?.depth) passes.push(makePass(kind, "depth", "depth", "opaque", usesTexture, false, options.doubleSided === true,
    alphaVariant ? predicate("opaque", false, true, false) : undefined));
  if (options.passes?.shadow) passes.push(makePass(kind, "shadow", "shadow", "opaque", usesTexture, false, options.doubleSided === true,
    alphaVariant ? predicate("opaque", false, true, false) : undefined));
  if (options.passes?.picking) passes.push(makePass(kind, "picking", "picking", "opaque", usesTexture, false, options.doubleSided === true));

  const asset: DeepShaderAsset = {
    schemaVersion: 1, id: options.id ?? `deep.${kind}`, ...(options.label ? { label: options.label } : {}),
    properties: [
      { name: "baseColor", type: "color", scope: "material", default: options.baseColor ?? [1, 1, 1, 1] },
      ...(kind === "standard-surface" ? [
        { name: "metallic", type: "f32" as const, scope: "material" as const, default: (options as StandardSurfaceShaderOptions).metallic ?? 0 },
        { name: "roughness", type: "f32" as const, scope: "material" as const, default: (options as StandardSurfaceShaderOptions).roughness ?? 1 },
      ] : []),
      ...(options.passes?.picking ? [{ name: "objectId", type: "color" as const, scope: "object" as const, default: [0, 0, 0, 1] }] : []),
    ],
    resources: usesTexture ? [
      { name: "baseColorTexture", scope: "material", binding: 1, kind: "texture-2d-f32", visibility: ["fragment"] },
      { name: "surfaceSampler", scope: "material", binding: 2, kind: "sampler", visibility: ["fragment"] },
    ] : [],
    attributes: [
      { name: "position", semantic: "POSITION", location: 0, format: "float32x3", type: "vec3f" },
      ...(kind === "standard-surface" ? [
        { name: "normal", semantic: "NORMAL", location: 1, format: "float32x3" as const, type: "vec3f" as const },
        ...[0, 1, 2].flatMap((index) => [
          { name: `modelRow${index}`, semantic: `MODEL_ROW_${index}`, location: 2 + index, format: "float32x4" as const, type: "vec4f" as const },
          { name: `normalColumn${index}`, semantic: `NORMAL_COLUMN_${index}`, location: 5 + index, format: "float32x4" as const, type: "vec4f" as const },
        ]),
      ] : []),
      ...(usesTexture ? [{ name: "uv0", semantic: "TEXCOORD_0", location: kind === "standard-surface" ? 10 : 1, format: "float32x2" as const, type: "vec2f" as const }] : []),
    ],
    varyings: kind === "standard-surface" ? [
      { name: "worldPosition", location: 0, type: "vec3f" },
      { name: "normalWorld", location: 1, type: "vec3f" },
      ...(usesTexture ? [{ name: "surfaceUv", location: 2, type: "vec2f" as const }] : []),
    ] : usesTexture ? [{ name: "surfaceUv", location: 0, type: "vec2f" }] : [],
    keywords: [
      ...(alphaVariant ? [{ name: "ALPHA_MODE", values: ["BLEND", "OPAQUE"], default: (options.alphaMode ?? "opaque").toUpperCase() }] : []),
      ...(textureVariant ? [{ name: "BASE_COLOR_TEXTURE", values: ["OFF", "ON"], default: "OFF" }] : []),
    ],
    techniques: [{ id: "webgpu", requirements: { webgpu: true }, passes }],
  };
  const validation = validateShaderAsset(asset);
  if (!validation.valid || !validation.value) {
    validation.diagnostics.forEach((entry) => issues.push(error(entry.path, "shader-ir", entry.message, "invalid-asset")));
    return Object.freeze({ ok: false, issues: Object.freeze(issues) });
  }
  return Object.freeze({ ok: true, asset: validation.value, issues: Object.freeze(issues) });
}

export function buildUnlitShader(options: UnlitShaderOptions = {}): ShaderPresetBuildResult {
  return build("unlit", options);
}

export function buildStandardSurfaceShader(options: StandardSurfaceShaderOptions = {}): ShaderPresetBuildResult {
  return build("standard-surface", options);
}
