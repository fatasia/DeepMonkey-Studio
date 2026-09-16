import { describe, expect, it } from "vitest";
import { createShaderAuthoringSession } from "./session.js";
import { TEST_CAPABILITIES, textDocument } from "./testFixture.js";
import { compileDeepSlSurface, DEEP_SL_SURFACE_EXAMPLE, inspectDeepSlSurface } from "./deepSl.js";

describe("DeepSL surface authoring", () => {
  it("parses the documented lightweight surface syntax", () => {
    const result = inspectDeepSlSurface(DEEP_SL_SURFACE_EXAMPLE);
    expect(result).toMatchObject({ success: true, model: {
      shaderId: "deep.material", surface: "standard", baseColor: [0.12, 0.42, 0.9, 1],
      metallic: 0.65, roughness: 0.24, alpha: "opaque", doubleSided: false,
      baseColorTexture: false,
      metallicRoughnessTexture: false, normalTexture: false,
      occlusionTexture: false, emissiveTexture: false,
    } });
  });

  it("parses five independent fixed-ABI texture toggles without implicit combinations", () => {
    const result = inspectDeepSlSurface(DEEP_SL_SURFACE_EXAMPLE
      .replace("baseColorTexture off", "baseColorTexture on")
      .replace("metallicRoughnessTexture off", "metallicRoughnessTexture on")
      .replace("normalTexture off", "normalTexture on")
      .replace("occlusionTexture off", "occlusionTexture on")
      .replace("emissiveTexture off", "emissiveTexture on"));
    expect(result).toMatchObject({ success: true, model: {
      baseColorTexture: true, metallicRoughnessTexture: true, normalTexture: true,
      occlusionTexture: true, emissiveTexture: true,
    } });
  });

  it("parses per-slot UV selection and transforms plus glTF material scalars", () => {
    const source = DEEP_SL_SURFACE_EXAMPLE
      .replace("baseColorTextureTransform texCoord 0 offset [0, 0] scale [1, 1] rotation 0",
        "baseColorTextureTransform texCoord 1 offset [0.25, -0.5] scale [2, 3] rotation 0.125")
      .replace("metallicRoughnessTextureTransform texCoord 0 offset [0, 0] scale [1, 1] rotation 0",
        "metallicRoughnessTextureTransform texCoord 1 offset [-2e-1, 4e-1] scale [0.5, 0.75] rotation -0.25")
      .replace("normalTextureTransform texCoord 0 offset [0, 0] scale [1, 1] rotation 0",
        "normalTextureTransform texCoord 0 offset [0, 0] scale [-1, 1] rotation 3.1415927")
      .replace("occlusionTextureTransform texCoord 0 offset [0, 0] scale [1, 1] rotation 0",
        "occlusionTextureTransform texCoord 1 offset [0.1, 0.2] scale [1, 1] rotation 0")
      .replace("emissiveTextureTransform texCoord 0 offset [0, 0] scale [1, 1] rotation 0",
        "emissiveTextureTransform texCoord 0 offset [0, 0] scale [4, 4] rotation 1e-1")
      .replace("normalScale 1", "normalScale -0.75")
      .replace("occlusionStrength 1", "occlusionStrength 0.35")
      .replace("emissiveFactor [0, 0, 0]", "emissiveFactor [0.1, 0.2, 0.3]");
    expect(inspectDeepSlSurface(source)).toMatchObject({ success: true, model: {
      baseColorTextureTransform: { texCoord: 1, offset: [0.25, -0.5], scale: [2, 3], rotation: 0.125 },
      metallicRoughnessTextureTransform: { texCoord: 1, offset: [-0.2, 0.4], scale: [0.5, 0.75], rotation: -0.25 },
      normalTextureTransform: { texCoord: 0, offset: [0, 0], scale: [-1, 1], rotation: 3.1415927 },
      occlusionTextureTransform: { texCoord: 1, offset: [0.1, 0.2], scale: [1, 1], rotation: 0 },
      emissiveTextureTransform: { texCoord: 0, offset: [0, 0], scale: [4, 4], rotation: 0.1 },
      normalScale: -0.75, occlusionStrength: 0.35, emissiveFactor: [0.1, 0.2, 0.3],
      emissiveStrength: 1,
    } });
  });

  it("keeps old DeepSL sources compatible through identity material defaults", () => {
    const result = inspectDeepSlSurface(`shader deep.legacy {
  surface standard;
  baseColorTexture on;
}`);
    expect(result).toMatchObject({ success: true, model: {
      baseColorTextureTransform: { texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 },
      metallicRoughnessTextureTransform: { texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 },
      normalTextureTransform: { texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 },
      occlusionTextureTransform: { texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 },
      emissiveTextureTransform: { texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 },
      normalScale: 1, occlusionStrength: 1, emissiveFactor: [0, 0, 0], emissiveStrength: 1,
    } });
  });

  it("compiles DeepSL through an editor session and maps WGSL lines back to text", async () => {
    const created = createShaderAuthoringSession(textDocument(DEEP_SL_SURFACE_EXAMPLE), {
      capabilities: TEST_CAPABILITIES,
    });
    const commit = await created.session!.compileCandidate();
    expect(commit).toMatchObject({ committed: true, stale: false, result: { success: true } });
    expect(commit.result.diagnostics).toEqual([]);
    expect(commit.view.lastKnownGood?.artifact.pass).toMatchObject({
      lightingContext: {
        frameAbi: "deep.pbr.mesh.v1/forward-frame",
        packageCompatibility: "requires-layout-adapter",
        directLightCapacity: 1,
      },
    });
    expect(commit.view.lastKnownGood?.artifact.pass.module.code).toContain("deepLowerStandardPbr");
    const sourceMap = commit.view.lastKnownGood!.artifact.sourceMap;
    expect(sourceMap.some((entry) => entry.range.start.line === 1 && entry.range.start.column === 1)).toBe(true);
    expect(sourceMap.some((entry) => entry.range.start.line === 3 && entry.range.start.column === 3)).toBe(true);
    expect(sourceMap.some((entry) => entry.range.start.line === 4 && entry.range.start.column === 3)).toBe(true);
    expect(sourceMap.some((entry) => entry.range.start.line === 5 && entry.range.start.column === 3)).toBe(true);
  });

  it("supports the unlit fast path without a PBR warning", () => {
    const document = textDocument(`shader deep.ui {\n  surface unlit;\n  baseColor [0.2, 0.4, 0.8, 1];\n}`);
    const result = compileDeepSlSurface({ document, revision: "a".repeat(64), candidateId: 1 }, { capabilities: TEST_CAPABILITIES });
    expect(result.success).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports strict duplicate, unknown, and unterminated declarations with ranges", () => {
    const result = inspectDeepSlSurface(`shader deep.bad {\n  surface standard;\n  surface unlit;\n  glow 4;`);
    expect(result.success).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining(["duplicate-field", "unknown-statement", "missing-brace"]));
    expect(result.diagnostics.every((entry) => entry.range?.start.line)).toBe(true);
  });

  it("fails closed when a supported statement contains out-of-range values", () => {
    const result = inspectDeepSlSurface(`shader deep.bad {\n  surface standard;\n  metallic 2;\n}`);
    expect(result.success).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ code: "unknown-statement", range: { start: { line: 3, column: 3 } } });
  });

  it.each([
    ["baseColorTextureTransform texCoord 2 offset [0, 0] scale [1, 1] rotation 0", "invalid-texture-transform"],
    ["normalTextureTransform texCoord 0 offset [1e999, 0] scale [1, 1] rotation 0", "invalid-number"],
    ["normalScale 1e999", "invalid-number"],
    ["occlusionStrength -0.01", "out-of-range"],
    ["occlusionStrength 1.01", "out-of-range"],
    ["emissiveFactor [0, -0.1, 0]", "out-of-range"],
    ["emissiveFactor [0, 0, 1e999]", "invalid-number"],
    ["emissiveStrength -0.01", "out-of-range"],
    ["emissiveStrength 256.01", "out-of-range"],
    ["emissiveStrength 1e999", "invalid-number"],
  ] as const)("fails closed with a specific diagnostic for %s", (declaration, code) => {
    const result = inspectDeepSlSurface(`shader deep.invalid {\n  surface standard;\n  ${declaration};\n}`);
    expect(result).toMatchObject({ success: false, diagnostics: [{ code, range: { start: { line: 3, column: 3 } } }] });
  });

  it("rejects duplicate runtime parameter declarations", () => {
    const result = inspectDeepSlSurface(`shader deep.duplicate {
  surface standard;
  normalScale 1;
  normalScale 0.5;
}`);
    expect(result).toMatchObject({ success: false, diagnostics: [{ code: "duplicate-field", range: { start: { line: 4 } } }] });
  });

  it("accepts bounded HDR emissive strength and exposes it to package authoring", () => {
    const result = inspectDeepSlSurface(DEEP_SL_SURFACE_EXAMPLE.replace("emissiveStrength 1", "emissiveStrength 8"));
    expect(result).toMatchObject({ success: true, model: { emissiveStrength: 8 } });
  });

  it("carries every Standard material semantic through the runtime package adapter", () => {
    const source = DEEP_SL_SURFACE_EXAMPLE
      .replace("baseColorTexture off", "baseColorTexture on")
      .replace("metallicRoughnessTexture off", "metallicRoughnessTexture on")
      .replace("normalTexture off", "normalTexture on")
      .replace("occlusionTexture off", "occlusionTexture on")
      .replace("emissiveTexture off", "emissiveTexture on")
      .replace("normalScale 1", "normalScale -0.5")
      .replace("occlusionStrength 1", "occlusionStrength 0.25")
      .replace("emissiveFactor [0, 0, 0]", "emissiveFactor [0.1, 0.2, 0.3]")
      .replace("emissiveStrength 1", "emissiveStrength 4");
    const result = compileDeepSlSurface({ document: textDocument(source),
      revision: "d".repeat(64), candidateId: 4 }, { capabilities: TEST_CAPABILITIES });
    expect(result).toMatchObject({ success: true, artifact: { runtimeCompatibility: {
      materialDefaults: { emissiveAlpha: [0.1, 0.2, 0.3, 1] },
      materialTextureDefaults: {
        enabledSlots: ["baseColor", "metallicRoughness", "occlusion", "normal", "emissive"],
        normal: { normalScale: -0.5 }, occlusion: { strength: 0.25 },
        emissive: { emissiveStrength: 4 },
      },
    } } });
    const wgsl = result.artifact?.runtimePackage?.modules[0]?.source ?? "";
    expect(wgsl).toContain("deepMetallicRoughnessSample.b");
    expect(wgsl).toContain("deepPackageMappedNormal(");
    expect(wgsl).toContain("deepSampledOcclusion");
    expect(wgsl).toContain("deepEmissiveSample");
  });

  it("rejects non-text input at the public inspection boundary", () => {
    expect(inspectDeepSlSurface({ source: DEEP_SL_SURFACE_EXAMPLE })).toMatchObject({
      success: false, diagnostics: [{ code: "invalid-source", range: { start: { line: 1, column: 1 } } }],
    });
  });

  it("bounds source length, line count, and accumulated diagnostics before parsing", () => {
    expect(inspectDeepSlSurface("x".repeat(1_048_577)).diagnostics).toMatchObject([{ code: "budget-exceeded" }]);
    expect(inspectDeepSlSurface("\n".repeat(32_768)).diagnostics).toMatchObject([{ code: "budget-exceeded" }]);
    const manyErrors = inspectDeepSlSurface(`shader deep.bad {\n${"  unknown;\n".repeat(512)}}`);
    expect(manyErrors.diagnostics).toHaveLength(128);
  });

  it("maps texture sampling and color multiplication to their exact declarations", () => {
    const source = `shader deep.textured {\n  surface unlit;\n  baseColor [1, 1, 1, 1];\n  baseColorTexture on;\n}`;
    const document = textDocument(source);
    const result = compileDeepSlSurface({ document, revision: "c".repeat(64), candidateId: 3 }, { capabilities: TEST_CAPABILITIES });
    expect(result.success).toBe(true);
    const codeLines = result.artifact!.pass.module.code.split("\n");
    const sampleLine = codeLines.findIndex((line) => line.includes("textureSample")) + 1;
    const multiplyLine = codeLines.findIndex((line) => line.includes("n_tintedBaseColor")) + 1;
    expect(result.artifact!.sourceMap.find((entry) => entry.generatedLine === sampleLine)?.range.start.line).toBe(4);
    expect(result.artifact!.sourceMap.find((entry) => entry.generatedLine === multiplyLine)?.range.start.line).toBe(3);
  });

  it("compiles the bounded DeepSL MASK declaration through the typed alpha-clip output", () => {
    const source = `shader deep.mask {\n  surface standard;\n  alpha mask;\n}`;
    const document = textDocument(source);
    const result = compileDeepSlSurface({ document, revision: "b".repeat(64), candidateId: 2 }, { capabilities: TEST_CAPABILITIES });
    expect(result).toMatchObject({ success: true, diagnostics: [] });
    expect(result.artifact?.pass.module.code).toContain("if (n_alpha < n_alphaCutoff) { discard; }");
    expect(result.artifact?.pass.propertyLayout).toContainEqual(expect.objectContaining({ name: "alphaCutoff", group: 1, binding: 0 }));
  });
});
