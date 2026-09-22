import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { compilePbrFrameGraph } from "./pbrFrameGraph.js";
import { DEFAULT_PBR_RENDERER_FEATURES, resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import { sceneShader } from "./pbrShader.js";
import { MAX_VISIBILITY_SLOTS, VisibilityBufferPath } from "./visibilityBufferPass.js";
import { SoftRasterizeFallback, packSoftRasterTriangles, type SoftRasterFallbackFrameInput } from "./softRasterizeFallback.js";
import { VISIBILITY_BLIT_WGSL, VISIBILITY_RESOLVE_WGSL, VISIBILITY_RASTER_WGSL } from "./visibilityBufferWgsl.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, STORAGE: 128, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 8 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("visibility buffer opt-in contract", () => {
  it("defaults to off and keeps the default feature set frozen", () => {
    expect(DEFAULT_PBR_RENDERER_FEATURES.visibilityBuffer).toBe(false);
    expect(resolvePbrRendererFeatures().visibilityBuffer).toBe(false);
    expect(resolvePbrRendererFeatures({}).visibilityBuffer).toBe(false);
  });

  it("honors an explicit opt-in and rejects non-boolean values", () => {
    expect(resolvePbrRendererFeatures({ visibilityBuffer: true }).visibilityBuffer).toBe(true);
    expect(() => resolvePbrRendererFeatures({ visibilityBuffer: "yes" as unknown as boolean })).toThrow(TypeError);
  });

  it("keeps the forward shader byte-identical: no visibility entries leak into the shared scene module", () => {
    for (const marker of ["vertexVisibility", "fragmentVisibilityResolve", "fragmentBlit",
      "isVisibilityCovered", "VisibilityMaterialSlot", "visibilityMap"]) {
      expect(sceneShader.includes(marker)).toBe(false);
    }
    // 可见性 WGSL 是独立模块：正向声明自己的入口，反向不依赖 sceneShader 内部符号。
    expect(VISIBILITY_RASTER_WGSL).toContain("fn vertexVisibility");
    expect(VISIBILITY_RASTER_WGSL).toContain("fn fragmentVisibility");
    expect(VISIBILITY_RESOLVE_WGSL).toContain("fn fragmentVisibilityResolve");
    expect(VISIBILITY_BLIT_WGSL).toContain("fn fragmentBlit");
    // WGSL 模块作用域先声明后使用：safeNormalize 必须先于 brdf 库嵌入。
    expect(VISIBILITY_RESOLVE_WGSL.indexOf("fn safeNormalize"))
      .toBeLessThan(VISIBILITY_RESOLVE_WGSL.indexOf("fn brdf"));
    // interpolate 属性只允许出现在顶点输出/片元输入；顶点输入上的 carrier 必须裸声明。
    expect(VISIBILITY_RASTER_WGSL).toMatch(/@location\(5\) carrier: u32,/);
  });

  it("changes nothing in the transient allocation plan when the feature is off", () => {
    const features = resolvePbrRendererFeatures();
    const plan = compilePbrFrameGraph({ transparency: false, features, writeGeometryBuffers: true });
    expect(plan.valid).toBe(true);
    // 编译入参里根本没有可见性资源：图计划对 opt-in 特性零感知（类型层隔离）。
    expect(JSON.stringify(plan.resources ?? [])).not.toContain("visibility");
  });

  it("skips composition entirely until pipelines are ready, without touching the device", () => {
    const device = { createShaderModule: vi.fn(() => { throw new Error("no device in this frame"); }) };
    const session = { state: "ready", device } as unknown as DeviceSession;
    const pool = { acquire: vi.fn(), release: vi.fn() };
    const path = new VisibilityBufferPath(session, pool as never, {} as GPUBuffer);
    expect(path.encodeComposite({} as GPUCommandEncoder, {
      hdrView: {} as GPUTextureView, depthView: {} as GPUTextureView, width: 8, height: 8,
      frameData: new Float32Array(96), inputs: { batches: new Map(), geometries: new Map(), lod: undefined, deformationActive: false },
    })).toBeUndefined();
    expect(pool.acquire).not.toHaveBeenCalled();
    expect(path.failureReason).toBeUndefined();
  });

  it("reports zero slots when deformation owns the frame", async () => {
    const descriptors: unknown[] = [];
    const shader = { getCompilationInfo: vi.fn(async () => ({ messages: [] })) };
    const device = {
      limits: { minUniformBufferOffsetAlignment: 256 },
      createShaderModule: vi.fn(() => shader),
      createBindGroupLayout: vi.fn((descriptor: unknown) => descriptor),
      createPipelineLayout: vi.fn((descriptor: unknown) => descriptor),
      createBuffer: vi.fn((descriptor: { label: string }) => ({ label: descriptor.label })),
      createBindGroup: vi.fn((descriptor: unknown) => descriptor),
      createRenderPipelineAsync: vi.fn(async (descriptor: unknown) => { descriptors.push(descriptor); return descriptor; }),
    };
    const session = { state: "ready", device,
      own: (value: unknown) => value, release: vi.fn() } as unknown as DeviceSession;
    const pool = { acquire: vi.fn(), release: vi.fn() };
    const path = new VisibilityBufferPath(session, pool as never, {} as GPUBuffer);
    await path.ensure();
    expect(path.failureReason).toBeUndefined();
    expect(descriptors).toHaveLength(5);
    const stats = path.encodeComposite({ beginRenderPass: vi.fn() } as unknown as GPUCommandEncoder, {
      hdrView: {} as GPUTextureView, depthView: {} as GPUTextureView, width: 8, height: 8,
      frameData: new Float32Array(96), inputs: { batches: new Map(), geometries: new Map(), lod: undefined, deformationActive: true },
    });
    expect(stats).toEqual({ slotCount: 0, drawCalls: 0, skippedDraws: 0 });
    expect(MAX_VISIBILITY_SLOTS).toBeLessThanOrEqual(256);
  });

  it("records pipeline failures as a reason and keeps the frame loop alive", async () => {
    const device = {
      limits: { minUniformBufferOffsetAlignment: 256 },
      createShaderModule: vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [
        { type: "error", lineNum: 7, message: "synthetic compile error" }] }) })),
    };
    const session = { state: "ready", device, own: vi.fn(), release: vi.fn() } as unknown as DeviceSession;
    const path = new VisibilityBufferPath(session, { acquire: vi.fn(), release: vi.fn() } as never, {} as GPUBuffer);
    await path.ensure();
    expect(path.failureReason).toContain("synthetic compile error");
    expect(path.encodeComposite({} as GPUCommandEncoder, {
      hdrView: {} as GPUTextureView, depthView: {} as GPUTextureView, width: 8, height: 8,
      frameData: new Float32Array(96), inputs: { batches: new Map(), geometries: new Map(), lod: undefined, deformationActive: false },
    })).toBeUndefined();
  });
});

