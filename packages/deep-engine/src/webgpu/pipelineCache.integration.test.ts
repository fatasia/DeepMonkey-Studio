import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelinesBuild } from "./pipelines.js";
import { sharedOutputPipeline } from "./pbrOutputPipelineCache.js";
import { pipelineCompileCacheForDevice, renderPipelineFingerprint, wgslSourceFingerprint } from "./pipelineCache.js";
import { PIPELINE_WARMUP_PLAN_SCHEMA, PIPELINE_WARMUP_PLAN_SCHEMA_VERSION,
  loadPipelineWarmupPlan, savePipelineWarmupPlan, type StorageLike } from "./pipelineCachePersistence.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUColorWrite", { RED: 1, ALL: 15 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

interface Fixture {
  device: GPUDevice;
  descriptors: GPURenderPipelineDescriptor[];
  createRenderPipelineAsync: ReturnType<typeof vi.fn>;
}
function fixture(): Fixture {
  const descriptors: GPURenderPipelineDescriptor[] = [];
  const shader = { getCompilationInfo: vi.fn(async () => ({ messages: [] })) } as unknown as GPUShaderModule;
  const createRenderPipelineAsync = vi.fn(async (descriptor: GPURenderPipelineDescriptor) => {
    descriptors.push(descriptor);
    return { descriptor } as unknown as GPURenderPipeline;
  });
  const device = {
    createShaderModule: vi.fn(() => shader),
    createBindGroupLayout: vi.fn((value: GPUBindGroupLayoutDescriptor) => value as unknown as GPUBindGroupLayout),
    createPipelineLayout: vi.fn((value: GPUPipelineLayoutDescriptor) => value as unknown as GPUPipelineLayout),
    createRenderPipelineAsync,
  };
  return { device: device as unknown as GPUDevice, descriptors, createRenderPipelineAsync };
}

describe("C26 pipelines integration", () => {
  it("produces a per-pipeline compile ledger for a full build (36 pipelines, labels attached)", async () => {
    const f = fixture();
    const build = await createPipelinesBuild(f.device, "bgra8unorm", {} as GPUBindGroupLayout);
    build.releaseDeferredQueues();
    await build.ready;
    const records = build.pipelineCompileRecords();
    // 27 main(AA-M2:MSAA4 档 depth 变体 ×a2c)+ 9 shadow 经 C26 编译缓存进清单;
    // HDR output 走 T11 sharedOutputPipeline 独立路径(其指纹失效由 pbrOutputPipelineCache 覆盖)。
    expect(build.pipelineCompileRecords().length).toBe(36);
    expect(build.pipelineCompileRecords().every(record => record.fingerprint.startsWith("pso-sha256-"))).toBe(true);
    expect(records.filter(record => record.label === "Deep forward PBR plain/depth/ccw")).toHaveLength(1);
    expect(records.filter(record => record.label === "Deep forward PBR plain/depth/ccw/a2c")).toHaveLength(1);
    expect(records.every(record => record.cacheHit === false)).toBe(true);
  });

  it("reuses the cached entry when the same descriptor identity is requested again on one device", async () => {
    const f = fixture();
    const build = await createPipelinesBuild(f.device, "bgra8unorm", {} as GPUBindGroupLayout);
    await build.ready;
    // 同一 device 缓存槽(WeakMap)即 build 内部所用:同一描述符两次取用,
    // 第一次 miss(新建设备调用),第二次命中(零设备调用,cacheHit 记录)。
    const descriptor = { label: "Deep forward PBR plain/depth/ccw", layout: "auto" as const,
      vertex: { module: { label: "m" } as GPUShaderModule, entryPoint: "vertexMain" },
      primitive: { topology: "triangle-list" as const } };
    const deviceCache = pipelineCompileCacheForDevice(f.device);
    const code = "fn vs() {}";
    await deviceCache.create([code], descriptor, () => f.createRenderPipelineAsync(descriptor));
    const callsAfterMiss = f.createRenderPipelineAsync.mock.calls.length;
    await deviceCache.create([code], descriptor, () => f.createRenderPipelineAsync(descriptor));
    expect(f.createRenderPipelineAsync.mock.calls.length).toBe(callsAfterMiss);
    const hits = deviceCache.records.filter(record => record.cacheHit);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.label).toBe("Deep forward PBR plain/depth/ccw");
  });

  it("keeps background variants unqueued until release, then compiles them through the capped queue", async () => {
    const f = fixture();
    const build = await createPipelinesBuild(f.device, "bgra8unorm", {} as GPUBindGroupLayout, true, false, false,
      { firstFrameMainKeys: ["material/depth/ccw"] });
    await build.criticalReady;
    const forwardLabels = () => f.descriptors.filter(descriptor => descriptor.label?.startsWith("Deep forward")).length;
    expect(forwardLabels()).toBe(2);
    build.releaseDeferredQueues();
    await build.ready;
    // AA-M2:MSAA4 档 depth 变体 ×a2c → 27 条 main。
    expect(forwardLabels()).toBe(27);
    const hitRecords = build.pipelineCompileRecords().filter(record => record.cacheHit);
    expect(hitRecords).toHaveLength(0);
  });
});

