import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProbeCaptureBeginContext, ProbeCaptureTransaction } from "../lighting/probeClipmapCaptureExecutor.js";
import { planIrradianceProbeClipmap, type ProbeClipmapPlan } from "../lighting/probeClipmapPlan.js";
import type { ProbeClipmapGpuResource } from "../lighting/probeClipmapResources.js";
import type { DeviceSession } from "./deviceSession.js";
import { WebGpuProbeCaptureAdapter } from "./webgpuProbeCaptureAdapter.js";
import type { WebGpuProbeCaptureSubmission, WebGpuProbeSamplingBinding } from "./webgpuProbeCaptureTypes.js";
import { WEBGPU_PROBE_CAPTURE_WGSL } from "./webgpuProbeCaptureWgsl.js";

interface FakeTexture extends GPUTexture {
  readonly descriptor: GPUTextureDescriptor;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly createView: ReturnType<typeof vi.fn>;
}
interface FakeBuffer extends GPUBuffer { readonly destroy: ReturnType<typeof vi.fn> }
interface PassRecord { readonly label: string; readonly dispatch: number[][] }
interface EncoderRecord { readonly passes: PassRecord[]; readonly copies: unknown[][] }

function fixture() {
  const owned = new Set<GPUTexture | GPUBuffer>(), textures: FakeTexture[] = [], buffers: FakeBuffer[] = [];
  const encoders: EncoderRecord[] = [];
  const lost = new Promise<GPUDeviceLostInfo>(() => {});
  const queue = { writeBuffer: vi.fn(), submit: vi.fn(), onSubmittedWorkDone: vi.fn(() => Promise.resolve()) };
  const device = {
    limits: { maxTextureDimension2D: 16_384, maxTextureArrayLayers: 256,
      maxComputeWorkgroupsPerDimension: 65_535 }, queue, lost,
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => ({ descriptor })),
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) => ({ label, entries })),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict;
      const texture = { width: size.width, height: size.height,
        depthOrArrayLayers: size.depthOrArrayLayers, mipLevelCount: descriptor.mipLevelCount ?? 1,
        sampleCount: 1, dimension: "2d", format: descriptor.format, usage: descriptor.usage, descriptor,
        destroy: vi.fn(), createView: vi.fn((view = {}) => ({ texture, view })) } as unknown as FakeTexture;
      textures.push(texture); return texture;
    }),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { size: descriptor.size, usage: descriptor.usage,
        destroy: vi.fn() } as unknown as FakeBuffer; buffers.push(buffer); return buffer;
    }),
    createCommandEncoder: vi.fn(() => {
      const record: EncoderRecord = { passes: [], copies: [] }; encoders.push(record);
      return {
        copyTextureToTexture: vi.fn((...args: unknown[]) => record.copies.push(args)),
        beginComputePass: vi.fn(({ label }: { label: string }) => {
          const pass: PassRecord = { label, dispatch: [] }; record.passes.push(pass);
          return { setPipeline: vi.fn(), setBindGroup: vi.fn(),
            dispatchWorkgroups: vi.fn((...args: number[]) => pass.dispatch.push(args)), end: vi.fn() };
        }),
        finish: vi.fn(() => ({ id: encoders.length })),
      };
    }),
  };
  const session = { state: "ready", device,
    own<T extends GPUTexture | GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUTexture | GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); },
  };
  return { session: session as unknown as DeviceSession, rawSession: session, device, queue,
    owned, textures, buffers, encoders };
}

