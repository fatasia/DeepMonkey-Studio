import { describe, expect, it } from "vitest";
import { resolveShaderPackagePipeline } from "../shaderPackage/pipeline.js";
import { validateDeepShaderPackage } from "../shaderPackage/validation.js";
import { adaptDeepSlStandardToShaderPackage } from "./packageAdapter.js";
import { ALL_TEXTURES, OPAQUE, packageRequest as request } from "./packageAdapter.testFixture.js";

describe("DeepSL Shader Package v2 adapter", () => {
  it("uses the bounded material ABI for an opaque base-color texture without pipeline permutations", () => {
    const textured = OPAQUE.replace("baseColorTexture off", "baseColorTexture on");
    const result = adaptDeepSlStandardToShaderPackage(request(textured));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.report).toMatchObject({
      adapterProfile: "deep.pbr.mesh.v1/deepsl-standard-textures.v2",
      materialSource: "instance-and-material-bind-group",
      bindGroupLayouts: ["forward-frame", "material", "shadow-frame"],
      materialTextureDefaults: {
        byteSize: 160,
        enabledSlots: ["baseColor"],
        baseColor: {
          semantic: "baseColor", colorSpace: "srgb", texCoord: 0,
          uvTransform: [1, 0, 0, 0, 1, 0],
        },
        dummySlots: [
          { binding: "metallicRoughness", colorSpace: "linear" },
          { binding: "occlusion", colorSpace: "linear" },
          { binding: "normal", colorSpace: "linear" },
          { binding: "emissive", colorSpace: "srgb" },
        ],
      },
    });
    expect(result.report.materialTextureDefaults?.parameters).toEqual([
      1, 0, 0, 1, 0, 1, 0, 0,
      1, 0, 0, 0, 0, 1, 0, 0,
      1, 0, 0, 0, 0, 1, 0, 1,
      1, 0, 0, 0, 0, 1, 0, 1,
      1, 0, 0, 0, 0, 1, 0, 1,
    ]);
    expect(result.package.passes.map((pass) => [pass.kind, pass.pipeline.passVariantId, pass.entryPoints.fragment]))
      .toEqual([
        ["forward", "forward-material", "fragmentMaterial"],
        ["forward", "forward-material", "fragmentMaterial"],
        ["shadow", "shadow-solid", null],
        ["shadow", "shadow-solid", null],
      ]);
    const materialExecutions = result.package.passes.filter((pass) => pass.kind === "forward")
      .map((pass) => resolveShaderPackagePipeline(result.package.shaderAbi.contract, pass.pipeline));
    expect(materialExecutions.every((execution) => execution?.bindGroupLayouts.map((layout) => layout.id)
      .join("|") === "forward-frame|material")).toBe(true);
    const wgsl = result.package.modules[0]!.source;
    expect([...wgsl.matchAll(/@group\(1\)\s+@binding\((\d+)\)/gu)].map((match) => Number(match[1])))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(wgsl).toContain("deepMaterialTextures.baseRow0.w > 0.5");
    expect(wgsl).toContain("select(uv0, uv1, row0.w > 1.5)");
    expect(wgsl).toContain("n_colorMetal.rgb * deepBaseColorSample.rgb");
    expect(validateDeepShaderPackage(result.package)).toMatchObject({ valid: true, diagnostics: [] });

    const second = adaptDeepSlStandardToShaderPackage(request(textured));
    expect(second.success && second.package.packageCacheKey).toBe(result.package.packageCacheKey);
  });

  it("samples texture alpha in both MASK color and shadow passes", () => {
    const source = OPAQUE.replace("alpha opaque", "alpha mask")
      .replace("baseColorTexture off", "baseColorTexture on");
    const result = adaptDeepSlStandardToShaderPackage(request(source));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.package.passes.map((pass) => [pass.kind, pass.pipeline.passVariantId, pass.entryPoints.fragment]))
      .toEqual([
        ["forward", "forward-material", "fragmentMaterial"],
        ["forward", "forward-material", "fragmentMaterial"],
        ["shadow", "shadow-mask-material", "shadowMaskTextured"],
        ["shadow", "shadow-mask-material", "shadowMaskTextured"],
      ]);
    const wgsl = result.package.modules[0]!.source;
    expect(wgsl).toContain("let n_alpha: f32 = n_emissiveAlpha.a * deepBaseColorSample.a;");
    expect(wgsl).toContain("input.alphaCutoff.x * sampledAlpha < input.alphaCutoff.y");
    expect(result.package.passes.filter((pass) => pass.kind === "shadow").every((pass) =>
      resolveShaderPackagePipeline(result.package.shaderAbi.contract, pass.pipeline)?.bindGroupLayouts
        .map((layout) => layout.id).join("|") === "shadow-frame|material")).toBe(true);
    expect(validateDeepShaderPackage(result.package)).toMatchObject({ valid: true, diagnostics: [] });
  });

  it("lowers all five glTF texture slots through one material layout and a bounded normal pipeline", () => {
    const result = adaptDeepSlStandardToShaderPackage(request(ALL_TEXTURES));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.report).toMatchObject({
      adapterProfile: "deep.pbr.mesh.v1/deepsl-standard-textures.v2",
      vertexStreams: ["geometry", "instance", "tangent"],
      materialTextureDefaults: {
        byteSize: 160,
        enabledSlots: ["baseColor", "metallicRoughness", "occlusion", "normal", "emissive"],
        metallicRoughness: { metallicChannel: "b", roughnessChannel: "g", colorSpace: "linear" },
        normal: { normalScale: 1, colorSpace: "linear", supportedTexCoords: [0, 1] },
        occlusion: { channel: "r", strength: 1, colorSpace: "linear", supportedTexCoords: [0, 1] },
        emissive: { colorSpace: "srgb", emissiveStrength: 1 },
        dummySlots: [],
      },
    });
    expect(result.package.passes.map((pass) => [pass.kind, pass.pipeline.passVariantId, pass.entryPoints.vertex]))
      .toEqual([
        ["forward", "forward-normal", "vertexNormalMapped"],
        ["forward", "forward-normal", "vertexNormalMapped"],
        ["shadow", "shadow-solid", "shadowMain"],
        ["shadow", "shadow-solid", "shadowMain"],
      ]);
    const wgsl = result.package.modules[0]!.source;
    expect(wgsl).toContain("n_colorMetal.a * deepMetallicRoughnessSample.b");
    expect(wgsl).toContain("n_material.x * deepMetallicRoughnessSample.g");
    expect(wgsl).toContain("deepMaterialTextures.occlusionRow1.w * (deepSampledOcclusion - 1.0)");
    expect(wgsl).toContain("n_emissiveAlpha.rgb * deepEmissiveSample * deepMaterialTextures.emissiveRow1.w");
    expect(wgsl).toContain("let sourceHandedness = tangentInput.w * modelHandedness;");
    expect(wgsl).toContain("let determinantSign = select(-1.0, 1.0, determinant >= 0.0);");
    expect(wgsl).toContain("sampled.xy * deepMaterialTextures.normalRow1.w");
    expect(wgsl).toContain("@vertex fn shadowMain(input: DeepPackageSolidShadowInput)");
    expect(validateDeepShaderPackage(result.package)).toMatchObject({ valid: true, diagnostics: [] });
  });

  it("lowers authored material parameters into the fixed uniform without changing package identity", () => {
    const parameterized = ALL_TEXTURES.replace("\n}", `
  baseColorTextureTransform texCoord 1 offset [0.25, -0.5] scale [2, 3] rotation 0;
  metallicRoughnessTextureTransform texCoord 0 offset [0.1, 0.2] scale [0.5, 0.75] rotation 0;
  occlusionTextureTransform texCoord 1 offset [0, 0] scale [1, 1] rotation 0;
  normalTextureTransform texCoord 0 offset [0, 0] scale [1, 1] rotation 0;
  emissiveTextureTransform texCoord 1 offset [-0.25, 0.5] scale [2, 0.25] rotation 0;
  normalScale -0.75;
  occlusionStrength 0.35;
  emissiveFactor [0.1, 0.2, 0.3];
  emissiveStrength 8;
}`);
    const result = adaptDeepSlStandardToShaderPackage(request(parameterized));
    const defaults = result.success ? result.report.materialTextureDefaults : undefined;
    expect(result.success).toBe(true);
    expect(result.success && result.report.materialDefaults?.emissiveAlpha).toEqual([0.1, 0.2, 0.3, 1]);
    expect(defaults).toMatchObject({
      byteSize: 160,
      baseColor: { texCoord: 1, offset: [0.25, -0.5], scale: [2, 3], rotation: 0, uvTransform: [2, 0, 0.25, 0, 3, -0.5] },
      metallicRoughness: { texCoord: 0, offset: [0.1, 0.2], scale: [0.5, 0.75], rotation: 0 },
      occlusion: { texCoord: 1, strength: 0.35 },
      normal: { texCoord: 0, normalScale: -0.75 },
      emissive: { texCoord: 1, offset: [-0.25, 0.5], scale: [2, 0.25], rotation: 0, emissiveStrength: 8 },
    });
    expect(defaults?.parameters.slice(0, 8)).toEqual([2, 0, 0.25, 2, 0, 3, -0.5, 0]);
    expect(defaults?.parameters[23]).toBeCloseTo(0.35);
    expect(defaults?.parameters[31]).toBeCloseTo(-0.75);
    expect(defaults?.parameters[39]).toBe(8);

    const changedOnlyAtRuntime = parameterized
      .replace("offset [0.25, -0.5] scale [2, 3]", "offset [0, 0] scale [1, 1]")
      .replace("normalScale -0.75", "normalScale 0.25")
      .replace("occlusionStrength 0.35", "occlusionStrength 0.8")
      .replace("emissiveFactor [0.1, 0.2, 0.3]", "emissiveFactor [0.3, 0.2, 0.1]")
      .replace("emissiveStrength 8", "emissiveStrength 4");
    const changed = adaptDeepSlStandardToShaderPackage(request(changedOnlyAtRuntime));
    expect(changed.success).toBe(true);
    if (!result.success || !changed.success) return;
    expect(changed.package.packageCacheKey).toBe(result.package.packageCacheKey);
    expect(changed.package.modules[0]!.source).toBe(result.package.modules[0]!.source);
    expect(changed.report.materialTextureDefaults?.parameters).not.toEqual(defaults?.parameters);
    expect(changed.report.materialDefaults?.emissiveAlpha).not.toEqual(result.report.materialDefaults?.emissiveAlpha);
  });

  it("folds HDR strength into the plain v1 instance payload without a new pipeline variant", () => {
    const source = OPAQUE.replace("baseColor [0.12, 0.42, 0.9, 0.8]", `baseColor [0.12, 0.42, 0.9, 0.8];
  emissiveFactor [0.1, 0.2, 0.3];
  emissiveStrength 8`);
    const result = adaptDeepSlStandardToShaderPackage(request(source));
    const baseline = adaptDeepSlStandardToShaderPackage(request(source.replace("emissiveStrength 8", "emissiveStrength 1")));
    expect(result.success && result.report.materialDefaults?.emissiveAlpha).toEqual([0.8, 1.6, 2.4, 1]);
    expect(result.success && baseline.success && result.package.packageCacheKey).toBe(baseline.success && baseline.package.packageCacheKey);
    expect(result.success && result.package.passes.every((pass) => pass.pipeline.passVariantId !== "forward-material")).toBe(true);
  });

  it("collapses non-normal texture combinations to one package and one pipeline variant", () => {
    const sources = [
      "baseColorTexture on",
      "metallicRoughnessTexture on",
      "occlusionTexture on",
      "emissiveTexture on",
      "baseColorTexture on;\n  metallicRoughnessTexture on;\n  occlusionTexture on;\n  emissiveTexture on",
    ].map((declarations) => OPAQUE.replace("baseColorTexture off", declarations));
    const adapted = sources.map((source) => adaptDeepSlStandardToShaderPackage(request(source)));
    expect(adapted.every((result) => result.success)).toBe(true);
    const packages = adapted.flatMap((result) => result.success ? [result.package] : []);
    expect(new Set(packages.map((value) => value.packageCacheKey)).size).toBe(1);
    expect(packages.every((value) => value.passes.filter((pass) => pass.kind === "forward")
      .every((pass) => pass.pipeline.passVariantId === "forward-material"))).toBe(true);
    const normal = adaptDeepSlStandardToShaderPackage(request(OPAQUE.replace(
      "baseColorTexture off", "normalTexture on",
    )));
    expect(normal.success).toBe(true);
    expect(normal.success && normal.package.packageCacheKey).not.toBe(packages[0]?.packageCacheKey);
    expect(normal.success && normal.package.passes.filter((pass) => pass.kind === "forward")
      .every((pass) => pass.pipeline.passVariantId === "forward-normal")).toBe(true);
  });

  it("keeps MASK alpha on base color while normal mapping uses TBN on double-sided surfaces", () => {
    const result = adaptDeepSlStandardToShaderPackage(request(ALL_TEXTURES
      .replace("alpha opaque", "alpha mask").replace("doubleSided false", "doubleSided true")));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.package.passes.map((pass) => [pass.pipeline.passVariantId, pass.pipeline.rasterMode]))
      .toEqual([["forward-normal", "double"], ["shadow-mask-material", "double"]]);
    const wgsl = result.package.modules[0]!.source;
    expect(wgsl).toContain("let deepPackageGeometricNormal = select(-n_surfaceNormal, n_surfaceNormal, deepPackageGltfFront);");
    expect(wgsl).toContain("deepPackageMappedNormal(");
    expect(wgsl).toContain("n_emissiveAlpha.a * deepBaseColorSample.a");
    expect(wgsl).toContain("input.alphaCutoff.x * sampledAlpha < input.alphaCutoff.y");
    expect(validateDeepShaderPackage(result.package)).toMatchObject({ valid: true, diagnostics: [] });
  });
});
