import { describe, expect, it, vi, afterEach } from "vitest";
import { RayTraceClosestFramePass, RAY_TRACE_CLOSEST_FRAME_FORMAT } from "./rayTraceClosestFramePass.js";
import { RAY_TRACE_CLOSEST_FRAME_PARAMS_BYTES } from "./rayTraceClosestFrameKernel.js";
import type { TlasPackedScene } from "./tlasLayout.js";

/**
 * 反射 closest-hit 帧执行器合同(2026-10-05,B3 光追双通道切片):
 * 与 ShadowRayFramePass 同族(场景五缓冲持久、增量 TLAS、bind LRU 4、哨兵 COPY_SRC、
 * f16 fail-closed),差异面(rgba32float 命中纹理、112B uniform、eye/bias 参数)逐项钉死。
 * GPU 侧 mock 同 rtShadowFrame.test 惯例;真机 dispatch 语义由
 * scripts/reflectionRayGpuTest.mjs 覆盖(hit==CPU traceTlasClosest 镜像)。
 */

function deviceStub(f16 = false) {
  const buffers: Array<{ label?: string; size: number; usage: number; destroy: ReturnType<typeof vi.fn> }> = [];
  const bindGroups: Array<{ entries: Array<{ binding: number; resource: unknown }> }> = [];
  let validationError: GPUError | null = null;
  const device = {
    features: new Set<string>(f16 ? ["shader-f16"] : []),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => validationError),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
    createTexture: vi.fn(),
    createBuffer: vi.fn((descriptor: { size: number; usage: number }) => {
      const buffer = { size: descriptor.size, usage: descriptor.usage, destroy: vi.fn() };
      buffers.push(buffer); return buffer;
    }),
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
    createBindGroup: vi.fn((descriptor: { entries: Array<{ binding: number; resource: unknown }> }) => {
      const group = { entries: descriptor.entries }; bindGroups.push(group); return group;
    }),
    failNextValidation(message: string) {
      validationError = { message } as GPUError;
    },
  };
  return { device: device as unknown as GPUDevice & { failNextValidation(message: string): void }, buffers, bindGroups };
}

function packedScene(blasNodes = 4, triangles = 2): TlasPackedScene {
  return { instanceCount: 1, tlasNodeCount: 1, blasNodeCount: blasNodes, triangleCount: triangles,
    recordBytes: new ArrayBuffer(128), nodeBytes: new ArrayBuffer(48 * (1 + blasNodes)),
    vertices: new Float32Array(9), indices: new Uint32Array(3), order: new Uint32Array(1),
    placements: Object.freeze([]) } as unknown as TlasPackedScene;
}

const INV: readonly [number, number, number, number, number, number, number, number, number, number,
  number, number, number, number, number, number] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function encoderStub() {
  const passes: Array<{ dispatches: Array<[number, number, number]> }> = [];
  const encoder = {
    beginComputePass: vi.fn(() => {
      const record = { dispatches: [] as Array<[number, number, number]> };
      passes.push(record);
      return { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn((x: number, y: number, z: number) => {
        record.dispatches.push([x, y, z]);
      }), end: vi.fn() };
    }),
    copyBufferToBuffer: vi.fn(),
  };
  return { encoder: encoder as unknown as GPUCommandEncoder, passes };
}

function hitView(): GPUTextureView {
  return { __hitView: true } as unknown as GPUTextureView;
}

