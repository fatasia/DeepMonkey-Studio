import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotRendererOptions } from "../threeBridge/deepWebGpuOptions.js";
import { createSyntheticRgba8 } from "../virtualTextures/virtualTexturePages.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { PreparedBatch } from "../renderPacket.js";
import { createVirtualTextureFrameBridge, type VirtualTextureFrameBridge } from "./virtualTextureFrameBridge.js";
import { VirtualTextureTileLookupPass } from "./virtualTextureSampling.js";
import { PbrRenderer } from "./pbrRenderer.js";

/**
 * F4 虚拟纹理渲染接线(prototype 直调,照 probeFactory/disposal 先例):
 * - 门控:未启用时 bridge 不构造,渲染器无虚拟纹理字段(默认关 = 零行为变化);
 * - driveVirtualTextures:batch 反馈 → 驻留推进 → 消费编码,遥测经 FrameMetrics 透出;
 * - 快照白名单:virtualTextures 键接受 + 冻结 + 缺省不出现,未知键仍拒。
 */

interface Fixture {
  session: DeviceSession;
  bridge: VirtualTextureFrameBridge;
  lookup: VirtualTextureTileLookupPass;
  writeTexture: ReturnType<typeof vi.fn>;
  encoder: GPUCommandEncoder;
  settle(): Promise<void>;
}

function fixture(): Fixture {
  const writeTexture = vi.fn();
  const device = { lost: new Promise<void>(() => {}), features: new Set<GPUFeatureName>(),
    limits: { maxTextureDimension2D: 16384, maxTextureArrayLayers: 2048 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createTexture: vi.fn(() => ({ destroy: vi.fn(), createView: vi.fn(() => ({})) })),
    createSampler: vi.fn(() => ({})), createShaderModule: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) =>
      ({ size: descriptor.size, destroy: vi.fn() })),
    queue: { writeTexture, writeBuffer: vi.fn(), submit: vi.fn() } };
  const session = { state: "ready", device, own: (r: unknown) => r, release: () => {} } as unknown as DeviceSession;
  const encoder = { beginComputePass: vi.fn(() =>
    ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() })) };
  const bridge = createVirtualTextureFrameBridge(session,
    { enabled: true, maxResidentBytes: 1 << 20, tileEdgeTexels: 64 })!;
  return { session, bridge, lookup: new VirtualTextureTileLookupPass(session),
    writeTexture, encoder: encoder as unknown as GPUCommandEncoder,
    async settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); } };
}

const TEXTURE: DecodedTexture = createSyntheticRgba8("t", 64, 64, 3);

function batch(geometryId: string, count: number, textured: boolean): CachedPacketBatch {
  const source = {
    key: geometryId, geometry: geometryId, instanceIds: [], mirrored: false, doubleSided: false,
    alphaMode: "OPAQUE", count,
    ...(textured ? { textures: { emissiveStrength: 0,
      baseColor: { texture: "t", texCoord: 0, uvTransform: [1, 0, 0, 0, 1, 0] } } } : {}),
  } as unknown as PreparedBatch;
  return { source, buffer: {} as GPUBuffer, capacity: 0, previousBuffer: {} as GPUBuffer,
    previousCapacity: 0, previousTransforms: new Float32Array(0) };
}

const GEOMETRY = (id: string): [string, CachedPacketGeometry] => [id,
  { source: {} as never, mesh: {} as never, center: [0, 0, 10] as const, radius: 1 }];

// 列主序 world→clip:z_clip = z - 9 → center z=10 落 NDC z=1/w=1 内(WebGPU [0,1] 口径)。
const FRAME_STATE = {
  depthViewProjection: new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -9, 1,
  ]),
  projection: { verticalFovRadians: Math.PI / 2, near: 0.1, far: 100 },
};

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2, STORAGE: 8 });
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 4, COPY_DST: 2 });
});
afterEach(() => vi.unstubAllGlobals());

