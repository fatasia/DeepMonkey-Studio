import { validateShaderAsset } from "../shader/validation.js";
import type { DeepShaderAsset, ShaderFeaturePredicate, ShaderPass } from "../shader/types.js";
import { makeSurfacePass, type SurfacePresetKind } from "./surfacePresetGraphs.js";
import type {
  ShaderPresetBuildResult, ShaderPresetIssue, StandardSurfaceShaderOptions,
  SurfaceAlphaMode, UnlitShaderOptions,
} from "./types.js";

const IDENTITY_4X4 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const ALPHA_MODES = new Set<SurfaceAlphaMode>(["opaque", "blend", "mask"]);

function error(path: string, feature: string, message: string, code: ShaderPresetIssue["code"] = "unsupported-feature"): ShaderPresetIssue {
  return Object.freeze({ severity: "error", code, path, feature, message });
}

function validUnit(value: number | undefined, path: string, issues: ShaderPresetIssue[]): void {
  if (value !== undefined && (!Number.isFinite(value) || Object.is(value, -0) || value < 0 || value > 1)) {
    issues.push(error(path, path.slice(2), "Expected a finite value from 0 to 1.", "invalid-option"));
  }
}

function validateOptions(kind: SurfacePresetKind, options: StandardSurfaceShaderOptions | UnlitShaderOptions, issues: ShaderPresetIssue[]): void {
  if (options.baseColor !== undefined && (options.baseColor.length !== 4
    || options.baseColor.some((value) => !Number.isFinite(value) || Object.is(value, -0) || value < 0 || value > 1))) {
    issues.push(error("$.baseColor", "base-color", "Expected four finite linear color components from 0 to 1.", "invalid-option"));
  }
  if (options.alphaMode !== undefined && !ALPHA_MODES.has(options.alphaMode)) {
    issues.push(error("$.alphaMode", "alpha-mode", "Expected opaque, blend, or mask.", "invalid-option"));
  }
  validUnit(options.alphaCutoff, "$.alphaCutoff", issues);
  if (options.alphaMode === "mask" && options.switchableAlpha) {
    issues.push(error("$.switchableAlpha", "switchable-alpha-mask", "MASK is a fixed finite variant; switchableAlpha only emits OPAQUE and BLEND."));
  }
  if (options.normalTexture) issues.push(error("$.normalTexture", "normal-texture", "Normal mapping needs tangent-space and lighting nodes that are outside the current compiler subset."));
  if (options.occlusionTexture) issues.push(error("$.occlusionTexture", "occlusion-texture", "Occlusion sampling is not represented by the current surface compiler subset."));
  if (kind === "standard-surface") {
    const standard = options as StandardSurfaceShaderOptions;
    validUnit(standard.metallic, "$.metallic", issues);
    validUnit(standard.roughness, "$.roughness", issues);
    if (standard.metallicRoughnessTexture) {
      issues.push(error("$.metallicRoughnessTexture", "metallic-roughness-texture", "Metallic/roughness texture channels need PBR lighting nodes that are not available in Shader IR schema v1."));
    }
  }
  const fixedBlend = options.alphaMode === "blend" && !options.switchableAlpha;
  if (fixedBlend && (options.passes?.depth || options.passes?.shadow)) {
    issues.push(error("$.passes", "transparent-depth-shadow", "Blended surfaces do not write depth or cast shadows; omit those passes or use switchable alpha."));
  }
}

function predicate(alpha: SurfaceAlphaMode, textured: boolean, alphaVariant: boolean, textureVariant: boolean): ShaderFeaturePredicate | undefined {
  const terms: ShaderFeaturePredicate[] = [];
  if (alphaVariant) terms.push({ op: "keyword", name: "ALPHA_MODE", equals: alpha.toUpperCase() });
  if (textureVariant) terms.push({ op: "keyword", name: "BASE_COLOR_TEXTURE", equals: textured ? "ON" : "OFF" });
  if (terms.length === 0) return undefined;
  return terms.length === 1 ? terms[0] : { op: "all", terms };
}

