import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adaptDeepSlStandardToShaderPackage } from "../shaderAuthoring/packageAdapter.js";
import { ALL_TEXTURES, packageRequest } from "../shaderAuthoring/packageAdapter.testFixture.js";
import { adaptDeepSlUnlitToShaderPackage } from "../shaderAuthoring/packageUnlitAdapter.js";
import { validateDeepShaderPackage } from "../shaderPackage/index.js";
import { ShaderPackageExecutor, ShaderPackageExecutorError } from "./shaderPackageExecutor.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUColorWrite", { ALL: 15 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function standardPackage() {
  const source = ALL_TEXTURES.replace("alpha opaque", "alpha mask")
    .replace("doubleSided false", "doubleSided true")
    .replace("metallic 0.65;", "metallic 0.65;\n  clearcoatFactor 0.7;\n  clearcoatRoughness 0.2;");
  const result = adaptDeepSlStandardToShaderPackage({ ...packageRequest(source), targetAbi: "deep.pbr.mesh.v3" });
  if (!result.success) throw new Error(JSON.stringify(result.report));
  return result.package;
}

function unlitPackage() {
  const source = `shader deep.unlit {
    surface unlit;
    baseColor [0.2, 0.4, 0.8, 0.75];
    emissiveFactor [0.1, 0.2, 0.3];
    emissiveStrength 2;
    alpha mask;
    doubleSided true;
    baseColorTexture on;
    emissiveTexture on;
  }`;
  const result = adaptDeepSlUnlitToShaderPackage({ ...packageRequest(source), targetAbi: "deep.pbr.mesh.v3" });
  if (!result.success) throw new Error(JSON.stringify(result.report));
  return result.package;
}

function fakeDevice() {
  const bindGroups: GPUBindGroupLayoutDescriptor[] = [], pipelines: GPURenderPipelineDescriptor[] = [];
  const device = {
    lost: new Promise<GPUDeviceLostInfo>(() => {}), pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null),
    createShaderModule: vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [] }) })),
    createBindGroupLayout: vi.fn((value: GPUBindGroupLayoutDescriptor) => { bindGroups.push(value); return { value }; }),
    createPipelineLayout: vi.fn((value: GPUPipelineLayoutDescriptor) => ({ value })),
    createRenderPipelineAsync: vi.fn(async (value: GPURenderPipelineDescriptor) => { pipelines.push(value); return { value }; }),
  };
  return { device: device as unknown as GPUDevice, deviceMock: device, bindGroups, pipelines };
}

describe("DeepSL v3 depth and object-id packages", () => {
  it("uses one MASK rule and instance-index object IDs in Standard and Unlit", () => {
    for (const packageValue of [standardPackage(), unlitPackage()]) {
      expect(packageValue.shaderAbi.id).toBe("deep.pbr.mesh.v3");
      expect(packageValue.passes.map((entry) => entry.kind)).toEqual(["depth", "forward", "picking", "shadow"]);
      expect(validateDeepShaderPackage(packageValue).valid).toBe(true);
      const source = packageValue.modules[0]!.source;
      expect(source).toContain("@vertex fn depthMaskMain");
      expect(source).toContain("@fragment fn depthMaskTextured");
      expect(source).toContain("@vertex fn pickingMaskMain");
      expect(source).toContain("@fragment fn pickingMaskTextured");
      expect(source).toContain("alpha *= textureSample(deepBaseColorMap");
      expect(source).toContain("@location(14) objectId: vec4f");
      expect(source).toContain("output.objectId = input.objectId;");
      expect(source).toContain("return input.objectId;");
      expect(packageValue.passes.every((entry) => entry.pipeline.rasterMode === "double")).toBe(true);
    }
    expect(standardPackage().modules[0]!.source).toContain("let deepClearcoatDirectSpecular");
    expect(standardPackage().modules[0]!.source).toContain("let deepClearcoatIndirect");
    expect(standardPackage().modules[0]!.source).toContain("deepClearcoatDirectAttenuation");
  });

  it("maps auxiliary passes to executable Browser descriptors and fails closed", async () => {
    const packageValue = standardPackage(), fake = fakeDevice();
    const prepared = await new ShaderPackageExecutor(fake.device).prepare(packageValue);
    expect(prepared.passes).toHaveLength(4);
    const depth = fake.pipelines.find((entry) => entry.label?.includes("depthDouble"))!;
    const picking = fake.pipelines.find((entry) => entry.label?.includes("pickingDouble"))!;
    expect(depth.fragment).toMatchObject({ entryPoint: "depthMaskTextured", targets: [] });
    expect(depth.multisample).toEqual({ count: 1 });
    expect(picking.fragment).toMatchObject({ entryPoint: "pickingMaskTextured",
      targets: [{ format: "rgba16float", writeMask: 15 }] });
    expect(picking.multisample).toEqual({ count: 1 });
    expect(picking.vertex.buffers?.[1]).toMatchObject({ arrayStride: 160,
      attributes: expect.arrayContaining([{ shaderLocation: 14, offset: 144, format: "float32x4" }]) });
    const viewFrame = fake.bindGroups.find((entry) => entry.label?.endsWith("view-frame"))!;
    expect(Array.from(viewFrame.entries)).toEqual([{ binding: 0, visibility: 1,
      buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: 208 } }]);
    expect(fake.deviceMock.popErrorScope).toHaveBeenCalledOnce();

    const invalid: any = JSON.parse(JSON.stringify(packageValue));
    const pass = invalid.passes.find((entry: any) => entry.kind === "picking");
    pass.entryPoints.fragment = "fragmentMain";
    const rejected = fakeDevice();
    await expect(new ShaderPackageExecutor(rejected.device).prepare(invalid))
      .rejects.toBeInstanceOf(ShaderPackageExecutorError);
    expect(rejected.deviceMock.createShaderModule).not.toHaveBeenCalled();
    expect(validateDeepShaderPackage(invalid).diagnostics)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining("entryPoints") })]));
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga for both complete v3 modules", () => {
    for (const packageValue of [standardPackage(), unlitPackage()]) {
      const checked = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, [
        "--stdin-file-path", `${packageValue.packageId}.wgsl`, "--input-kind", "wgsl",
      ], { input: packageValue.modules[0]!.source, encoding: "utf8" });
      expect(checked.status, checked.stderr).toBe(0);
    }
  });
});
