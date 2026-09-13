import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDeepShaderPackage } from "../shaderPackage/index.js";
import type { ShaderPackagePassBuildInput } from "../shaderPackage/index.js";
import { ShaderPackageExecutor, ShaderPackageExecutorError } from "./shaderPackageExecutor.js";
beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUColorWrite", { ALL: 15 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const CODE = [
  "@vertex fn vertexMain() -> @builtin(position) vec4f { return vec4f(); }",
  "@fragment fn fragmentMain() -> @location(0) vec4f { return vec4f(1); }",
  "@vertex fn vertexNormalMapped() -> @builtin(position) vec4f { return vec4f(); }",
  "@fragment fn fragmentMaterial() -> @location(0) vec4f { return vec4f(1); }",
  "@vertex fn shadowMain() -> @builtin(position) vec4f { return vec4f(); }",
].join("\n");
function forward(blend = false): ShaderPackagePassBuildInput {
  return {
    techniqueId: "pbr", passId: "forward", kind: "forward",
    module: { label: "executor", code: CODE },
    entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
    pipeline: {
      passVariantId: "forward-plain",
      attachmentProfileId: blend ? "forward-blend" : "forward-opaque",
      alphaMode: blend ? "BLEND" : "OPAQUE", rasterMode: "ccw",
    },
  };
}
const shadow = (): ShaderPackagePassBuildInput => ({
  techniqueId: "pbr", passId: "shadow", kind: "shadow",
  module: { label: "executor", code: CODE },
  entryPoints: { vertex: "shadowMain", fragment: null },
  pipeline: {
    passVariantId: "shadow-solid", attachmentProfileId: "shadow",
    alphaMode: "OPAQUE", rasterMode: "double",
  },
});
const normal = (): ShaderPackagePassBuildInput => ({
  techniqueId: "pbr", passId: "normal", kind: "forward",
  module: { label: "executor", code: CODE },
  entryPoints: { vertex: "vertexNormalMapped", fragment: "fragmentMaterial" },
  pipeline: {
    passVariantId: "forward-normal", attachmentProfileId: "forward-opaque",
    alphaMode: "OPAQUE", rasterMode: "ccw",
  },
});
function packageValue(passes: readonly ShaderPackagePassBuildInput[] = [forward(), shadow()]) {
  const built = buildDeepShaderPackage({
    packageId: "deep.executor.test", packageVersion: "2.0.0",
    compilerVersion: "0.2.0", passes,
  });
  expect(built.success).toBe(true);
  return built.value!;
}
function fakeDevice() {
  const lost = deferred<GPUDeviceLostInfo>();
  const descriptors: GPURenderPipelineDescriptor[] = [];
  const bindGroups: GPUBindGroupLayoutDescriptor[] = [];
  const pipelineLayouts: GPUPipelineLayoutDescriptor[] = [];
  let rejectPipelineCall: number | undefined;
  let compilationMessages: readonly GPUCompilationMessage[] = [];
  let pipelineGate: Promise<GPURenderPipeline> | undefined;
  let pipelineCalls = 0;
  let activeScopes = 0, maximumScopes = 0;
  const device = {
    lost: lost.promise,
    pushErrorScope: vi.fn(() => {
      activeScopes += 1;
      maximumScopes = Math.max(maximumScopes, activeScopes);
    }),
    popErrorScope: vi.fn(async () => {
      activeScopes -= 1;
      return null as GPUError | null;
    }),
    createShaderModule: vi.fn(() => ({
      getCompilationInfo: vi.fn(async () => ({ messages: compilationMessages })),
    } as unknown as GPUShaderModule)),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => {
      bindGroups.push(descriptor);
      return { descriptor } as unknown as GPUBindGroupLayout;
    }),
    createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => {
      pipelineLayouts.push(descriptor);
      return { descriptor } as unknown as GPUPipelineLayout;
    }),
    createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) => {
      pipelineCalls += 1;
      descriptors.push(descriptor);
      if (pipelineCalls === rejectPipelineCall) throw new Error("pipeline rejected");
      if (pipelineGate) return pipelineGate;
      return { descriptor } as unknown as GPURenderPipeline;
    }),
  };
  return {
    device: device as unknown as GPUDevice, deviceMock: device, lost,
    descriptors, bindGroups, pipelineLayouts,
    maximumActiveScopes: () => maximumScopes,
    rejectOn: (call: number | undefined) => { rejectPipelineCall = call; },
    waitForPipeline: (promise: Promise<GPURenderPipeline> | undefined) => { pipelineGate = promise; },
    compilationFails: () => { compilationMessages = [{
      type: "error", lineNum: 4, linePos: 2, message: "bad WGSL",
    } as GPUCompilationMessage]; },
  };
}

