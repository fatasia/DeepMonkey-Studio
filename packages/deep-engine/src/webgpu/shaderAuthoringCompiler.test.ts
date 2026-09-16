import { describe, expect, it, vi } from "vitest";
import { DEEP_SL_SURFACE_EXAMPLE } from "../shaderAuthoring/index.js";
import { createWebGpuDeepSlCompiler, shaderCapabilitiesForDevice } from "./shaderAuthoringCompiler.js";

function device(messages: readonly GPUCompilationMessage[] = [], reject?: Error): GPUDevice {
  return {
    features: new Set(["texture-compression-bc", "shader-f16", "timestamp-query"]),
    limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 24, maxInterStageShaderVariables: 16 },
    createShaderModule: vi.fn(() => ({ getCompilationInfo: vi.fn(() => reject
      ? Promise.reject(reject) : Promise.resolve({ messages })) })),
  } as unknown as GPUDevice;
}

const request = (source = DEEP_SL_SURFACE_EXAMPLE) => ({
  document: { schemaVersion: 1 as const, id: "test.surface", mode: "text" as const,
    language: "deepsl" as const, source },
  revision: "a".repeat(64), candidateId: 1,
});

describe("WebGPU DeepSL authoring compiler", () => {
  it("derives a sorted, supported capability snapshot from the active device", () => {
    expect(shaderCapabilitiesForDevice(device())).toEqual({
      features: ["shader-f16", "texture-compression-bc"],
      limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 24, maxInterStageShaderVariables: 16 },
    });
  });

  it("returns the artifact only after real driver WGSL validation succeeds", async () => {
    const gpu = device(), compiler = createWebGpuDeepSlCompiler(gpu);
    const result = await compiler(request());
    expect(result).toMatchObject({ success: true, diagnostics: [], artifact: { target: "webgpu" } });
    expect(gpu.createShaderModule).toHaveBeenCalledOnce();
  });

  it("driver-compiles the complete adapter WGSL for all bounded material semantics", async () => {
    const gpu = device(), compiler = createWebGpuDeepSlCompiler(gpu);
    const source = DEEP_SL_SURFACE_EXAMPLE
      .replace("baseColorTexture off", "baseColorTexture on")
      .replace("metallicRoughnessTexture off", "metallicRoughnessTexture on")
      .replace("normalTexture off", "normalTexture on")
      .replace("occlusionTexture off", "occlusionTexture on")
      .replace("emissiveTexture off", "emissiveTexture on")
      .replace("normalScale 1", "normalScale -0.75")
      .replace("occlusionStrength 1", "occlusionStrength 0.35")
      .replace("emissiveFactor [0, 0, 0]", "emissiveFactor [0.1, 0.2, 0.3]")
      .replace("emissiveStrength 1", "emissiveStrength 8");
    const result = await compiler(request(source));
    expect(result).toMatchObject({ success: true, artifact: { runtimeCompatibility: {
      materialDefaults: { emissiveAlpha: [0.1, 0.2, 0.3, 1] },
      materialTextureDefaults: { normal: { normalScale: -0.75 },
        occlusion: { strength: 0.35 }, emissive: { emissiveStrength: 8 } },
    } } });
    const code = (gpu.createShaderModule as ReturnType<typeof vi.fn>).mock.calls[0]![0].code as string;
    expect(code).toContain("deepMetallicRoughnessSample.b");
    expect(code).toContain("deepMaterialTextures.occlusionRow1.w");
    expect(code).toContain("deepPackageMappedNormal(");
    expect(code).toContain("deepEmissiveSample * deepMaterialTextures.emissiveRow1.w");
  });

  it("maps driver failures back to source and withholds the invalid artifact", async () => {
    const error = { type: "error", lineNum: 1, linePos: 7,
      message: "driver rejected module" } as GPUCompilationMessage;
    const result = await createWebGpuDeepSlCompiler(device([error]))(request());
    expect(result.success).toBe(false); expect(result.artifact).toBeUndefined();
    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: "error", source: "text-compiler", code: "wgsl-error",
      path: "$.source", range: expect.objectContaining({ start: { line: 1, column: 1 } }),
    })]);
  });

  it("reports a lost compilation service without publishing the candidate", async () => {
    const result = await createWebGpuDeepSlCompiler(device([], new Error("device lost")))(request());
    expect(result).toMatchObject({ success: false, diagnostics: [{
      severity: "error", source: "text-compiler", code: "gpu-compilation-unavailable",
      path: "$.source", message: "device lost",
    }] });
  });
});