describe("soft-rasterize fallback integration contract", () => {
  const baseRequest = (softRaster?: SoftRasterFallbackFrameInput) => {
    const frameData = new Float32Array(96);
    frameData[0] = 1; frameData[5] = 1; frameData[10] = 1; frameData[15] = 1; // 可逆 view-projection。
    return {
      hdrView: {} as GPUTextureView, depthView: {} as GPUTextureView, width: 8, height: 8,
      frameData, softRaster,
      inputs: { batches: new Map(), geometries: new Map(), lod: undefined, deformationActive: false },
    };
  };

  function makeReadyHarness() {
    const created: unknown[] = [];
    const shader = { getCompilationInfo: vi.fn(async () => ({ messages: [] })) };
    const device = {
      limits: { minUniformBufferOffsetAlignment: 256 },
      createShaderModule: vi.fn(() => shader),
      createBindGroupLayout: vi.fn((d: unknown) => d),
      createPipelineLayout: vi.fn((d: unknown) => d),
      createBuffer: vi.fn((d: { label: string }) => ({ label: d.label })),
      createBindGroup: vi.fn((d: unknown) => d),
      createComputePipelineAsync: vi.fn(async (d: { label: string }) => ({ label: d.label, getBindGroupLayout: vi.fn(() => ({})) })),
      createRenderPipelineAsync: vi.fn(async (d: object) => {
        const descriptor = { ...d } as Record<string, unknown>;
        created.push(descriptor);
        return { ...descriptor, label: descriptor.label as string, getBindGroupLayout: vi.fn(() => ({})) };
      }),
      queue: { writeBuffer: vi.fn() },
    };
    const session = { state: "ready", device,
      own: (value: unknown) => value, release: vi.fn() } as unknown as DeviceSession;
    const view = { view: { label: "transient" } };
    const pool = { acquire: vi.fn(() => view), release: vi.fn() };
    return { session, device, created, pool };
  }

  function makeRecordingEncoder() {
    const events: string[] = [];
    const makePass = (kind: string, label: string) => ({
      setPipeline: vi.fn((p: { label: string }) => events.push(`${kind} ${label} pipeline=${p.label}`)),
      setBindGroup: vi.fn(() => events.push(`${kind} ${label} bindGroup`)),
      dispatchWorkgroups: vi.fn((x: number) => events.push(`${kind} ${label} dispatch=${x}`)),
      draw: vi.fn(() => events.push(`${kind} ${label} draw`)),
      end: vi.fn(() => events.push(`${kind} ${label} end`)),
    });
    return {
      events,
      beginRenderPass: vi.fn((d: { label: string }) => makePass("render", d.label)),
      beginComputePass: vi.fn((d: { label: string }) => makePass("compute", d.label)),
    } as unknown as GPUCommandEncoder & { events: string[] };
  }

  const stubFallback = (encodeRaster: ReturnType<typeof vi.fn>) => ({
    ensure: vi.fn(async () => undefined), failureReason: undefined,
    resolvePipeline: { label: "Deep visibility resolve fallback", getBindGroupLayout: vi.fn(() => ({})) },
    resolveEntries: vi.fn(() => [{ binding: 3, resource: { buffer: {} } },
      { binding: 4, resource: { buffer: {} } }, { binding: 5, resource: { buffer: {} } }]),
    encodeRaster, dispose: vi.fn(),
  }) as unknown as SoftRasterizeFallback;

  it("keeps the encoded frame byte-identical when the fallback is absent or has no input", async () => {
    for (const softRasterize of [undefined, stubFallback(vi.fn())]) {
      const { session, pool } = makeReadyHarness();
      const path = new VisibilityBufferPath(session, pool as never, {} as GPUBuffer, softRasterize);
      await path.ensure();
      const encoder = makeRecordingEncoder();
      expect(path.encodeComposite(encoder, baseRequest())).toEqual({ slotCount: 0, drawCalls: 0, skippedDraws: 0 });
      // 合同：无后备输入帧零 compute pass；硬件零 slot 时维持既有的单段提前返回行为。
      expect(encoder.events.filter(event => event.startsWith("compute"))).toEqual([]);
      expect(encoder.events).toEqual(["render Deep visibility raster end"]);
    }
  });

  it("inserts the soft-raster compute pass before material resolve and switches the resolve variant", async () => {
    const { session, device, pool } = makeReadyHarness();
    const slotRows = new Float32Array(2 * 16).fill(0.25);
    const path = new VisibilityBufferPath(session, pool as never, {} as GPUBuffer, new SoftRasterizeFallback(session));
    await path.ensure();
    const encoder = makeRecordingEncoder();
    const stats = path.encodeComposite(encoder, baseRequest(
      { triangles: packSoftRasterTriangles([
          { ax: 1, ay: 1, az: 0.5, bx: 8, by: 1, bz: 0.5, cx: 4, cy: 8, cz: 0.5, triangleLocalIndex: 3 },
          { ax: 2, ay: 2, az: 0.75, bx: 8, by: 2, bz: 0.75, cx: 5, cy: 8, cz: 0.75, triangleLocalIndex: 4 }]),
        triangleCount: 2, slotRows }));
    expect(stats).toEqual({ slotCount: 2, drawCalls: 0, skippedDraws: 0, fallbackTriangles: 2 });
    const sequence = encoder.events;
    expect(sequence.filter(event => event.startsWith("compute"))).toEqual([
      "compute Deep visibility soft rasterize fallback pipeline=Deep soft rasterize depth-min",
      "compute Deep visibility soft rasterize fallback bindGroup",
      "compute Deep visibility soft rasterize fallback dispatch=1",
      "compute Deep visibility soft rasterize fallback pipeline=Deep soft rasterize write",
      "compute Deep visibility soft rasterize fallback dispatch=1",
      "compute Deep visibility soft rasterize fallback end"]);
    const rasterEnd = sequence.indexOf("render Deep visibility raster end");
    const computeStart = sequence.findIndex(event => event.startsWith("compute"));
    const resolveStart = sequence.indexOf("render Deep visibility resolve pipeline=Deep visibility resolve fallback");
    // 合同：软光栅 pass 严格位于硬件光栅之后、材质还原之前。
    expect(rasterEnd).toBeGreaterThanOrEqual(0);
    expect(computeStart).toBeGreaterThan(rasterEnd);
    expect(resolveStart).toBeGreaterThan(sequence.indexOf("compute Deep visibility soft rasterize fallback end"));
    // 后备 slot 的材质表行合并进唯一上传；禁止后续零表覆盖后备材质。
    const tableWrites = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls
      .filter(([buffer]) => (buffer as { label?: string }).label === "Deep visibility material table");
    expect(tableWrites).toHaveLength(1);
    const uploaded = tableWrites[0]![2] as Float32Array;
    expect(tableWrites[0]!.slice(0, 2)).toEqual([
      expect.objectContaining({ label: "Deep visibility material table" }), 0]);
    expect(tableWrites[0]!.slice(3)).toEqual([0, 32]);
    expect(Array.from(uploaded.subarray(0, 32))).toEqual(Array.from(slotRows));
  });

  it("stays on the main resolve variant and skips the table append when the fallback declines", async () => {
    const { session, device, pool } = makeReadyHarness();
    const path = new VisibilityBufferPath(session, pool as never, {} as GPUBuffer,
      stubFallback(vi.fn(() => undefined)));
    await path.ensure();
    const encoder = makeRecordingEncoder();
    expect(path.encodeComposite(encoder, baseRequest(
      { triangles: new Float32Array(10), triangleCount: 1, slotRows: new Float32Array(16) })))
      .toEqual({ slotCount: 0, drawCalls: 0, skippedDraws: 0 });
    expect(encoder.events.filter(event => event.startsWith("compute"))).toEqual([]);
    expect(encoder.events).not.toContain("render Deep visibility resolve pipeline=Deep visibility resolve fallback");
    expect(device.queue.writeBuffer).not.toHaveBeenCalled();
  });

  it("refuses fallback triangles beyond the slot table capacity", async () => {
    const { session, pool } = makeReadyHarness();
    const encodeRaster = vi.fn(() => 1);
    const path = new VisibilityBufferPath(session, pool as never, {} as GPUBuffer, stubFallback(encodeRaster));
    await path.ensure();
    const encoder = makeRecordingEncoder();
    const count = MAX_VISIBILITY_SLOTS + 1;
    expect(path.encodeComposite(encoder, baseRequest(
      { triangles: new Float32Array(count * 10), triangleCount: count, slotRows: new Float32Array(count * 16) })))
      .toEqual({ slotCount: 0, drawCalls: 0, skippedDraws: 0 });
    expect(encodeRaster).not.toHaveBeenCalled();
    expect(MAX_VISIBILITY_SLOTS).toBeLessThanOrEqual(256);
  });

  it("propagates disposal to the fallback executor", async () => {
    const { session, pool } = makeReadyHarness();
    const dispose = vi.fn();
    const fallback = stubFallback(vi.fn());
    (fallback as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose = dispose;
    const path = new VisibilityBufferPath(session, pool as never, {} as GPUBuffer, fallback);
    await path.ensure();
    path.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
