import { describe, expect, it } from "vitest";
import type { DeepShaderPackageV2 } from "./types.js";
import {
  buildDeepShaderPackage, computeDeepShaderPackageCacheKey,
  DEEP_SHADER_PACKAGE_BUDGETS, validateDeepShaderPackage,
} from "./index.js";

const CODE = "@vertex fn vertexMain() -> @builtin(position) vec4f { return vec4f(); }\n"
  + "@fragment fn fragmentMain() -> @location(0) vec4f { return vec4f(1); }\n";

const input = (code = CODE) => ({
  packageId: "deep.test", packageVersion: "1.0.0", compilerVersion: "0.2.0",
  passes: [{
    techniqueId: "pbr", passId: "forward", kind: "forward",
    module: { label: "deep.test/pbr/forward", code },
    entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
    pipeline: {
      passVariantId: "forward-plain", attachmentProfileId: "forward-opaque",
      alphaMode: "OPAQUE", rasterMode: "ccw",
    },
  }],
});

function validPackage(): DeepShaderPackageV2 {
  const built = buildDeepShaderPackage(input());
  expect(built.success).toBe(true);
  return built.value!;
}

const clone = (value: DeepShaderPackageV2): any => JSON.parse(JSON.stringify(value));
const rehash = (value: any): void => { value.packageCacheKey = computeDeepShaderPackageCacheKey(value); };
const codes = (value: unknown) => validateDeepShaderPackage(value).diagnostics.map((entry) => entry.code);

describe("Deep Shader Package fail-closed validation", () => {
  it("rejects unknown fields and legacy caller reflection", () => {
    const value = clone(validPackage());
    value.extra = true;
    expect(codes(value)).toContain("unknown-field");
    const legacy = input() as any;
    legacy.passes[0].reflection = { bindings: [], vertexInputs: [] };
    legacy.passes[0].renderState = {};
    legacy.passes[0].cacheKey = "a".repeat(64);
    expect(buildDeepShaderPackage(legacy).diagnostics.map((entry) => entry.code)).toContain("unknown-field");
  });

  it("rejects accessors and proxies without invoking getters", () => {
    const value = clone(validPackage());
    let reads = 0;
    Object.defineProperty(value, "packageId", {
      enumerable: true, get: () => { reads += 1; return "deep.test"; },
    });
    expect(codes(value)).toContain("non-canonical");
    expect(reads).toBe(0);
    const proxy = new Proxy(clone(validPackage()), { ownKeys: () => { throw new Error("blocked"); } });
    expect(codes(proxy)).toContain("non-canonical");
  });

  it("never throws for malformed ABI, module, dependency, or pipeline shapes", () => {
    for (const value of [
      { schema: "deep-shader-package", schemaVersion: 2 },
      { ...clone(validPackage()), shaderAbi: null },
      { ...clone(validPackage()), dependencies: null },
      { ...clone(validPackage()), modules: [{ id: "module.bad" }] },
      { ...clone(validPackage()), passes: [{ pipeline: null }] },
    ]) {
      expect(() => validateDeepShaderPackage(value)).not.toThrow();
      expect(validateDeepShaderPackage(value).valid).toBe(false);
    }
    for (const malformed of [
      { ...input(), dependencies: null },
      { ...input(), dependencies: [{}] },
      { ...input(), passes: [{ ...input().passes[0], module: { label: "bad", code: null } }] },
    ]) {
      expect(() => buildDeepShaderPackage(malformed)).not.toThrow();
      expect(buildDeepShaderPackage(malformed).success).toBe(false);
    }
    const saturated = clone(validPackage());
    for (let index = 0; index < DEEP_SHADER_PACKAGE_BUDGETS.maxIssues; index += 1) {
      saturated[`unknown${index}`] = true;
    }
    saturated.shaderAbi = { contract: null };
    saturated.modules = [{ id: 7, source: 3 }];
    expect(() => validateDeepShaderPackage(saturated)).not.toThrow();
    expect(validateDeepShaderPackage(saturated).valid).toBe(false);
  });

  it("rejects cycles, sparse arrays, and non-finite execution values", () => {
    const cyclic = clone(validPackage());
    cyclic.cycle = cyclic;
    expect(codes(cyclic)).toContain("non-canonical");
    const sparse = clone(validPackage());
    sparse.modules = new Array(1);
    expect(codes(sparse)).toContain("non-canonical");
    const nonFinite = clone(validPackage());
    nonFinite.shaderAbi.contract.attachmentProfiles[0].depthAttachment.depthBias = Infinity;
    expect(codes(nonFinite)).toContain("non-canonical");
  });

  it("rejects WGSL over budget before hashing it", () => {
    const result = buildDeepShaderPackage(input("x".repeat(
      DEEP_SHADER_PACKAGE_BUDGETS.maxWgslBytesPerModule + 1,
    )));
    expect(result.success).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("budget-exceeded");
  });

  it("rejects source, module, pass, and package hash tampering", () => {
    const source = clone(validPackage());
    source.modules[0].source += "\n";
    rehash(source);
    expect(codes(source)).toContain("hash-mismatch");
    const moduleId = clone(validPackage());
    moduleId.modules[0].id = `module.${"f".repeat(64)}`;
    moduleId.passes[0].moduleId = moduleId.modules[0].id;
    rehash(moduleId);
    expect(codes(moduleId)).toContain("hash-mismatch");
    const pass = clone(validPackage());
    pass.passes[0].pipeline.rasterMode = "cw";
    rehash(pass);
    expect(codes(pass)).toContain("cache-key-mismatch");
    const packageCache = clone(validPackage());
    packageCache.packageCacheKey = "f".repeat(64);
    expect(codes(packageCache)).toContain("cache-key-mismatch");
  });

  it("rejects unknown variants and mismatched ABI entry points", () => {
    const variant = clone(validPackage());
    variant.passes[0].pipeline.passVariantId = "forward-invented";
    rehash(variant);
    expect(codes(variant)).toContain("invalid-value");
    const entry = clone(validPackage());
    entry.passes[0].entryPoints.vertex = "shadowMain";
    rehash(entry);
    expect(codes(entry)).toContain("invalid-value");
  });

  it("does not accept entry points forged in comments or strings", () => {
    for (const code of [
      "// @vertex fn vertexMain() -> vec4f {}\n@fragment fn fragmentMain() -> vec4f {}",
      "/* outer /* @vertex fn vertexMain() {} */ still comment */\n@fragment fn fragmentMain() -> vec4f {}",
      "let forged = \"@vertex fn vertexMain()\";\n@fragment fn fragmentMain() -> vec4f {}",
    ]) {
      const result = buildDeepShaderPackage(input(code));
      expect(result.success).toBe(false);
      expect(result.diagnostics.map((entry) => entry.code)).toContain("missing-reference");
    }
  });

  it("explicitly rejects the unpublished v1 envelope", () => {
    const legacy = clone(validPackage());
    legacy.schemaVersion = 1;
    legacy.targetProfile = "webgpu-wgsl-1";
    expect(codes(legacy)).toContain("invalid-value");
  });

  it("returns an immutable snapshot isolated from later mutation", () => {
    const mutable = clone(validPackage());
    const result = validateDeepShaderPackage(mutable);
    expect(result.valid).toBe(true);
    mutable.shaderAbi.contract.vertexStreams[0].arrayStride = 999;
    expect(result.value?.shaderAbi.contract.vertexStreams[0]?.arrayStride).toBe(40);
    expect(Object.isFrozen(result.value?.shaderAbi.contract.vertexStreams)).toBe(true);
  });
});