function variantId(prefix: string, alpha: SurfaceAlphaMode, textured: boolean, alphaVariant: boolean, textureVariant: boolean): string {
  if (!alphaVariant && !textureVariant) return prefix;
  return `${prefix}${alphaVariant ? alpha[0]!.toUpperCase() + alpha.slice(1) : ""}${textureVariant ? (textured ? "Textured" : "Color") : ""}`;
}

function addAuxiliaryPasses(
  passes: ShaderPass[], kind: SurfacePresetKind, options: StandardSurfaceShaderOptions | UnlitShaderOptions,
  fixedAlpha: SurfaceAlphaMode, textures: readonly boolean[], usesTexture: boolean, textureVariant: boolean, alphaVariant: boolean,
): void {
  for (const passKind of ["depth", "shadow", "picking"] as const) {
    if (!options.passes?.[passKind]) continue;
    if (fixedAlpha === "mask") {
      for (const textured of textures) passes.push(makeSurfacePass(
        kind, variantId(passKind, "mask", textured, false, textureVariant), passKind, "mask",
        usesTexture, textured, options.doubleSided === true, predicate("mask", textured, false, textureVariant),
      ));
      continue;
    }
    passes.push(makeSurfacePass(kind, passKind, passKind, "opaque", usesTexture, false, options.doubleSided === true,
      passKind !== "picking" && alphaVariant ? predicate("opaque", false, true, false) : undefined));
  }
}

function build(kind: SurfacePresetKind, options: StandardSurfaceShaderOptions | UnlitShaderOptions): ShaderPresetBuildResult {
  const issues: ShaderPresetIssue[] = [];
  validateOptions(kind, options, issues);
  if (issues.some((entry) => entry.severity === "error")) return Object.freeze({ ok: false, issues: Object.freeze(issues) });

  const alphaVariant = options.switchableAlpha === true;
  const textureVariant = options.baseColorTexture === "switchable";
  const fixedAlpha: SurfaceAlphaMode = options.alphaMode ?? "opaque";
  const alphas: readonly SurfaceAlphaMode[] = alphaVariant ? ["opaque", "blend"] : [fixedAlpha];
  const textures: readonly boolean[] = textureVariant ? [false, true] : [options.baseColorTexture === true];
  const usesTexture = textures.includes(true);
  const passes: ShaderPass[] = [];
  for (const alpha of alphas) for (const textured of textures) passes.push(makeSurfacePass(
    kind, variantId("forward", alpha, textured, alphaVariant, textureVariant), "forward", alpha,
    usesTexture, textured, options.doubleSided === true, predicate(alpha, textured, alphaVariant, textureVariant),
  ));
  addAuxiliaryPasses(passes, kind, options, fixedAlpha, textures, usesTexture, textureVariant, alphaVariant);

  const hasAuxiliary = Boolean(options.passes?.depth || options.passes?.shadow || options.passes?.picking);
  const asset: DeepShaderAsset = {
    schemaVersion: 1, id: options.id ?? `deep.${kind}`, ...(options.label ? { label: options.label } : {}),
    properties: [
      { name: "baseColor", type: "color", scope: "material", default: options.baseColor ?? [1, 1, 1, 1] },
      ...(fixedAlpha === "mask" ? [{ name: "alphaCutoff", type: "f32" as const, scope: "material" as const, default: options.alphaCutoff ?? 0.5 }] : []),
      ...(kind === "standard-surface" ? [
        { name: "metallic", type: "f32" as const, scope: "material" as const, default: (options as StandardSurfaceShaderOptions).metallic ?? 0 },
        { name: "roughness", type: "f32" as const, scope: "material" as const, default: (options as StandardSurfaceShaderOptions).roughness ?? 1 },
        ...(hasAuxiliary ? [{ name: "passViewProjection", type: "mat4x4f" as const, scope: "pass" as const, default: IDENTITY_4X4 }] : []),
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
      { name: "worldPosition", location: 0, type: "vec3f" }, { name: "normalWorld", location: 1, type: "vec3f" },
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

export function buildUnlitShader(options: UnlitShaderOptions = {}): ShaderPresetBuildResult { return build("unlit", options); }
export function buildStandardSurfaceShader(options: StandardSurfaceShaderOptions = {}): ShaderPresetBuildResult { return build("standard-surface", options); }
