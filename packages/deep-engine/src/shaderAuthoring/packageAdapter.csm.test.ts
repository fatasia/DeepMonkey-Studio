import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEEP_PBR_MESH_V1_SHA256, DEEP_PBR_MESH_V2_SHA256 } from "../shaderAbi/index.js";
import { computeDeepShaderPackageCacheKey, validateDeepShaderPackage } from "../shaderPackage/validation.js";
import { resolveShaderPackagePipeline } from "../shaderPackage/pipeline.js";
import { adaptDeepSlStandardToShaderPackage } from "./packageAdapter.js";
import { ALL_TEXTURES, OPAQUE, packageRequest } from "./packageAdapter.testFixture.js";
import { TEST_CAPABILITIES } from "./testFixture.js";

function adapt(source = OPAQUE) {
  const result = adaptDeepSlStandardToShaderPackage({ ...packageRequest(source), targetAbi: "deep.pbr.mesh.v2" });
  if (!result.success) throw new Error(JSON.stringify(result.report));
  return result;
}
const variants = ["opaque", "mask", "blend"].flatMap(alpha => [false, true].flatMap(double =>
  ["plain", "material", "normal"].map(texture => ({ alpha, double, texture }))));
function sourceFor(variant: typeof variants[number]): string {
  return (variant.texture === "normal" ? ALL_TEXTURES : OPAQUE)
    .replace("alpha opaque", `alpha ${variant.alpha}`).replace("doubleSided false", `doubleSided ${variant.double}`)
    .replace("baseColorTexture off", variant.texture === "material" ? "baseColorTexture on" : "baseColorTexture off");
}

describe("DeepSL explicit CSM ABI", () => {
  it("keeps the complete default v1 output and source maps byte-identical", () => {
    for (const variant of variants) {
      const source = sourceFor(variant);
      const previous = adaptDeepSlStandardToShaderPackage(packageRequest(source));
      const explicit = adaptDeepSlStandardToShaderPackage({ ...packageRequest(source), targetAbi: "deep.pbr.mesh.v1" });
      expect(JSON.stringify(explicit)).toBe(JSON.stringify(previous));
      if (!previous.success) throw new Error(JSON.stringify(previous.report));
      const current = adapt(source);
      expect(previous.package.shaderAbi.contentHash.value).toBe(DEEP_PBR_MESH_V1_SHA256);
      expect(current.package.shaderAbi.contentHash.value).toBe(DEEP_PBR_MESH_V2_SHA256);
      expect(current.package.packageCacheKey).not.toBe(previous.package.packageCacheKey);
      for (const pass of current.package.passes) {
        expect(pass.sourceMap).toEqual(previous.package.passes.find(candidate => candidate.id === pass.id)!.sourceMap);
      }
    }
  });

  it.each(variants)("resolves $alpha / double=$double / $texture through the same bounded passes", variant => {
    const result = adapt(sourceFor(variant));
    expect(validateDeepShaderPackage(result.package)).toMatchObject({ valid: true, diagnostics: [] });
    expect(result.report.shaderAbi).toBe("deep.pbr.mesh.v2");
    expect(result.report.materialTextureDefaults?.enabledSlots.length ?? 0)
      .toBe(variant.texture === "plain" ? 0 : variant.texture === "normal" ? 5 : 1);
    const forward = result.package.passes.filter(pass => pass.kind === "forward");
    const shadow = result.package.passes.filter(pass => pass.kind === "shadow");
    const raster = variant.double ? ["double"] : ["ccw", "cw"];
    expect(forward.map(pass => pass.pipeline.rasterMode)).toEqual(raster);
    expect(forward.every(pass => pass.pipeline.passVariantId === `forward-${variant.texture}`)).toBe(true);
    expect(shadow.map(pass => pass.pipeline.rasterMode)).toEqual(variant.alpha === "blend" ? [] : raster);
    for (const pass of result.package.passes) {
      const pipeline = resolveShaderPackagePipeline(result.package.shaderAbi.contract, pass.pipeline)!;
      expect(pipeline).toBeDefined();
      expect(pipeline.attachmentProfile.sampleCount).toBe(pass.kind === "forward" ? 4 : 1);
      expect(pipeline.bindGroupLayouts[0]!.bindings.length).toBe(pass.kind === "forward" ? 8 : 1);
      expect(pass.pipeline.alphaMode).toBe(variant.alpha.toUpperCase());
    }
  });

  it("reproduces the actual Native cross-language MASK/normal fixture", () => {
    const golden = JSON.parse(readFileSync(new URL("../../../deep-engine-native/tests/fixtures/deep_shader_package_csm_v2.json", import.meta.url), "utf8"));
    const result = adapt(ALL_TEXTURES.replace("alpha opaque", "alpha mask"));
    expect(result.package).toEqual(golden);
    expect(validateDeepShaderPackage(golden)).toMatchObject({ valid: true, diagnostics: [] });
  });

  it("rejects forged ABI identity, layout, fingerprint and unknown fields even with a new envelope hash", () => {
    const original = adapt().package;
    const changes = [
      (value: any) => { value.shaderAbi.id = "deep.pbr.mesh.v1"; },
      (value: any) => { value.shaderAbi.contentHash.value = DEEP_PBR_MESH_V1_SHA256; },
      (value: any) => { value.shaderAbi.contract.dataLayouts[3].byteSize = 320; },
      (value: any) => { value.shaderAbi.contract.bindGroupLayouts[0].bindings[1].resource.viewDimension = "2d"; },
      (value: any) => { value.shaderAbi.contract.unversioned = true; },
    ];
    for (const change of changes) {
      const altered = structuredClone(original);
      change(altered);
      altered.packageCacheKey = computeDeepShaderPackageCacheKey(altered);
      const validation = validateDeepShaderPackage(altered);
      expect(validation.valid).toBe(false);
      expect(validation.diagnostics.some(issue => issue.path.startsWith("$.shaderAbi"))).toBe(true);
    }
  });

  it.each([null, "deep.pbr.mesh.v4", 2, {}])("rejects unsupported target %s", targetAbi => {
    const result = adaptDeepSlStandardToShaderPackage({ ...packageRequest(OPAQUE), targetAbi });
    expect(result).toMatchObject({ success: false, report: { issues: [{ path: "$.targetAbi", code: "invalid-request" }] } });
  });

  it("rejects limited CSM binding capacity and reports the requested v2 ABI", () => {
    const result = adaptDeepSlStandardToShaderPackage({ ...packageRequest(OPAQUE), targetAbi: "deep.pbr.mesh.v2",
      capabilities: { ...TEST_CAPABILITIES, limits: { ...TEST_CAPABILITIES.limits, maxBindingsPerBindGroup: 7 } } });
    expect(result).toMatchObject({ success: false, report: { shaderAbi: "deep.pbr.mesh.v2",
      issues: [{ code: "unsupported-capability", path: "$.capabilities.limits.maxBindingsPerBindGroup" }] } });
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates all 18 generated CSM modules with Naga", () => {
    for (const variant of variants) {
      const source = adapt(sourceFor(variant)).package.modules[0]!.source;
      const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "csm-adapter.wgsl", "--input-kind", "wgsl"],
        { input: source, encoding: "utf8", timeout: 20_000 });
      expect({ variant, status: validation.status, stderr: validation.stderr, error: validation.error })
        .toEqual({ variant, status: 0, stderr: "", error: undefined });
    }
  });
});
