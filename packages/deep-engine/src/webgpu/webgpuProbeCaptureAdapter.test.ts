// WebGPU probe capture adapter 测试(sourceSizeGate 拆分:夹具/计划/上下文/事务辅助
// 移至 webgpuProbeCaptureAdapter.testUtils.ts,代码逐行同源;describe/it 名零变化,
// 语义零变化——外部证据按测试名引用不受影响)。
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEBGPU_PROBE_CAPTURE_WGSL } from "./webgpuProbeCaptureWgsl.js";
import { PROBE_MOMENTS_WGSL } from "./webgpuProbeMoments.js";
import { WebGpuProbeCaptureAdapter } from "./webgpuProbeCaptureAdapter.js";
import { context, execute, fixture, plan } from "./webgpuProbeCaptureAdapter.testUtils.js";

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

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates same-generation moment publication with Naga", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-moment-publication.wgsl", "--input-kind", "wgsl"],
      { input: PROBE_MOMENTS_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("commits moments and radiance together, preserving 96-byte record lanes and reusing volumes", async () => {
    const f = fixture(), contexts: unknown[] = [], source = plan();
    const adapter = new WebGpuProbeCaptureAdapter(f.session, "gpu-1", {
      captureVisibilityMoments: true, encodeSourceRadiance: input => contexts.push(input),
    });
    const first = await execute(adapter.begin(context(source)), adapter, source);
    expect(first.momentsView).toBeDefined();
    expect(f.textures.filter(texture => texture.format === "rgba32float")).toHaveLength(2);
    expect(contexts).toHaveLength(source.updates.length);
    expect(contexts.every(input => (input as { momentsDestinationView?: unknown }).momentsDestinationView)).toBe(true);
    expect(f.encoders[0]!.passes.map(p => p.label)).toContain("Deep GI publish moments");
    expect(PROBE_MOMENTS_WGSL).toContain("records[recordIndex].visibility = vec4f(moment.xyz, 0.0)");
    expect(PROBE_MOMENTS_WGSL).not.toContain("records[recordIndex].relocation =");
    const secondSource = plan(source);
    const second = await execute(adapter.begin(context(secondSource, "none")), adapter, secondSource);
    expect(second.momentsView).not.toBe(first.momentsView);
    expect(f.encoders[1]!.copies).toHaveLength(2);
    const thirdSource = plan(secondSource);
    await execute(adapter.begin(context(thirdSource, "none")), adapter, thirdSource);
    expect(f.textures.filter(texture => texture.format === "rgba32float")).toHaveLength(3);
    adapter.dispose(); expect(f.owned.size).toBe(0);
    expect(f.textures.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true);
  });

  it("keeps old visible moments during rollback and rejects moment fallback without a real encoder", async () => {
    const f = fixture(), source = plan();
    expect(() => new WebGpuProbeCaptureAdapter(f.session, "gpu-1", { captureVisibilityMoments: true }))
      .toThrow("real scene radiance encoder");
    const adapter = new WebGpuProbeCaptureAdapter(f.session, "gpu-1", {
      captureVisibilityMoments: true, encodeSourceRadiance: () => {},
    });
    const first = await execute(adapter.begin(context(source)), adapter, source);
    const next = adapter.begin(context(plan(source), "none"));
    next.rollback(new Error("cancelled"));
    expect(adapter.current).toBe(first); expect(adapter.current!.momentsView).toBe(first.momentsView);
    adapter.dispose(); expect(f.owned.size).toBe(0);
  });

  it("fails moment transient limits before allocation and clears moments across grid shifts", async () => {
    const f = fixture(), source = plan();
    const constrained = new WebGpuProbeCaptureAdapter(f.session, "gpu-1", {
      maxTransientBytes: 2200, captureVisibilityMoments: true, encodeSourceRadiance: () => {},
    });
    expect(() => constrained.begin(context(source))).toThrow("transient budget");
    expect(f.textures).toHaveLength(0);
    const adapter = new WebGpuProbeCaptureAdapter(f.session, "gpu-1", {
      captureVisibilityMoments: true, encodeSourceRadiance: () => {},
    });
    await execute(adapter.begin(context(source)), adapter, source);
    const nextSource = plan(source);
    const shifted = { ...nextSource, levels: nextSource.levels.map(level => ({ ...level,
      originCell: [level.originCell[0] + 1, level.originCell[1], level.originCell[2]] as const,
      origin: [level.origin[0] + level.spacing, level.origin[1], level.origin[2]] as const,
      max: [level.max[0] + level.spacing, level.max[1], level.max[2]] as const })) };
    await execute(adapter.begin(context(shifted, "none")), adapter, shifted);
    expect(f.encoders[1]!.copies).toHaveLength(0);
    expect(f.encoders[1]!.passes.filter(p => p.label === "Deep GI clear moments")).toHaveLength(2);
    adapter.dispose(); constrained.dispose();
  });

  it.each(["cancel", "device-loss"])("retires real-moment transactions safely after %s", async mode => {
    const f = fixture(), source = plan();
    const adapter = new WebGpuProbeCaptureAdapter(f.session, "gpu-1", {
      captureVisibilityMoments: true, encodeSourceRadiance: () => {},
    });
    await execute(adapter.begin(context(source)), adapter, source);
    let retire!: () => void;
    f.queue.onSubmittedWorkDone.mockReturnValue(new Promise<void>(resolve => { retire = resolve; }));
    const nextSource = plan(source), transaction = adapter.begin(context(nextSource, "none"));
    nextSource.updates.forEach((u,i) => { transaction.encodeCapture(u,i);transaction.encodeFilter(u,i);transaction.encodeMips(u,i); });
    const controller = new AbortController();
    const submitted = adapter.submit(transaction.finish(), controller.signal);
    controller.abort(); transaction.rollback(controller.signal.reason);
    if (mode === "device-loss") { f.rawSession.state = "lost"; adapter.dispose(); }
    retire(); await expect(submitted).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve(); adapter.dispose(); await Promise.resolve();
    expect(f.owned.size).toBe(0);
    expect(f.textures.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true);
    expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
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

  it("temporally blends only dynamic updates against the last committed GPU volume", async () => {
    const f = fixture(), firstPlan = plan();
    const adapter = new WebGpuProbeCaptureAdapter(f.session, "gpu-1",
      { dynamicIrradianceHysteresis: 0.75 });
    const first = await execute(adapter.begin(context(firstPlan)), adapter, firstPlan);
    const secondPlan = plan(firstPlan), secondContext = context(secondPlan, "none", [0, 2]);
    await execute(adapter.begin(secondContext), adapter, secondPlan);

    const uniform = f.queue.writeBuffer.mock.calls[3]![2] as ArrayBuffer;
    expect(new Float32Array(uniform)[3]).toBe(0.75);
    const packed = new Uint32Array(f.queue.writeBuffer.mock.calls[5]![2] as ArrayBuffer);
    expect(packed[0]! >>> 31).toBe(1); expect(packed[4]! >>> 31).toBe(0);
    expect(packed[8]! >>> 31).toBe(1);
    const filter = f.device.createBindGroup.mock.calls.map(call => call[0])
      .findLast(call => call.label === "Deep GI filter bindings");
    const history = filter.entries.find((entry: GPUBindGroupEntry) => entry.binding === 7)!.resource as {
      texture: GPUTexture;
    };
    expect(history.texture).toBe(first.texture);
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
    expect(() => new WebGpuProbeCaptureAdapter(memory.session, "gpu-1",
      { dynamicIrradianceHysteresis: 1 })).toThrow("dynamicIrradianceHysteresis");
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

  it("carries the energy clamp and static hysteresis in the extended uniform (F1 slice-3)", async () => {
    const f = fixture();
    const adapter = new WebGpuProbeCaptureAdapter(f.session, "gpu-1",
      { energyClamp: 0.25, staticIrradianceHysteresis: 0.5 });
    // First commit has no history, so both hysteresis weights are (correctly) zeroed;
    // the "none" publication keeps the committed volume and enables the weights.
    const firstPlan = plan();
    await execute(adapter.begin(context(firstPlan)), adapter, firstPlan);
    const secondPlan = plan(firstPlan);
    await execute(adapter.begin(context(secondPlan, "none")), adapter, secondPlan);
    const uniformCalls = f.queue.writeBuffer.mock.calls
      .filter((call: unknown[]) => (call[2] as ArrayBuffer)?.byteLength === 48);
    expect(uniformCalls.length).toBe(2);
    expect(new Float32Array(uniformCalls[0]![2] as ArrayBuffer)[8]).toBe(0.25);
    expect(new Float32Array(uniformCalls[0]![2] as ArrayBuffer)[9]).toBe(0);
    expect(new Float32Array(uniformCalls[1]![2] as ArrayBuffer)[8]).toBe(0.25);
    expect(new Float32Array(uniformCalls[1]![2] as ArrayBuffer)[9]).toBe(0.5);
  });

  it("keeps clamp and static hysteresis zero by default and validates fail-fast", async () => {
    const f = fixture();
    expect(() => new WebGpuProbeCaptureAdapter(f.session, "gpu-1", { energyClamp: -1 }))
      .toThrow(/energyClamp/);
    expect(() => new WebGpuProbeCaptureAdapter(f.session, "gpu-1", { staticIrradianceHysteresis: 1 }))
      .toThrow(/in \[0, 1\)/);
    const adapter = new WebGpuProbeCaptureAdapter(f.session, "gpu-1");
    const source = plan();
    await execute(adapter.begin(context(source)), adapter, source);
    const uniformCall = f.queue.writeBuffer.mock.calls
      .find((call: unknown[]) => (call[2] as ArrayBuffer).byteLength === 48)!;
    const floats = new Float32Array(uniformCall[2] as ArrayBuffer);
    expect(floats[8]).toBe(0);
    expect(floats[9]).toBe(0);
  });
});
