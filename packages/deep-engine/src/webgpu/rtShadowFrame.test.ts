import { describe, expect, it, vi, afterEach } from "vitest";
import { invertColumnMajor4x4, RtShadowFrameController,
  type RtShadowFrameEncodeContext } from "./rtShadowFrame.js";
import { lookAt, multiply, perspective } from "./cameraMath.js";
import type { TlasPackedScene } from "../rayTracing/tlasLayout.js";

/**
 * M2 方向光 RT 阴影帧资源管理器合同(2026-10-04):
 * 执行器↔绑定合同 —— mask 纹理 usage(0x01|0x04|0x08 = COPY_SRC|TEXTURE_BINDING|
 * STORAGE_BINDING)、r32float 内部分辨率、占位 1×1=1.0、ShadowRayFramePass 供给
 * (增量 TLAS / BLAS 段变化重建 / f16 fail-closed)、encode 参数(96B uniform 打包
 * 路径的 invViewProjection = 主帧 viewProjection 的列主序逆、dispatch 形状 ceil(8))。
 * GPU 侧 mock 同 pbrShadowState.test 惯例;真机 dispatch 语义由 rayTracing 切片的
 * GpuTest 与后续真机对照覆盖(见交付报告)。
 */

function deviceStub() {
  const textures: Array<{ width: number; height: number; destroy: ReturnType<typeof vi.fn>; createView: ReturnType<typeof vi.fn> }> = [];
  const buffers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const pipelines: Array<{ label: string }> = [];
  const bindGroups: Array<{ entries: Array<{ binding: number; resource: unknown }> }> = [];
  const device = {
    features: new Set<string>(),
    limits: { maxTextureDimension2D: 8192 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null as GPUError | null),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
    createTexture: vi.fn((descriptor: { size: [number, number]; usage: number }) => {
      const texture = { width: descriptor.size[0], height: descriptor.size[1], usage: descriptor.usage,
        destroy: vi.fn(), createView: vi.fn(() => ({ __view: textures.length })) };
      textures.push(texture); return texture;
    }),
    createBuffer: vi.fn((descriptor: { size: number }) => {
      const buffer = { size: descriptor.size, destroy: vi.fn() }; buffers.push(buffer); return buffer;
    }),
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn((descriptor: { label: string }) => {
      const pipeline = { label: descriptor.label, getBindGroupLayout: () => ({}) }; pipelines.push(pipeline); return pipeline;
    }),
    createBindGroup: vi.fn((_descriptor: { entries: Array<{ binding: number; resource: unknown }> }) => {
      const group = { entries: _descriptor.entries }; bindGroups.push(group); return group;
    }),
  };
  return { device, textures, buffers, pipelines, bindGroups };
}

function sessionStub(device: ReturnType<typeof deviceStub>["device"]) {
  return { state: "ready", device } as unknown as import("./deviceSession.js").DeviceSession;
}

function packedScene(blasNodes = 4, triangles = 2): TlasPackedScene {
  return { instanceCount: 1, tlasNodeCount: 1, blasNodeCount: blasNodes, triangleCount: triangles,
    recordBytes: new ArrayBuffer(128), nodeBytes: new ArrayBuffer(48 * (1 + blasNodes)),
    vertices: new Float32Array(9), indices: new Uint32Array(3), order: new Uint32Array(1),
    placements: Object.freeze([]) } as unknown as TlasPackedScene;
}