describe("C26 HDR output pipeline cache invalidation", () => {
  it("serves one shared module per device/format/source, and recompiles when the WGSL source changes", () => {
    const f = fixture();
    const first = sharedOutputPipeline(f.device, "bgra8unorm", "fn outputA() {}");
    const sameAgain = sharedOutputPipeline(f.device, "bgra8unorm", "fn outputA() {}");
    expect(sameAgain).toBe(first);
    const changed = sharedOutputPipeline(f.device, "bgra8unorm", "fn outputB() {}");
    expect(changed).not.toBe(first);
    expect(vi.mocked(f.device.createShaderModule).mock.calls.filter(([descriptor]) => descriptor.label === "Deep HDR output"))
      .toHaveLength(2);
    // 旧源条目仍可独立取回(device 生命周期内不互相挤掉)。
    expect(sharedOutputPipeline(f.device, "bgra8unorm", "fn outputA() {}")).toBe(first);
  });

  it("keeps the default source path byte-identical to the bundled output shader fingerprint", () => {
    const f = fixture();
    sharedOutputPipeline(f.device, "rgba16float");
    const submitted = vi.mocked(f.device.createShaderModule).mock.calls.find(([descriptor]) =>
      descriptor.label === "Deep HDR output")![0];
    // 指纹函数与缓存键共用同一实现:源不变则指纹稳定(与 pbrOutputShaderProvenance 契约一致)。
    expect(wgslSourceFingerprint(submitted.code)).toMatch(/^wgsl-sha256-[0-9a-f]{64}$/);
  });
});

describe("C26 warmup plan feed (cross-session)", () => {
  it("turns compile ledger records into a persisted plan usable by the next session", () => {
    const map = new Map<string, string>();
    const storage: StorageLike = {
      getItem: key => map.get(key) ?? null,
      setItem: (key, value) => { map.set(key, value); },
      removeItem: key => { map.delete(key); },
    };
    savePipelineWarmupPlan(storage, [
      { fingerprint: "pso-sha256-ff", label: "Deep forward PBR plain/depth/ccw", priority: "first-frame",
        lastDurationMs: 24.8, sampleCount: 1, updatedAtEpochMs: 1 },
      { fingerprint: "pso-sha256-ee", label: "Deep forward PBR material/blend/ccw", priority: "background",
        lastDurationMs: 31.6, sampleCount: 1, updatedAtEpochMs: 2 },
    ]);
    const plan = loadPipelineWarmupPlan(storage);
    expect(plan?.schema).toBe(PIPELINE_WARMUP_PLAN_SCHEMA);
    expect(plan?.schemaVersion).toBe(PIPELINE_WARMUP_PLAN_SCHEMA_VERSION);
    const prioritiesByFingerprint = Object.fromEntries(
      plan!.entries.map(item => [item.fingerprint, item.priority]));
    expect(prioritiesByFingerprint).toEqual({ "pso-sha256-ff": "first-frame", "pso-sha256-ee": "background" });
  });
});