describe("ShaderPackageExecutor", () => {
  it("maps the frozen ABI into complete WebGPU descriptors", async () => {
    const fake = fakeDevice();
    const result = await new ShaderPackageExecutor(fake.device).prepare(packageValue());
    expect(fake.deviceMock.createShaderModule).toHaveBeenCalledOnce();
    expect(fake.descriptors).toHaveLength(2);
    const main = fake.descriptors.find((value) => value.label?.includes("pbr/forward"))!;
    expect(main.vertex.buffers?.[0]).toMatchObject({
      arrayStride: 40, stepMode: "vertex",
      attributes: expect.arrayContaining([
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 13, offset: 32, format: "float32x2" },
      ]),
    });
    expect(main.vertex.buffers?.[1]).toMatchObject({
      arrayStride: 144, stepMode: "instance",
      attributes: expect.arrayContaining([
        { shaderLocation: 12, offset: 128, format: "float32x4" },
      ]),
    });
    expect(main.fragment?.targets[0]).toEqual({ format: "rgba16float", writeMask: 15 });
    expect(main.primitive).toEqual({ topology: "triangle-list", frontFace: "ccw", cullMode: "back" });
    expect(main.depthStencil).toMatchObject({
      format: "depth24plus", depthWriteEnabled: true, depthCompare: "less",
      depthBias: 0, depthBiasSlopeScale: 0,
    });
    expect(main.multisample).toEqual({ count: 4 });
    expect(fake.bindGroups[0]?.entries[0]).toEqual({
      binding: 0, visibility: 3,
      buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: 208 },
    });
    expect(fake.bindGroups[0]?.entries[1]).toMatchObject({
      binding: 1, visibility: 2,
      texture: { sampleType: "depth", viewDimension: "2d", multisampled: false },
    });
    const shadowDescriptor = fake.descriptors.find((value) => value.label?.includes("pbr/shadow"))!;
    expect(shadowDescriptor.fragment).toBeUndefined();
    expect(shadowDescriptor.primitive).toMatchObject({ frontFace: "ccw", cullMode: "none" });
    expect(shadowDescriptor.depthStencil).toMatchObject({
      format: "depth32float", depthBias: 1, depthBiasSlopeScale: 1,
    });
    expect(shadowDescriptor.multisample).toEqual({ count: 1 });
    expect(result.passes.map((value) => value.resolveRequired)).toEqual([true, false]);
    expect(result.passes.map((value) => value.cacheKey)).toEqual(
      packageValue().passes.map((value) => value.cacheKey),
    );
    expect(result.passes[0]?.attachmentProfile.resolve).toBe("required");
  });

  it("maps straight-alpha blend without creating a resolve target", async () => {
    const fake = fakeDevice();
    const result = await new ShaderPackageExecutor(fake.device).prepare(
      packageValue([forward(true), normal()]),
    );
    const blended = fake.descriptors.find((value) => value.label?.includes("pbr/forward"))!;
    expect(blended.fragment?.targets[0]?.blend).toEqual({
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    });
    const normalDescriptor = fake.descriptors.find((value) => value.label?.includes("pbr/normal"))!;
    expect(normalDescriptor.vertex.buffers?.[2]).toEqual({
      arrayStride: 16, stepMode: "vertex",
      attributes: [{ shaderLocation: 11, offset: 0, format: "float32x4" }],
    });
    expect(fake.bindGroups).toHaveLength(2);
    expect(fake.bindGroups[1]?.entries.map((value) => value.binding)).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    expect(fake.pipelineLayouts[1]?.bindGroupLayouts).toHaveLength(2);
    expect(result.passes[0]).not.toHaveProperty("resolveTarget");
    expect(result.passes[0]?.resolveRequired).toBe(true);
  });

  it("commits cache atomically and reuses only successful pass cache keys", async () => {
    const fake = fakeDevice();
    fake.rejectOn(2);
    const executor = new ShaderPackageExecutor(fake.device);
    await expect(executor.prepare(packageValue())).rejects.toThrow("pipeline rejected");
    expect(executor.cacheSize).toBe(0);
    expect(fake.deviceMock.popErrorScope).toHaveBeenCalledOnce();
    fake.rejectOn(undefined);
    fake.deviceMock.popErrorScope.mockResolvedValueOnce({ message: "scope rejected" } as GPUError);
    await expect(executor.prepare(packageValue())).rejects.toThrow("scope rejected");
    expect(executor.cacheSize).toBe(0);
    await executor.prepare(packageValue());
    expect(executor.cacheSize).toBe(2);
    const calls = fake.deviceMock.createRenderPipelineAsync.mock.calls.length;
    await executor.prepare(packageValue());
    expect(fake.deviceMock.createRenderPipelineAsync).toHaveBeenCalledTimes(calls);
  });

  it("deduplicates identical concurrent package preparation", async () => {
    const fake = fakeDevice();
    const executor = new ShaderPackageExecutor(fake.device);
    const value = packageValue();
    const [first, second] = await Promise.all([executor.prepare(value), executor.prepare(value)]);
    expect(fake.deviceMock.createShaderModule).toHaveBeenCalledOnce();
    expect(fake.deviceMock.createRenderPipelineAsync).toHaveBeenCalledTimes(2);
    expect(first.passes[0]).toBe(second.passes[0]);
    expect(first.passes[1]).toBe(second.passes[1]);
    expect(executor.cacheSize).toBe(2);
  });

  it("serializes distinct device error scopes while allowing concurrent callers", async () => {
    const fake = fakeDevice();
    const executor = new ShaderPackageExecutor(fake.device);
    await Promise.all([
      executor.prepare(packageValue([forward()])),
      executor.prepare(packageValue([normal()])),
    ]);
    expect(fake.maximumActiveScopes()).toBe(1);
    expect(fake.deviceMock.pushErrorScope).toHaveBeenCalledTimes(2);
    expect(executor.cacheSize).toBe(2);
  });

  it("applies a global pass LRU after successful atomic batches", async () => {
    const fake = fakeDevice();
    const executor = new ShaderPackageExecutor(fake.device, { maxCachedPasses: 1 });
    const first = packageValue([forward()]);
    const second = packageValue([normal()]);
    await executor.prepare(first);
    expect(executor.cacheSize).toBe(1);
    await executor.prepare(second);
    expect(executor.cacheSize).toBe(1);
    const calls = fake.deviceMock.createRenderPipelineAsync.mock.calls.length;
    await executor.prepare(first);
    expect(fake.deviceMock.createRenderPipelineAsync).toHaveBeenCalledTimes(calls + 1);
    // WebGPU pipeline/module/layout objects expose no destroy(); eviction deliberately drops cache refs.

    const oversized = new ShaderPackageExecutor(fakeDevice().device, { maxCachedPasses: 1 });
    await expect(oversized.prepare(packageValue())).resolves.toHaveProperty("passes.length", 2);
    expect(oversized.cacheSize).toBe(0);
  });

  it("does not let lost-device compilation block a fresh device executor", async () => {
    const oldDevice = fakeDevice();
    const gate = deferred<GPURenderPipeline>();
    oldDevice.waitForPipeline(gate.promise);
    const oldExecutor = new ShaderPackageExecutor(oldDevice.device);
    const oldPrepare = oldExecutor.prepare(packageValue());
    await Promise.resolve(); await Promise.resolve();
    oldDevice.lost.resolve({ reason: "unknown", message: "reset" } as GPUDeviceLostInfo);
    await Promise.resolve(); await Promise.resolve();

    const freshDevice = fakeDevice();
    const freshExecutor = new ShaderPackageExecutor(freshDevice.device);
    await expect(freshExecutor.prepare(packageValue())).resolves.toMatchObject({
      passes: [{ id: "pbr/forward" }, { id: "pbr/shadow" }],
    });
    expect(freshExecutor.cacheSize).toBe(2);
    gate.resolve({} as GPURenderPipeline);
    await expect(oldPrepare).rejects.toThrow("invalidated");
    expect(oldExecutor.cacheSize).toBe(0);
  });

  it("rejects validation, compilation, and unknown passes before cache commit", async () => {
    const invalid: any = JSON.parse(JSON.stringify(packageValue()));
    invalid.passes[0].cacheKey = "f".repeat(64);
    const first = fakeDevice(), executor = new ShaderPackageExecutor(first.device);
    await expect(executor.prepare(invalid)).rejects.toBeInstanceOf(ShaderPackageExecutorError);
    expect(first.deviceMock.createShaderModule).not.toHaveBeenCalled();
    await expect(executor.prepare(packageValue(), ["pbr/missing"])).rejects.toThrow("Unknown");
    await expect(executor.prepare(packageValue(), [])).rejects.toThrow("At least one");
    expect(first.deviceMock.createShaderModule).not.toHaveBeenCalled();
    first.compilationFails();
    await expect(executor.prepare(packageValue())).rejects.toThrow("bad WGSL");
    expect(first.deviceMock.createRenderPipelineAsync).not.toHaveBeenCalled();
    expect(executor.cacheSize).toBe(0);
  });

  it("clears cache and permanently rejects reuse after device loss or disposal", async () => {
    const fake = fakeDevice(), executor = new ShaderPackageExecutor(fake.device);
    await executor.prepare(packageValue());
    expect(executor.cacheSize).toBe(2);
    executor.clear();
    expect(executor.cacheSize).toBe(0);
    await executor.prepare(packageValue());
    fake.lost.resolve({ reason: "unknown", message: "reset" } as GPUDeviceLostInfo);
    await Promise.resolve(); await Promise.resolve();
    expect(executor.state).toBe("lost");
    expect(executor.cacheSize).toBe(0);
    await expect(executor.prepare(packageValue())).rejects.toThrow("not ready");

    const other = new ShaderPackageExecutor(fakeDevice().device);
    other.dispose(); other.dispose();
    expect(other.state).toBe("disposed");
    await expect(other.prepare(packageValue())).rejects.toThrow("not ready");
  });
});
