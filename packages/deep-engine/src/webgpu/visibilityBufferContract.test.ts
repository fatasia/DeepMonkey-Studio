import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { compilePbrFrameGraph } from "./pbrFrameGraph.js";
import { DEFAULT_PBR_RENDERER_FEATURES, resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import { sceneShader } from "./pbrShader.js";
import { MAX_VISIBILITY_SLOTS, VisibilityBufferPath } from "./visibilityBufferPass.js";
import { VISIBILITY_BLIT_WGSL, VISIBILITY_RESOLVE_WGSL, VISIBILITY_RASTER_WGSL } from "./visibilityBufferWgsl.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, STORAGE: 128, COPY_DST: 8 });
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
