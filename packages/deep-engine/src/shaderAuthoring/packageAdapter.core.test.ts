import { describe, expect, it } from "vitest";
import { resolveShaderPackagePipeline } from "../shaderPackage/pipeline.js";
import { validateDeepShaderPackage } from "../shaderPackage/validation.js";
import { adaptDeepSlStandardToShaderPackage } from "./packageAdapter.js";
import { OPAQUE, packageRequest as request } from "./packageAdapter.testFixture.js";

describe("DeepSL Shader Package v2 adapter", () => {
  it("builds an ABI-native opaque forward and solid-shadow package", () => {
    const result = adaptDeepSlStandardToShaderPackage(request(OPAQUE));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.report).toMatchObject({
      schemaVersion: 1, adapterProfile: "deep.pbr.mesh.v1/deepsl-standard-plain.v2",
      status: "direct-package-ready", shaderAbi: "deep.pbr.mesh.v1",
      materialSource: "instance-stream", issues: [],
      materialDefaults: {
        baseColorMetallic: [0.12, 0.42, 0.9, 0.65],
        roughnessAlphaCutoffHandednessFlags: [0.24, 0.5, 1, 0],
        emissiveAlpha: [0, 0, 0, 1],
      },
    });
    expect(result.package.passes.map((pass) => ({ id: pass.id, pipeline: pass.pipeline }))).toEqual([
      { id: "webgpu/forwardCcw", pipeline: { passVariantId: "forward-plain", attachmentProfileId: "forward-opaque", alphaMode: "OPAQUE", rasterMode: "ccw" } },
      { id: "webgpu/forwardCw", pipeline: { passVariantId: "forward-plain", attachmentProfileId: "forward-opaque", alphaMode: "OPAQUE", rasterMode: "cw" } },
      { id: "webgpu/shadowCcw", pipeline: { passVariantId: "shadow-solid", attachmentProfileId: "shadow", alphaMode: "OPAQUE", rasterMode: "ccw" } },
      { id: "webgpu/shadowCw", pipeline: { passVariantId: "shadow-solid", attachmentProfileId: "shadow", alphaMode: "OPAQUE", rasterMode: "cw" } },
    ]);
    expect(result.package.passes.find((pass) => pass.kind === "forward")?.entryPoints)
      .toEqual({ vertex: "vertexMain", fragment: "fragmentMain" });
    expect(result.package.passes.find((pass) => pass.kind === "shadow")?.entryPoints)
      .toEqual({ vertex: "shadowMain", fragment: null });
    expect(validateDeepShaderPackage(result.package)).toMatchObject({ valid: true, diagnostics: [] });

    const source = result.package.modules[0]!.source;
    expect(source).toContain("@location(8) a_colorMetal: vec4f");
    expect(source).toContain("@location(9) a_material: vec4f");
    expect(source).toContain("@location(12) a_emissiveAlpha: vec4f");
    expect(source).toContain("@vertex fn shadowMain(input: DeepPackageSolidShadowInput)");
    expect(source).not.toContain("@group(1)");
    expect(source).not.toContain("deepMaterial");
    expect(source).toContain("let n_alpha: f32 = 1.0;");
    const instanceLayout = result.package.shaderAbi.contract.dataLayouts.find((layout) => layout.id === "instance");
    expect(instanceLayout?.members.slice(6).map((member) => [member.name, member.byteOffset, member.byteSize])).toEqual([
      ["baseColorMetallic", 96, 16],
      ["roughnessAlphaCutoffHandednessFlags", 112, 16],
      ["emissiveAlpha", 128, 16],
    ]);
    expect(Object.keys(result.report.materialDefaults ?? {})).toEqual(instanceLayout?.members.slice(6).map((member) => member.name));

    const executions = result.package.passes.map((pass) => ({
      kind: pass.kind,
      value: resolveShaderPackagePipeline(result.package.shaderAbi.contract, pass.pipeline),
    }));
    const expectedStreams = [
      { id: "geometry", slot: 0, stride: 40, attributes: [[0, "float32x3", 0], [1, "float32x3", 12], [10, "float32x2", 24], [13, "float32x2", 32]] },
      { id: "instance", slot: 1, stride: 144, attributes: [[2, "float32x4", 0], [3, "float32x4", 16], [4, "float32x4", 32], [5, "float32x4", 48], [6, "float32x4", 64], [7, "float32x4", 80], [8, "float32x4", 96], [9, "float32x4", 112], [12, "float32x4", 128]] },
    ];
    expect(executions.map((entry) => ({ kind: entry.kind,
      layouts: entry.value?.bindGroupLayouts.map((layout) => layout.id) }))).toEqual([
      { kind: "forward", layouts: ["forward-frame"] },
      { kind: "forward", layouts: ["forward-frame"] },
      { kind: "shadow", layouts: ["shadow-frame"] },
      { kind: "shadow", layouts: ["shadow-frame"] },
    ]);
    for (const execution of executions) {
      expect(execution.value?.vertexStreams.map((stream) => ({
        id: stream.id, slot: stream.slot, stride: stream.arrayStride,
        attributes: stream.attributes.map((attribute) => [attribute.shaderLocation, attribute.format, attribute.byteOffset]),
      }))).toEqual(expectedStreams);
    }
  });

  it("builds blend forward variants without a shadow caster", () => {
    const result = adaptDeepSlStandardToShaderPackage(request(OPAQUE.replace("alpha opaque", "alpha blend")));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.package.passes).toHaveLength(2);
    expect(result.package.passes.every((pass) => pass.kind === "forward"
      && pass.pipeline.alphaMode === "BLEND"
      && pass.pipeline.attachmentProfileId === "forward-blend")).toBe(true);
    expect(result.report.materialDefaults?.roughnessAlphaCutoffHandednessFlags[3]).toBe(4);
    expect(result.report.materialDefaults?.emissiveAlpha[3]).toBe(0.8);
    expect(result.report.bindGroupLayouts).toEqual(["forward-frame"]);
    expect(result.package.modules[0]!.source).toContain("let n_alpha: f32 = n_emissiveAlpha.a;");
    expect(result.package.modules[0]!.source).not.toContain("fn shadowMain(");
    expect(result.package.modules[0]!.source).not.toContain("fn shadowMaskMain(");
    expect(result.report.passSelections.some((pass) => pass.kind === "shadow")).toBe(false);
  });

  it("builds a plain MASK forward and alpha-cutout shadow package", () => {
    const result = adaptDeepSlStandardToShaderPackage(request(OPAQUE.replace("alpha opaque", "alpha mask")));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.package.passes.map((pass) => ({ id: pass.id, entries: pass.entryPoints, pipeline: pass.pipeline }))).toEqual([
      { id: "webgpu/forwardCcw", entries: { vertex: "vertexMain", fragment: "fragmentMain" },
        pipeline: { passVariantId: "forward-plain", attachmentProfileId: "forward-opaque", alphaMode: "MASK", rasterMode: "ccw" } },
      { id: "webgpu/forwardCw", entries: { vertex: "vertexMain", fragment: "fragmentMain" },
        pipeline: { passVariantId: "forward-plain", attachmentProfileId: "forward-opaque", alphaMode: "MASK", rasterMode: "cw" } },
      { id: "webgpu/shadowCcw", entries: { vertex: "shadowMaskMain", fragment: "shadowMaskPlain" },
        pipeline: { passVariantId: "shadow-mask-plain", attachmentProfileId: "shadow", alphaMode: "MASK", rasterMode: "ccw" } },
      { id: "webgpu/shadowCw", entries: { vertex: "shadowMaskMain", fragment: "shadowMaskPlain" },
        pipeline: { passVariantId: "shadow-mask-plain", attachmentProfileId: "shadow", alphaMode: "MASK", rasterMode: "cw" } },
    ]);
    expect(result.report.materialDefaults).toMatchObject({
      roughnessAlphaCutoffHandednessFlags: [0.24, 0.5, 1, 2],
      emissiveAlpha: [0, 0, 0, 0.8],
    });
    const source = result.package.modules[0]!.source;
    expect(source).toContain("if (n_alpha < n_material.y) { discard; }");
    expect(source).toContain("deepLowerStandardPbr(input.v_worldPosition, n_baseColor, n_surfaceNormal");
    expect(source).toMatch(/n_emission, 1\.0\);/u);
    expect(source).toContain("@vertex fn shadowMaskMain(input: DeepPackagePlainShadowInput)");
    expect(source).toContain("@fragment fn shadowMaskPlain(input: DeepShadowMaskVertexOut)");
    expect(source).not.toContain("@vertex fn shadowMain(");
    expect(validateDeepShaderPackage(result.package)).toMatchObject({ valid: true, diagnostics: [] });
  });

  it("selects one double-sided pipeline and flips only back-face lighting normals", () => {
    const source = OPAQUE.replace("alpha opaque", "alpha mask").replace("doubleSided false", "doubleSided true");
    const result = adaptDeepSlStandardToShaderPackage(request(source));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.package.passes.map((pass) => [pass.id, pass.pipeline.rasterMode]))
      .toEqual([["webgpu/forwardDouble", "double"], ["webgpu/shadowDouble", "double"]]);
    expect(result.report.materialDefaults).toMatchObject({
      roughnessAlphaCutoffHandednessFlags: [0.24, 0.5, 1, 3],
      emissiveAlpha: [0, 0, 0, 0.8],
    });
    const wgsl = result.package.modules[0]!.source;
    expect(wgsl).toContain("@builtin(front_facing) deepFrontFacing: bool");
    expect(wgsl).toContain("let deepPackageGltfFront = select(!deepFrontFacing, deepFrontFacing, n_material.z > 0.0);");
    expect(wgsl).toContain("let deepPackageGeometricNormal = select(-n_surfaceNormal, n_surfaceNormal, deepPackageGltfFront);");
    expect(wgsl).toContain("n_baseColor, deepPackageGeometricNormal, n_metallic");
    expect(wgsl).toContain("if (n_alpha < n_material.y) { discard; }");
    expect(validateDeepShaderPackage(result.package)).toMatchObject({ valid: true, diagnostics: [] });
  });

  it.each([
    ["surface unlit", "unsupported-surface"],
  ] as const)("rejects %s with a stable compatibility code", (replacement, code) => {
    const source = replacement.startsWith("surface")
      ? OPAQUE.replace("surface standard", replacement)
      : replacement.startsWith("baseColorTexture")
        ? OPAQUE.replace("baseColorTexture off", replacement)
        : OPAQUE.replace("baseColorTexture off", replacement);
    const result = adaptDeepSlStandardToShaderPackage(request(source));
    expect(result).toMatchObject({ success: false, report: { status: "rejected", issues: [{ code }] } });
    expect("package" in result).toBe(false);
  });
});