describe("virtual texture render wiring", () => {
  it("默认关:createVirtualTextureFrameBridge(undefined) → undefined,渲染器零接入", () => {
    expect(createVirtualTextureFrameBridge({} as DeviceSession, undefined)).toBeUndefined();
    expect(createVirtualTextureFrameBridge({} as DeviceSession, {})).toBeUndefined();
    expect(createVirtualTextureFrameBridge({} as DeviceSession, { enabled: false })).toBeUndefined();
  });

  it("可见纹理批驱动反馈→驻留;atlas 就绪后消费编码并入遥测", async () => {
    const f = fixture();
    f.bridge.syncTextures([TEXTURE]);
    const batches = new Map<string, CachedPacketBatch>([["b0", batch("g0", 1, true)]]);
    const geometries = new Map<string, CachedPacketGeometry>([GEOMETRY("g0")]);
    const renderer = Object.assign(Object.create(PbrRenderer.prototype), {
      virtualTextures: f.bridge, virtualTileLookup: f.lookup,
      packets: { visibilityInputs: () => ({ batches, geometries, lod: undefined, deformationActive: false }) } });
    const drive = (PbrRenderer.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)
      ["driveVirtualTextures"]!;
    // 第 1 帧:反馈入队,atlas 懒创建于上传前;编码可能因 atlas 尚未 commit 而跳过(遥测披露)。
    const first = drive.call(renderer as never, FRAME_STATE, { width: 800, height: 600 }, f.encoder) as
      ReturnType<VirtualTextureFrameBridge["observeFrame"]>;
    expect(first.enabled).toBe(true);
    expect(first.feedback.entryCount).toBe(1);
    expect(first.feedback.footprintCount).toBe(1);
    expect(first.feedback.droppedUnknownTexture).toBe(0);
    await f.settle();
    expect(f.writeTexture).toHaveBeenCalled();
    // 第 2 帧:页已提交,atlas 存在,消费编码执行。
    const second = drive.call(renderer as never, FRAME_STATE, { width: 800, height: 600 }, f.encoder) as
      ReturnType<VirtualTextureFrameBridge["observeFrame"]>;
    expect(second.frame).toBe(1);
    expect(second.sampling).toBeDefined();
    expect(second.sampling!.dispatches).toBe(1);
    expect(second.sampling!.samples).toBeGreaterThan(0);
    expect(second.residentBytes).toBeGreaterThan(0);
    f.bridge.dispose();
    f.lookup.dispose();
  });

  it("无纹理批/背向几何零反馈:footprint 0、消费 skip no-samples,不产伪页", () => {
    const f = fixture();
    const batches = new Map<string, CachedPacketBatch>([
      ["b0", batch("g0", 1, false)],
      ["b1", batch("g1", 1, true)],
    ]);
    const geometries = new Map<string, CachedPacketGeometry>([GEOMETRY("g0")]);
    const renderer = Object.assign(Object.create(PbrRenderer.prototype), {
      virtualTextures: f.bridge, virtualTileLookup: f.lookup,
      packets: { visibilityInputs: () => ({ batches, geometries, lod: undefined, deformationActive: false }) } });
    const drive = (PbrRenderer.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)
      ["driveVirtualTextures"]!;
    const metrics = drive.call(renderer as never, FRAME_STATE, { width: 800, height: 600 }, f.encoder) as
      ReturnType<VirtualTextureFrameBridge["observeFrame"]>;
    expect(metrics.feedback.entryCount).toBe(0);
    expect(metrics.feedback.footprintCount).toBe(0);
    f.bridge.dispose();
    f.lookup.dispose();
  });

  it("dispose 释放桥与消费 pass(owners 展开)", () => {
    const f = fixture();
    const renderer = { ground: { author: { dispose: vi.fn() } }, outputs: { dispose: vi.fn() },
      environment: { dispose: vi.fn() }, lighting: { dispose: vi.fn() }, localShadows: { dispose: vi.fn() },
      shadowState: { dispose: vi.fn() }, previousHiZ: { dispose: vi.fn() }, transparency: { dispose: vi.fn() },
      postProcess: { dispose: vi.fn() }, packets: { dispose: vi.fn() }, targets: { dispose: vi.fn() },
      cameraHistory: { reset: vi.fn() }, session: { dispose: vi.fn() },
      virtualTextures: f.bridge, virtualTileLookup: f.lookup };
    PbrRenderer.prototype.dispose.call(renderer as never);
    expect(renderer.virtualTextures).toBeUndefined;
    expect(() => f.bridge.observeFrame([])).toThrow(/disposed/);
  });
});

describe("snapshotRendererOptions virtualTextures key", () => {
  it("显式配置进快照且冻结;缺省不出现;未知键仍拒", () => {
    const snapshot = snapshotRendererOptions({ virtualTextures: { enabled: true, maxResidentBytes: 1024 } });
    expect(snapshot.virtualTextures).toEqual({ enabled: true, maxResidentBytes: 1024 });
    expect(Object.isFrozen(snapshot.virtualTextures)).toBe(true);
    expect("virtualTextures" in snapshotRendererOptions({})).toBe(false);
    expect(() => snapshotRendererOptions({ typo: true } as never)).toThrow("Unknown Deep WebGPU renderer option");
  });
});
