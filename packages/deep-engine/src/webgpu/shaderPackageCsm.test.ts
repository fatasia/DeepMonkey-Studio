import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEEP_PBR_MESH_V1_SHA256, DEEP_PBR_MESH_V2_SHA256 } from "../shaderAbi/index.js";
import {
  assertPackageMatchesScope, shaderCacheIdentity, shaderPackageStoreKey, validateShaderCacheScope,
} from "../shaderCache/index.js";
import { adaptDeepSlStandardToShaderPackage } from "../shaderAuthoring/packageAdapter.js";
import { ALL_TEXTURES, packageRequest } from "../shaderAuthoring/packageAdapter.testFixture.js";
import { ShaderPackageExecutor } from "./shaderPackageExecutor.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUColorWrite", { ALL: 15 });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function packageValue(targetAbi: "deep.pbr.mesh.v1" | "deep.pbr.mesh.v2") {
  const result = adaptDeepSlStandardToShaderPackage({ ...packageRequest(ALL_TEXTURES.replace("alpha opaque", "alpha mask")), targetAbi });
  if (!result.success) throw new Error(JSON.stringify(result.report));
  return result.package;
}

function fakeDevice() {
  const bindGroups: GPUBindGroupLayoutDescriptor[] = [];
  const pipelines: GPURenderPipelineDescriptor[] = [];
  let reject = false;
  const mock = {
    lost: new Promise<GPUDeviceLostInfo>(() => {}),
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null),
    createShaderModule: vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [] }) })),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => {
      bindGroups.push(descriptor);
      return { descriptor };
    }),
    createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => ({ descriptor })),
    createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) => {
      pipelines.push(descriptor);
      if (reject) throw new Error("CSM driver rejected");
      return { descriptor };
    }),
  };
  return { device: mock as unknown as GPUDevice, mock, bindGroups, pipelines, reject: (value: boolean) => { reject = value; } };
}

describe("Browser CSM package execution and cache isolation", () => {
  it("creates depth-array/336B bindings and fixed shadow offsets without changing material streams", async () => {
    const fake = fakeDevice();
    const executor = new ShaderPackageExecutor(fake.device);
    const result = await executor.prepare(packageValue("deep.pbr.mesh.v2"));
    expect(result.passes).toHaveLength(4);
    const forward = fake.bindGroups.find(layout => layout.label?.endsWith("forward-frame"))!;
    const shadow = fake.bindGroups.find(layout => layout.label?.endsWith("shadow-frame"))!;
    const material = fake.bindGroups.find(layout => layout.label?.endsWith("material"))!;
    expect(Array.from(forward.entries)).toHaveLength(8);
    expect(Array.from(forward.entries)[1]).toMatchObject({ binding: 1, visibility: 2,
      texture: { sampleType: "depth", viewDimension: "2d-array", multisampled: false } });
    expect(Array.from(forward.entries)[7]).toMatchObject({ binding: 7, visibility: 2,
      buffer: { type: "uniform", minBindingSize: 336, hasDynamicOffset: false } });
    expect(Array.from(shadow.entries)).toEqual([{ binding: 0, visibility: 1,
      buffer: { type: "uniform", minBindingSize: 208, hasDynamicOffset: false } }]);
    expect(Array.from(material.entries).find(entry => entry.binding === 4)?.buffer?.minBindingSize).toBe(160);
    for (const descriptor of fake.pipelines) {
      expect(Array.from(descriptor.vertex.buffers ?? []).map(buffer => buffer?.arrayStride))
        .toEqual(descriptor.label?.includes("forward") ? [40, 144, 16] : [40, 144]);
    }
    executor.dispose();
  });

  it("allows both ABIs in one executor and never publishes a failed v2 candidate", async () => {
    const fake = fakeDevice();
    const executor = new ShaderPackageExecutor(fake.device);
    const previous = packageValue("deep.pbr.mesh.v1"), current = packageValue("deep.pbr.mesh.v2");
    const v1 = await executor.prepare(previous);
    fake.reject(true);
    await expect(executor.prepare(current)).rejects.toThrow("CSM driver rejected");
    fake.reject(false);
    const v2 = await executor.prepare(current);
    expect(fake.pipelines).toHaveLength(12);
    const again = await executor.prepare(current);
    expect(fake.pipelines).toHaveLength(12);
    expect(again.passes[0]!.pipeline).toBe(v2.passes[0]!.pipeline);
    expect(v1.passes[0]!.pipeline).not.toBe(v2.passes[0]!.pipeline);
    expect(v1.passes[0]!.bindGroupLayouts[0]).not.toBe(v2.passes[0]!.bindGroupLayouts[0]);
    expect(fake.mock.pushErrorScope).toHaveBeenCalledTimes(3);
    expect(fake.mock.popErrorScope).toHaveBeenCalledTimes(3);
    executor.dispose();
  });

  it("separates persistent identities and rejects packages crossing ABI scopes", () => {
    const common = { namespace: "deep.csm", packageSchemaVersion: 2 as const,
      targetProfile: "webgpu-wgsl-pipeline-2" as const, compilerVersion: "1.0.0" };
    const v1 = validateShaderCacheScope({ ...common, shaderAbiId: "deep.pbr.mesh.v1", shaderAbiHash: DEEP_PBR_MESH_V1_SHA256 });
    const v2 = validateShaderCacheScope({ ...common, shaderAbiId: "deep.pbr.mesh.v2", shaderAbiHash: DEEP_PBR_MESH_V2_SHA256 });
    const hash = "a".repeat(64);
    expect(shaderPackageStoreKey(shaderCacheIdentity(v1, hash))).not.toBe(shaderPackageStoreKey(shaderCacheIdentity(v2, hash)));
    const current = packageValue("deep.pbr.mesh.v2");
    expect(() => assertPackageMatchesScope(current, v2)).not.toThrow();
    expect(() => assertPackageMatchesScope(current, v1)).toThrow("scope");
  });
});
