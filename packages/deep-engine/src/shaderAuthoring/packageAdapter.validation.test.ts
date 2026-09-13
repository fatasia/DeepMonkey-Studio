import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileShaderPass } from "../shader/compiler.js";
import type { CompiledShaderPass, DeepShaderAsset } from "../shader/types.js";
import { buildDeepPbrMeshV1StandardShader } from "../shaderPresets/packageStandardSurface.js";
import { TEST_CAPABILITIES } from "./testFixture.js";
import { adaptDeepSlStandardToShaderPackage } from "./packageAdapter.js";
import { adaptStandardPlainWgsl } from "./packageAdapterWgsl.js";
import { ALL_TEXTURES, OPAQUE, packageRequest as request } from "./packageAdapter.testFixture.js";

describe("DeepSL Shader Package v2 adapter", () => {
  it("fails closed when the device cannot represent the fixed material group", () => {
    const textured = OPAQUE.replace("baseColorTexture off", "baseColorTexture on");
    expect(adaptDeepSlStandardToShaderPackage({ ...request(textured), capabilities: {
      features: [], limits: { maxBindGroups: 1, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 },
    } })).toMatchObject({
      success: false,
      report: {
        adapterProfile: "deep.pbr.mesh.v1/deepsl-standard-textures.v2",
        issues: [{ code: "unsupported-capability", path: "$.capabilities.limits.maxBindGroups" }],
      },
    });
    expect(adaptDeepSlStandardToShaderPackage({ ...request(textured), capabilities: {
      features: [], limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 10, maxInterStageShaderVariables: 16 },
    } })).toMatchObject({
      success: false,
      report: { issues: [{ code: "unsupported-capability", path: "$.capabilities.limits.maxBindingsPerBindGroup" }] },
    });
  });

  it("maps parser, capability, and package contract failures without an executable value", () => {
    const parseFailure = adaptDeepSlStandardToShaderPackage(request("bad"));
    expect(parseFailure.success).toBe(false);
    expect(parseFailure.report.issues[0]).toMatchObject({ code: "invalid-deepsl" });
    expect(adaptDeepSlStandardToShaderPackage({ ...request(OPAQUE), packageId: "Bad Package" })).toMatchObject({
      success: false, report: { issues: [{ code: "package-build-failed" }] },
    });
    expect(adaptDeepSlStandardToShaderPackage({ ...request(OPAQUE), capabilities: {
      features: [], limits: { maxBindGroups: 1, maxBindingsPerBindGroup: 6, maxInterStageShaderVariables: 8 },
    } })).toMatchObject({ success: false, report: { issues: [{ code: "unsupported-capability" }] } });
  });

  it("rejects malformed capabilities as request data before compiling", () => {
    expect(adaptDeepSlStandardToShaderPackage({ ...request(OPAQUE), capabilities: {
      features: [], limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16 },
    } })).toMatchObject({
      success: false,
      report: { issues: [{ code: "invalid-request", path: "$.capabilities.limits.maxInterStageShaderVariables" }] },
    });
    expect(adaptDeepSlStandardToShaderPackage({ ...request(OPAQUE), capabilities: {
      features: ["shader-f16", "shader-f16"],
      limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 },
    } })).toMatchObject({
      success: false, report: { issues: [{ code: "invalid-request", path: "$.capabilities.features.1" }] },
    });
    let reads = 0;
    const accessorCapabilities = { limits: {
      maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16,
    } } as Record<string, unknown>;
    Object.defineProperty(accessorCapabilities, "features", {
      enumerable: true, get: () => { reads += 1; return []; },
    });
    expect(adaptDeepSlStandardToShaderPackage({ ...request(OPAQUE), capabilities: accessorCapabilities }))
      .toMatchObject({ success: false, report: { issues: [{ code: "invalid-request" }] } });
    expect(reads).toBe(0);
  });

  it("fails closed when a compiled module drifts from the fixed frame or vertex ABI", () => {
    const built = buildDeepPbrMeshV1StandardShader({ id: "deep.package", alphaMode: "opaque" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const compiled = compileShaderPass(built.asset, "webgpu", "forward", TEST_CAPABILITIES).value!;
    expect(adaptStandardPlainWgsl(compiled, built.asset)).toBeDefined();

    const movedAttributes = built.asset.attributes.map((attribute) => attribute.semantic === "BASE_COLOR_METALLIC"
      ? { ...attribute, location: 14 } : attribute);
    expect(adaptStandardPlainWgsl(compiled, { ...built.asset, attributes: movedAttributes } as DeepShaderAsset))
      .toBeUndefined();

    const shortenedFrame = {
      ...compiled,
      lightingContext: {
        ...compiled.lightingContext!,
        dataLayouts: [{ ...compiled.lightingContext!.dataLayouts[0]!, byteSize: 192 }],
      },
    } as CompiledShaderPass;
    expect(adaptStandardPlainWgsl(shortenedFrame, built.asset)).toBeUndefined();

    const extraBinding = {
      ...compiled,
      module: { ...compiled.module, code: `${compiled.module.code}@group(0) @binding(7) var extra: sampler;\n` },
    } as CompiledShaderPass;
    expect(adaptStandardPlainWgsl(extraBinding, built.asset)).toBeUndefined();
    expect(adaptStandardPlainWgsl(compiled, built.asset, { alphaMode: "mask", doubleSided: false }))
      .toBeUndefined();

    const textured = buildDeepPbrMeshV1StandardShader({
      id: "deep.package", alphaMode: "opaque", materialMode: "base-color-texture",
    });
    expect(textured.ok).toBe(true);
    if (!textured.ok) return;
    const texturedCompiled = compileShaderPass(textured.asset, "webgpu", "forward", TEST_CAPABILITIES).value!;
    expect(adaptStandardPlainWgsl(texturedCompiled, textured.asset, {
      alphaMode: "opaque", doubleSided: false, materialMode: "base-color-texture",
    })).toBeDefined();
    expect(adaptStandardPlainWgsl(compiled, built.asset, {
      alphaMode: "opaque", doubleSided: false, materialMode: "base-color-texture",
    })).toBeUndefined();
    expect(adaptStandardPlainWgsl(texturedCompiled, textured.asset)).toBeUndefined();

    const normalMapped = buildDeepPbrMeshV1StandardShader({
      id: "deep.package", alphaMode: "opaque", materialMode: "base-color-texture", normalMapped: true,
    });
    expect(normalMapped.ok).toBe(true);
    if (!normalMapped.ok) return;
    const normalCompiled = compileShaderPass(normalMapped.asset, "webgpu", "forward", TEST_CAPABILITIES).value!;
    expect(adaptStandardPlainWgsl(normalCompiled, normalMapped.asset, {
      alphaMode: "opaque", doubleSided: false, materialMode: "base-color-texture", normalMapped: true,
    })).toBeDefined();
    expect(adaptStandardPlainWgsl(texturedCompiled, textured.asset, {
      alphaMode: "opaque", doubleSided: false, materialMode: "base-color-texture", normalMapped: true,
    })).toBeUndefined();
  });

  it("rejects unknown request fields and produces deterministic package hashes", () => {
    expect(adaptDeepSlStandardToShaderPackage({ ...request(OPAQUE), extra: true })).toMatchObject({
      success: false, report: { issues: [{ code: "invalid-request", path: "$.extra" }] },
    });
    const first = adaptDeepSlStandardToShaderPackage(request(OPAQUE));
    const second = adaptDeepSlStandardToShaderPackage(request(OPAQUE));
    expect(first.success && second.success && first.package.packageCacheKey === second.package.packageCacheKey).toBe(true);
    const variants = [
      OPAQUE,
      OPAQUE.replace("alpha opaque", "alpha mask"),
      OPAQUE.replace("alpha opaque", "alpha blend"),
      OPAQUE.replace("doubleSided false", "doubleSided true"),
    ].map((source) => adaptDeepSlStandardToShaderPackage(request(source)));
    expect(variants.every((entry) => entry.success)).toBe(true);
    expect(new Set(variants.map((entry) => entry.success ? entry.package.packageCacheKey : "rejected")).size).toBe(4);
  });

  it("characterizes serialized package output", () => {
    for (const [name, source] of [
      ["opaque", OPAQUE],
      ["mask", OPAQUE.replace("alpha opaque", "alpha mask")],
      ["blend", OPAQUE.replace("alpha opaque", "alpha blend")],
      ["allTextures", ALL_TEXTURES],
    ] as const) {
      const result = adaptDeepSlStandardToShaderPackage(request(source));
      expect(result.success).toBe(true);
      if (!result.success) continue;
      const json = JSON.stringify(result);
      console.log(name, result.package.packageCacheKey, createHash("sha256").update(json).digest("hex"), Buffer.byteLength(json));
    }
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("emits a Naga-valid ABI module", () => {
    for (const variant of [
      { alpha: "opaque", doubleSided: false },
      { alpha: "opaque", doubleSided: true },
      { alpha: "blend", doubleSided: false },
      { alpha: "blend", doubleSided: true },
      { alpha: "mask", doubleSided: false },
      { alpha: "mask", doubleSided: true },
    ].flatMap((variant) => [
      { ...variant, textured: false, normal: false },
      ...(variant.alpha === "opaque" || variant.alpha === "mask"
        ? [{ ...variant, textured: true, normal: false }, { ...variant, textured: true, normal: true }] : []),
    ] as const)) {
      const source = OPAQUE.replace("alpha opaque", `alpha ${variant.alpha}`)
        .replace("doubleSided false", `doubleSided ${variant.doubleSided}`)
        .replace("baseColorTexture off", variant.normal
          ? `baseColorTexture on;\n  normalTexture on;\n  normalTextureTransform texCoord 1 offset [0.1, -0.2] scale [2, 0.5] rotation 0.25;\n  normalScale 0.7`
          : `baseColorTexture ${variant.textured ? "on" : "off"}`);
      const result = adaptDeepSlStandardToShaderPackage(request(source));
      expect(result.success, JSON.stringify({ variant, issues: result.report.issues })).toBe(true);
      if (!result.success) continue;
      const validation = spawnSync(
        process.env.DEEP_SHADER_NAGA_BIN!,
        ["--stdin-file-path", `deepsl-package-adapter-${variant.alpha}-${variant.doubleSided}-${variant.textured}-${variant.normal}.wgsl`, "--input-kind", "wgsl"],
        { input: result.package.modules[0]!.source, encoding: "utf8" },
      );
      expect({ variant, status: validation.status, stderr: validation.stderr })
        .toEqual({ variant, status: 0, stderr: "" });
    }
  });
});