function depthView(): GPUTextureView {
  return { __depthView: true } as unknown as GPUTextureView;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("reflection closest-hit frame pass", () => {
  it("stages five persistent scene buffers + sentinel + uniform; sentinel keeps COPY_SRC", () => {
    const { device, buffers } = deviceStub();
    const packed = packedScene(6, 4);
    const pass = new RayTraceClosestFramePass(device, packed);
    expect(buffers).toHaveLength(7);
    const sizes = buffers.map((buffer) => buffer.size);
    expect(sizes[0]).toBe(packed.nodeBytes.byteLength);
    expect(sizes[1]).toBe(packed.recordBytes.byteLength);
    expect(sizes[5]).toBe(4); // stackOverflows
    expect(sizes[6]).toBe(RAY_TRACE_CLOSEST_FRAME_PARAMS_BYTES);
    expect(buffers[5]!.usage & 0x4).not.toBe(0); // COPY_SRC(验收 readback 通道)
    pass.destroy();
    expect(buffers.every((buffer) => buffer.destroy)).toBe(true);
  });

  it("rejects the f16 variant without the shader-f16 feature (fail-closed)", () => {
    const { device } = deviceStub(false);
    expect(() => new RayTraceClosestFramePass(device, packedScene(), { f16: true }))
      .toThrow("shader-f16");
  });

  it("rejects WGSL validation failures at construction (fail-fast, no silent dispatch)", async () => {
    const { device } = deviceStub();
    device.failNextValidation("WGSL syntax error");
    const pass = new RayTraceClosestFramePass(device, packedScene());
    const { encoder } = encoderStub();
    await expect(pass.encode(encoder, { depthView: depthView(), hitView: hitView(), width: 8, height: 8,
      invViewProjection: INV, eye: [0, 0, 5], tMax: 80, bias: 0.01, rayMask: 0xff }))
      .rejects.toThrow("validation failed");
    pass.destroy();
  });

  it("rejects scene sizes beyond maxInstances before creating any GPU resource", () => {
    const { device, buffers } = deviceStub();
    const oversized = { ...packedScene(), instanceCount: 262_145 } as unknown as TlasPackedScene;
    expect(() => new RayTraceClosestFramePass(device, oversized)).toThrow("maxInstances");
    expect(buffers).toHaveLength(0);
  });

  it("encodes one 8x8-tiled compute dispatch and reuses cached bind groups per (depthView, hitView)", async () => {
    const { device, bindGroups } = deviceStub();
    const pass = new RayTraceClosestFramePass(device, packedScene());
    const depth = depthView(), hit = hitView();
    const first = encoderStub();
    await pass.encode(first.encoder, { depthView: depth, hitView: hit, width: 320, height: 240,
      invViewProjection: INV, eye: [0, 0, 5], tMax: 80, bias: 0.01, rayMask: 0xff });
    expect(first.passes[0]!.dispatches).toEqual([[40, 30, 1]]);
    expect(bindGroups).toHaveLength(1);
    expect(bindGroups[0]!.entries).toHaveLength(9);
    // 逐槽合同:0..4 场景,5 depth,6 uniform,7 hitView,8 哨兵。
    expect(bindGroups[0]!.entries.map((entry) => entry.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(bindGroups[0]!.entries[5]!.resource).toBe(depth);
    expect(bindGroups[0]!.entries[7]!.resource).toBe(hit);
    // 同 (depthView, hitView) 第二帧:LRU 命中,不新建 bind group。
    const second = encoderStub();
    await pass.encode(second.encoder, { depthView: depth, hitView: hit, width: 320, height: 240,
      invViewProjection: INV, eye: [0, 0, 5], tMax: 80, bias: 0.01, rayMask: 0xff });
    expect(bindGroups).toHaveLength(1);
    pass.destroy();
  });

  it("rewrites only the TLAS region when BLAS segments are unchanged and refuses otherwise", () => {
    const { device } = deviceStub();
    const pass = new RayTraceClosestFramePass(device, packedScene(6, 4));
    const incremental = packedScene(6, 4);
    expect(() => pass.updateTlasRegion(incremental)).not.toThrow();
    expect(pass.packed).toBe(incremental);
    expect(() => pass.updateTlasRegion(packedScene(8, 4))).toThrow("unchanged BLAS segments");
    pass.destroy();
  });

  it("refuses non-integer or non-finite frame inputs (fail-fast)", async () => {
    const { device } = deviceStub();
    const pass = new RayTraceClosestFramePass(device, packedScene());
    const base = { depthView: depthView(), hitView: hitView(), invViewProjection: INV,
      eye: [0, 0, 5] as const, tMax: 80, bias: 0.01, rayMask: 0xff };
    await expect(pass.encode(encoderStub().encoder, { ...base, width: 0, height: 8 })).rejects.toThrow("dimensions");
    await expect(pass.encode(encoderStub().encoder, { ...base, width: 8, height: 8, tMax: Number.NaN }))
      .rejects.toThrow("finite");
    await expect(pass.encode(encoderStub().encoder, { ...base, width: 8, height: 8, bias: Number.POSITIVE_INFINITY }))
      .rejects.toThrow("finite");
    pass.destroy();
  });

  it("declares the rgba32float hit-record format for the consumer contract", () => {
    expect(RAY_TRACE_CLOSEST_FRAME_FORMAT).toBe("rgba32float");
  });
});