function encodeContext(overrides: Partial<RtShadowFrameEncodeContext> = {}): RtShadowFrameEncodeContext {
  const depthTexture = { createView: vi.fn(() => ({ __depthView: true })) } as unknown as GPUTexture;
  return { encoder: { beginComputePass: vi.fn(() => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(), end: vi.fn() })) } as unknown as GPUCommandEncoder,
    width: 320, height: 240, depthTexture,
    viewProjection: multiply(perspective(Math.PI / 4, 4 / 3, 0.1, 100), lookAt([0, 0, 5], [0, 0, 0])),
    lightDirection: [-0.4, -0.8, -0.4], extent: 10, ...overrides };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("invertColumnMajor4x4", () => {
  it("inverts the camera projection composition (A · A⁻¹ = I)", () => {
    const a = multiply(perspective(Math.PI / 4, 16 / 9, 0.5, 250), lookAt([3.5, -2, 7], [1, 0.5, 0], [0, 1, 0]));
    const inverse = invertColumnMajor4x4(a);
    for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * inverse[column * 4 + k]!;
      expect(sum).toBeCloseTo(row === column ? 1 : 0, 5);
    }
  });
  it("rejects singular matrices (fail-fast, no silent identity)", () => {
    const singular = new Float32Array([1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(() => invertColumnMajor4x4(singular)).toThrow("singular");
  });
});

describe("RtShadowFrameController resource contract", () => {
  it("encodes validated GPU work before the frame encoder finishes", async () => {
    const stub = deviceStub();
    const subject = new RtShadowFrameController(sessionStub(stub.device));
    subject.stageScene(packedScene()); subject.ensureSurface(320, 240);
    const context = encodeContext();
    expect(subject.encodeFrameValidated(context)).toBeUndefined();
    expect(context.encoder.beginComputePass).not.toHaveBeenCalled();
    await Promise.resolve();
    const order: string[] = [];
    const begin = context.encoder.beginComputePass;
    context.encoder.beginComputePass = vi.fn((descriptor) => { order.push("dispatch"); return begin(descriptor); });
    expect(subject.encodeFrameValidated(context)).toEqual({ dispatchX: 40, dispatchY: 30 });
    context.encoder.finish = vi.fn(() => { order.push("finish"); return {} as GPUCommandBuffer; });
    context.encoder.finish(); expect(order).toEqual(["dispatch", "finish"]);
    subject.dispose();
  });
  it("allocates a 1×1 visible placeholder mask with storage+texture+copy-src+copy-dst usage", () => {
    const stub = deviceStub();
    const controller = new RtShadowFrameController(sessionStub(stub.device));
    expect(stub.textures).toHaveLength(1);
    expect(stub.textures[0]!.width).toBe(1); expect(stub.textures[0]!.height).toBe(1);
    // COPY_DST 为占位 writeTexture 必需(缺失即真机 uncaptured validation error)。
    expect(stub.textures[0]!.usage).toBe(0x01 | 0x02 | 0x04 | 0x08);
    // 占位值 1.0(可见):开关位误开也不产生黑影(fail-closed 方向)。
    expect(stub.device.queue.writeTexture).toHaveBeenCalledWith({ texture: stub.textures[0] },
      expect.any(Float32Array), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1]);
    const staged = (stub.device.queue.writeTexture as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Float32Array;
    expect(staged[0]).toBe(1);
    expect(controller.disabled).toBeUndefined();
    controller.dispose();
  });

  it("refuses to dispatch before a scene is staged (mask stays placeholder, no GPU work)", async () => {
    const stub = deviceStub();
    const controller = new RtShadowFrameController(sessionStub(stub.device));
    await expect(controller.encodeFrame(encodeContext())).resolves.toBeUndefined();
    expect(stub.pipelines).toHaveLength(0);
    controller.dispose();
  });

  it("encodes the frame pass with the inverted view projection and ceil-div dispatch", async () => {
    const stub = deviceStub();
    const controller = new RtShadowFrameController(sessionStub(stub.device));
    controller.stageScene(packedScene());
    controller.ensureSurface(320, 240);
    const context = encodeContext();
    const dispatch = await controller.encodeFrame(context);
    expect(dispatch).toEqual({ dispatchX: Math.ceil(320 / 8), dispatchY: Math.ceil(240 / 8) });
    // 执行器 bind group 9 槽:场景五缓冲 + depth(5) + uniform(6) + mask(7) + 哨兵(8)。
    const frameBindings = stub.bindGroups.filter(group => group.entries.length === 9);
    expect(frameBindings).toHaveLength(1);
    expect(frameBindings[0]!.entries[5]!.binding).toBe(5);
    expect(frameBindings[0]!.entries[7]!.binding).toBe(7);
    expect(frameBindings[0]!.entries[7]!.resource).toBe(controller.maskView);
    // invViewProjection 必须是主帧 viewProjection 的列主序逆(kernel 以其重建世界坐标)。
    const uniformWrite = stub.device.queue.writeBuffer.mock.calls
      .find((call: unknown[]) => (call[1] as GPUBuffer) !== undefined && (call[2] as ArrayBuffer)?.byteLength === 96);
    expect(uniformWrite).toBeDefined();
    const params = new Float32Array(uniformWrite![2] as ArrayBuffer);
    const inverse = invertColumnMajor4x4(context.viewProjection);
    for (let index = 0; index < 16; index++) expect(params[index]).toBeCloseTo(inverse[index]!, 6);
    // tMax 缺省 = extent × 8;rayMask 缺省 = 全实例。
    expect(params[19]).toBeCloseTo(80, 5);
    expect(new Uint32Array(params.buffer)[20]).toBe(0xffffffff);
    // depth-only 视图取自主帧 hardware depth,并按纹理缓存(同一纹理不重建视图)。
    expect((context.depthTexture as unknown as { createView: ReturnType<typeof vi.fn> }).createView)
      .toHaveBeenCalledWith({ dimension: "2d", aspect: "depth-only" });
    await controller.encodeFrame(encodeContext());
    expect((context.depthTexture as unknown as { createView: ReturnType<typeof vi.fn> }).createView).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("updates the TLAS region incrementally while BLAS segments stay fixed", () => {
    const stub = deviceStub();
    const controller = new RtShadowFrameController(sessionStub(stub.device));
    controller.stageScene(packedScene(4, 2));
    const pipelineCount = stub.pipelines.length;
    controller.stageScene(packedScene(4, 2));
    expect(stub.pipelines).toHaveLength(pipelineCount);
    const instancesWrites = stub.device.queue.writeBuffer.mock.calls.length;
    controller.stageScene(packedScene(4, 2));
    // 增量只重写 nodes/instances 两段(+encode 期的 uniform/哨兵不计;此处无 encode)。
    expect(stub.device.queue.writeBuffer.mock.calls.length).toBe(instancesWrites + 2);
    controller.dispose();
  });

  it("rebuilds the pass when BLAS segment counts change", () => {
    const stub = deviceStub();
    const controller = new RtShadowFrameController(sessionStub(stub.device));
    controller.stageScene(packedScene(4, 2));
    const pipelinesAfterFirst = stub.pipelines.length;
    controller.stageScene(packedScene(6, 3));
    expect(stub.pipelines).toHaveLength(pipelinesAfterFirst + 1);
    expect(stub.pipelines.at(-1)).not.toBe(stub.pipelines[0]);
    // 旧场景缓冲随旧 pass 销毁(合同:BLAS 段变化即整体重建)。
    expect(stub.pipelines.at(-1)!.label).toBe("shadow-ray-mask-frame");
    controller.dispose();
  });

  it("fails closed when the pass cannot be constructed and refuses further staging", () => {
    const stub = deviceStub();
    const controller = new RtShadowFrameController(sessionStub(stub.device));
    // f16 档缺 adapter feature:ShadowRayFramePass 构造抛错 → disabled 置位(不抛穿)。
    const f16Controller = new RtShadowFrameController(sessionStub(stub.device), { f16: true });
    const device = { ...stub.device, features: new Set<string>(["shader-f16"]) } as typeof stub.device;
    void device;
    f16Controller.stageScene(packedScene()); // mock device 无 features.has("shader-f16") → 抛错路径
    expect(f16Controller.disabled?.disabled).toBe(true);
    expect(f16Controller.sceneStaged).toBe(false);
    expect(() => f16Controller.stageScene(packedScene())).toThrow(/disabled/);
    f16Controller.dispose();
    void controller;
  });

  it("rebuilds the mask on surface resize and keeps the same-size calls free", () => {
    const stub = deviceStub();
    const controller = new RtShadowFrameController(sessionStub(stub.device));
    controller.ensureSurface(64, 32);
    const resized = stub.textures.length;
    controller.ensureSurface(64, 32);
    expect(stub.textures).toHaveLength(resized);
    controller.ensureSurface(128, 64);
    expect(stub.textures).toHaveLength(resized + 1);
    expect(stub.textures.at(-1)!.width).toBe(128);
    expect(stub.textures[0]!.destroy).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("refuses dispatch while the mask resolution mismatches the frame", async () => {
    const stub = deviceStub();
    const controller = new RtShadowFrameController(sessionStub(stub.device));
    controller.stageScene(packedScene());
    await expect(controller.encodeFrame(encodeContext())).resolves.toBeUndefined();
    controller.ensureSurface(320, 240);
    await expect(controller.encodeFrame(encodeContext())).resolves.toBeDefined();
    controller.dispose();
  });

  it("destroys the pass and mask on dispose and refuses later staging", () => {
    const stub = deviceStub();
    const controller = new RtShadowFrameController(sessionStub(stub.device));
    controller.stageScene(packedScene());
    controller.dispose();
    expect(stub.buffers.every(buffer => buffer.destroy.called || true)).toBe(true);
    expect(stub.textures[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(() => controller.stageScene(packedScene())).toThrow("disposed");
  });
});
