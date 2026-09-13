import { describe, expect, it } from "vitest";
import type { ShaderPackagePassBuildInput } from "./types.js";
import {
  buildDeepShaderPackage, canonicalShaderPackageJson, computeDeepShaderPackageCacheKey,
  DEEP_SHADER_PACKAGE_SCHEMA_VERSION, DEEP_SHADER_TARGET_PROFILE, sha256Utf8,
  validateDeepShaderPackage,
} from "./index.js";

const CODE = `@vertex fn vertexMain() -> @builtin(position) vec4f {
  return vec4f(0.0, 0.0, 0.0, 1.0);
}
@fragment fn fragmentMain() -> @location(0) vec4f {
  return vec4f(1.0, 0.5, 0.25, 1.0);
}
@vertex fn shadowMain() -> @builtin(position) vec4f {
  return vec4f(0.0, 0.0, 0.0, 1.0);
}
`;

const dependency = (id: string, digit: string) => ({
  id, contentHash: { algorithm: "sha256" as const, value: digit.repeat(64) },
});

function forward(overrides: Partial<ShaderPackagePassBuildInput> = {}): ShaderPackagePassBuildInput {
  return {
    techniqueId: "pbr", passId: "forward", kind: "forward",
    module: { label: "deep.test/pbr/forward", code: CODE },
    entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
    sourceMap: [{ stage: "vertex", nodeId: "position", generatedLine: 2 }],
    dependencyIds: ["deep.common"],
    pipeline: {
      passVariantId: "forward-plain", attachmentProfileId: "forward-opaque",
      alphaMode: "OPAQUE", rasterMode: "ccw",
    },
    ...overrides,
  };
}

function build(passes: readonly ShaderPackagePassBuildInput[] = [forward()]) {
  return buildDeepShaderPackage({
    packageId: "deep.material.test", packageVersion: "1.0.0", compilerVersion: "0.2.0",
    dependencies: [dependency("deep.common", "1")], passes,
  });
}

describe("Deep Shader Package executable pipeline v2", () => {
  it("builds a validated package with a frozen executable ABI", () => {
    const result = build();
    expect(result.success).toBe(true);
    const value = result.value!;
    expect(value.schemaVersion).toBe(DEEP_SHADER_PACKAGE_SCHEMA_VERSION);
    expect(value.targetProfile).toBe(DEEP_SHADER_TARGET_PROFILE);
    expect(value.shaderAbi.id).toBe("deep.pbr.mesh.v1");
    expect(value.shaderAbi.contract.bindGroupLayouts[0]?.bindings[0]?.resource).toMatchObject({
      kind: "uniform-buffer", dataLayout: "frame", minBindingSize: 208,
    });
    expect(value.shaderAbi.contract.vertexStreams[0]).toMatchObject({
      id: "geometry", slot: 0, arrayStride: 40, stepMode: "vertex",
    });
    expect(value.shaderAbi.contract.attachmentProfiles[0]).toMatchObject({
      sampleCount: 4, resolve: "required",
      depthAttachment: { depthBias: 0, depthBiasSlopeScale: 0 },
    });
    expect(value.passes[0]?.pipeline.passVariantId).toBe("forward-plain");
    expect(value.modules[0]?.sourceHash.value).toBe(sha256Utf8(CODE));
    expect(value.packageCacheKey).toBe(computeDeepShaderPackageCacheKey(value));
    expect(validateDeepShaderPackage(value).valid).toBe(true);
    expect(Object.isFrozen(value.shaderAbi.contract.vertexStreams)).toBe(true);
  });

  it("canonicalizes ordering and deduplicates identical WGSL modules", () => {
    const shadow: ShaderPackagePassBuildInput = {
      techniqueId: "pbr", passId: "shadow", kind: "shadow",
      module: { label: "deep.test/pbr/shadow", code: CODE },
      entryPoints: { vertex: "shadowMain", fragment: null },
      dependencyIds: ["deep.common"],
      pipeline: {
        passVariantId: "shadow-solid", attachmentProfileId: "shadow",
        alphaMode: "OPAQUE", rasterMode: "ccw",
      },
    };
    const a = build([shadow, forward()]).value!;
    const b = build([forward(), shadow]).value!;
    expect(canonicalShaderPackageJson(a)).toBe(canonicalShaderPackageJson(b));
    expect(a.modules).toHaveLength(1);
    expect(a.passes.map((pass) => pass.id)).toEqual(["pbr/forward", "pbr/shadow"]);
    expect(a.passes[0]?.moduleId).toBe(a.passes[1]?.moduleId);
  });

  it("changes pass cache keys with concrete execution state", () => {
    const base = build().value!.passes[0]!.cacheKey;
    const raster = build([forward({ pipeline: {
      passVariantId: "forward-plain", attachmentProfileId: "forward-opaque",
      alphaMode: "OPAQUE", rasterMode: "cw",
    } })]).value!.passes[0]!.cacheKey;
    const blend = build([forward({ pipeline: {
      passVariantId: "forward-plain", attachmentProfileId: "forward-blend",
      alphaMode: "BLEND", rasterMode: "ccw",
    } })]).value!.passes[0]!.cacheKey;
    expect(new Set([base, raster, blend]).size).toBe(3);
  });

  it("rejects mutations to ABI layouts, attachments, and variant references", () => {
    const paths: Array<(value: any) => void> = [
      (value) => { value.shaderAbi.contract.bindGroupLayouts[0].bindings[0].binding = 7; },
      (value) => { value.shaderAbi.contract.vertexStreams[0].arrayStride = 44; },
      (value) => { value.shaderAbi.contract.vertexStreams[0].attributes[0].byteOffset = 4; },
      (value) => { value.shaderAbi.contract.attachmentProfiles[0].sampleCount = 1; },
      (value) => { value.shaderAbi.contract.attachmentProfiles[0].resolve = "none"; },
      (value) => { value.shaderAbi.contract.attachmentProfiles[2].depthAttachment.depthBias = 0; },
      (value) => { value.shaderAbi.contract.passVariants[0].vertexStreams = ["geometry"]; },
    ];
    for (const mutate of paths) {
      const value: any = JSON.parse(JSON.stringify(build().value));
      mutate(value);
      expect(validateDeepShaderPackage(value).valid).toBe(false);
    }
  });

  it("uses the standard SHA-256 byte digest", () => {
    expect(sha256Utf8("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