function plan(previous?: ProbeClipmapPlan): ProbeClipmapPlan {
  return planIrradianceProbeClipmap({ cameraPosition: [0, 0, 0],
    sceneBounds: { min: [-100, -100, -100], max: [100, 100, 100] },
    ...(previous ? { previous: previous.history } : {}),
    options: { levelCount: 2, gridSize: [4, 2, 4], updateBudget: 4 } });
}
function context(source: ProbeClipmapPlan, invalidation: "initial" | "none" | "resize" = "initial"):
ProbeCaptureBeginContext {
  const buffer = {} as GPUBuffer;
  return { generation: 1, deviceEpoch: "gpu-1", plan: source, signal: new AbortController().signal,
    resource: { deviceEpoch: "gpu-1", profileKey: "probe-profile", plan: source,
      probeStorageBuffer: buffer, updateListBuffer: buffer, levelMetadataBuffer: buffer,
      allocatedBytes: source.profile.estimatedBytes } as ProbeClipmapGpuResource,
    publication: { frame: 0, schedulerGeneration: 1, frameBudget: 4,
      capacityBudget: 4, cameraCut: false, invalidation } };
}
async function execute(transaction: ProbeCaptureTransaction<WebGpuProbeCaptureSubmission, WebGpuProbeSamplingBinding>,
  adapter: WebGpuProbeCaptureAdapter, source: ProbeClipmapPlan): Promise<WebGpuProbeSamplingBinding> {
  source.updates.forEach((update, index) => transaction.encodeCapture(update, index));
  source.updates.forEach((update, index) => transaction.encodeFilter(update, index));
  source.updates.forEach((update, index) => transaction.encodeMips(update, index));
  const submission = transaction.finish(); await adapter.submit(submission, new AbortController().signal);
  return transaction.commit();
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2,
    COPY_SRC: 4, COPY_DST: 8, RENDER_ATTACHMENT: 16 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("concrete WebGPU probe capture adapter", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-probe-capture.wgsl", "--input-kind", "wgsl"],
      { input: WEBGPU_PROBE_CAPTURE_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("Validation successful");
  });

  it("creates a bounded 2D-array volume and submits clear, capture, filter and mip passes", async () => {
    const f = fixture(), source = plan(), adapter = new WebGpuProbeCaptureAdapter(f.session, "gpu-1",
      { fallbackRadiance: [0.8, 0.2, 0.1] });
    const beginContext = context(source);
    const binding = await execute(adapter.begin(beginContext), adapter, source);
    expect(f.device.createComputePipeline).toHaveBeenCalledTimes(5);
    expect(f.textures).toHaveLength(2);
    expect(f.textures[0]!.descriptor).toMatchObject({ size: { width: 4, height: 2, depthOrArrayLayers: 8 },
      mipLevelCount: 3, format: "rgba16float" });
    expect(f.encoders[0]!.passes.map(pass => pass.label)).toEqual([
      "Deep GI clear capture", "Deep GI clear irradiance", "Deep GI fallback capture",
      "Deep GI filter irradiance", "Deep GI build mip 1", "Deep GI build mip 2",
    ]);
    expect(f.encoders[0]!.passes.map(pass => pass.dispatch[0])).toEqual([
      [1, 1, 8], [1, 1, 8], [1], [1], [1, 1, 8], [1, 1, 8],
    ]);
    expect(f.queue.submit).toHaveBeenCalledOnce(); expect(f.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(binding).toMatchObject({ deviceEpoch: "gpu-1", width: 4, height: 2,
      depthOrArrayLayers: 8, mipLevelCount: 3, allocatedBytes: 704 });
    const captureEntries = f.device.createBindGroup.mock.calls[0]![0].entries;
    expect((captureEntries[0]!.resource as GPUBufferBinding).buffer).toBe(f.buffers[2]);
    expect((captureEntries[0]!.resource as GPUBufferBinding).buffer)
      .not.toBe(beginContext.resource.updateListBuffer);
    expect((f.queue.writeBuffer.mock.calls[1]![2] as Uint8Array).byteLength).toBe(256);
    expect(adapter.current).toBe(binding); expect(f.owned.size).toBe(5);
  });

  it("reuses ping-pong textures and uniform buffers after warmup", async () => {
    const f = fixture(), firstPlan = plan(), adapter = new WebGpuProbeCaptureAdapter(f.session, "gpu-1");
    await execute(adapter.begin(context(firstPlan)), adapter, firstPlan);
    const secondPlan = plan(firstPlan);
    await execute(adapter.begin(context(secondPlan, "none")), adapter, secondPlan);
    const thirdPlan = plan(secondPlan);
    await execute(adapter.begin(context(thirdPlan, "none")), adapter, thirdPlan);
    expect(f.device.createTexture).toHaveBeenCalledTimes(3);
    expect(f.device.createBuffer).toHaveBeenCalledTimes(4);
    expect(f.encoders[1]!.copies).toHaveLength(1); expect(f.encoders[2]!.copies).toHaveLength(1);
    expect(f.encoders[1]!.passes.map(pass => pass.label)).not.toContain("Deep GI clear irradiance");
  });

  it("does not recycle a cancelled submission until its GPU work retires", async () => {
    const f = fixture(), source = plan(), adapter = new WebGpuProbeCaptureAdapter(f.session, "gpu-1");
    let retireGpu!: () => void;
    f.queue.onSubmittedWorkDone.mockReturnValue(new Promise<void>(resolve => { retireGpu = resolve; }));
    const transaction = adapter.begin(context(source));
    source.updates.forEach((update, index) => transaction.encodeCapture(update, index));
    source.updates.forEach((update, index) => transaction.encodeFilter(update, index));
    source.updates.forEach((update, index) => transaction.encodeMips(update, index));
    const controller = new AbortController(), submitted = adapter.submit(transaction.finish(), controller.signal);
    controller.abort(); transaction.rollback(controller.signal.reason);
    expect(f.textures.slice(0, 2).every(texture => texture.destroy.mock.calls.length === 0)).toBe(true);
    const next = adapter.begin(context(plan(source), "none"));
    expect(f.device.createTexture).toHaveBeenCalledTimes(4); next.rollback(new Error("cancelled"));
    retireGpu(); await expect(submitted).rejects.toMatchObject({ name: "AbortError" });
    adapter.dispose();
    expect(f.owned.size).toBe(0);
    expect(f.textures.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true);
    expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });

  it("injects source radiance without a fallback pass and clears history after resize", async () => {
    const f = fixture(), captures: Array<[number, number, number]> = [], firstPlan = plan();
    const adapter = new WebGpuProbeCaptureAdapter(f.session, "gpu-1", { encodeSourceRadiance: input => {
      captures.push([input.destinationOrigin.x, input.destinationOrigin.y, input.destinationOrigin.z]);
    } });
    await execute(adapter.begin(context(firstPlan)), adapter, firstPlan);
    const resized = plan(firstPlan);
    await execute(adapter.begin(context(resized, "resize")), adapter, resized);
    expect(captures).toHaveLength(8);
    expect(f.encoders.flatMap(value => value.passes.map(pass => pass.label)))
      .not.toContain("Deep GI fallback capture");
    expect(f.encoders[1]!.copies).toHaveLength(0);
    expect(f.encoders[1]!.passes.map(pass => pass.label)).toContain("Deep GI clear irradiance");
  });

  it("fails closed on device limits and transient memory before allocation", () => {
    const limited = fixture(), source = plan(); limited.device.limits.maxTextureArrayLayers = 7;
    const adapter = new WebGpuProbeCaptureAdapter(limited.session, "gpu-1");
    expect(() => adapter.begin(context(source))).toThrow("exceeds WebGPU limits");
    expect(limited.device.createTexture).not.toHaveBeenCalled();
    const memory = fixture(), constrained = new WebGpuProbeCaptureAdapter(memory.session, "gpu-1",
      { maxTransientBytes: 1_000 });
    expect(() => constrained.begin(context(source))).toThrow("transient budget");
    expect(() => new WebGpuProbeCaptureAdapter(memory.session, "gpu-1",
      { fallbackRadiance: [Number.NaN, 0, 0] })).toThrow("fallbackRadiance");
  });

  it("rolls back all staging resources after device loss and disposes committed pools exactly once", async () => {
    const lost = fixture(), source = plan(), pendingAdapter = new WebGpuProbeCaptureAdapter(lost.session, "gpu-1");
    const transaction = pendingAdapter.begin(context(source));
    source.updates.forEach((update, index) => transaction.encodeCapture(update, index));
    lost.rawSession.state = "lost"; transaction.rollback(new Error("lost"));
    expect(lost.owned.size).toBe(0); expect(lost.textures.every(texture =>
      texture.destroy.mock.calls.length === 1)).toBe(true);
    expect(pendingAdapter.current).toBeUndefined(); pendingAdapter.dispose(); pendingAdapter.dispose();

    const ready = fixture(), adapter = new WebGpuProbeCaptureAdapter(ready.session, "gpu-1");
    await execute(adapter.begin(context(source)), adapter, source); adapter.dispose(); adapter.dispose();
    expect(ready.owned.size).toBe(0);
    expect(ready.textures.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true);
    expect(ready.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(() => adapter.begin(context(source))).toThrow("disposed");
  });
});
