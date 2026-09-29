import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { packVirtualTexturePageTable, VirtualTextureTileLookupPass,
  VIRTUAL_TEXTURE_TILE_LOOKUP_WGSL } from "./virtualTextureSampling.js";
import type { VirtualTextureCatalogEntry, VirtualTextureSampleRequest } from "./virtualTextureFrameBridge.js";

/**
 * F4 tile-lookup 采样消费:页表打包布局(param/meta/layer 段)、mipEdge 随 atlasEdge
 * 折算、缺页 -1;encode 的 skip 分支与 dispatch/writeBuffer 合同;dispose 幂等。
 * GPU 走 mock device(照 probeFactory fixture 先例);真机像素对照留联测脚本。
 */

const CATALOG: readonly VirtualTextureCatalogEntry[] = [{
  textureId: "t", chainMips: 2,
  mipGrids: [
    { gridWidth: 2, gridHeight: 2, levelWidth: 128, levelHeight: 128 },
    { gridWidth: 1, gridHeight: 1, levelWidth: 64, levelHeight: 64 },
  ],
}];

const SAMPLES: readonly VirtualTextureSampleRequest[] = [
  { textureIndex: 0, u: 0.25, v: 0.25, mip: 0 },
  { textureIndex: 0, u: 0.5, v: 0.5, mip: 1 },
];

function fixture() {
  const buffers: { size: number; label: string; destroy: ReturnType<typeof vi.fn> }[] = [];
  const writeBuffer = vi.fn();
  const passes: { setPipeline: ReturnType<typeof vi.fn>; setBindGroup: ReturnType<typeof vi.fn>;
    dispatchWorkgroups: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }[] = [];
  const device = {
    limits: {},
    queue: { writeBuffer, submit: vi.fn() },
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroup: vi.fn(({ label }: { label: string }) => ({ label })),
    createSampler: vi.fn(({ label }: { label: string }) => ({ label })),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { size: descriptor.size, label: descriptor.label ?? "", destroy: vi.fn() };
      buffers.push(buffer); return buffer;
    }),
  };
  const encoder = { beginComputePass: vi.fn((descriptor: GPUComputePassDescriptor) => {
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn(),
      label: descriptor.label };
    passes.push(pass); return pass;
  }) };
  return { device: device as unknown as GPUDevice, session: { state: "ready", device } as unknown as DeviceSession,
    encoder: encoder as unknown as GPUCommandEncoder, writeBuffer, buffers, passes };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 4, COPY_DST: 2 });
});
afterEach(() => vi.unstubAllGlobals());

describe("packVirtualTexturePageTable", () => {
  it("param 行:样本数/纹理数/链长/atlasEdge;mipEdge = atlasEdge >> mip", () => {
    const packing = packVirtualTexturePageTable(CATALOG,
      (_id, tileX, tileY, mip) => mip === 0 ? tileY * 2 + tileX : 0, SAMPLES, 128);
    expect([...packing.params]).toEqual([2, 1, 2, 128]);
    expect([...packing.mipMeta.subarray(0, 4)]).toEqual([2, 2, 0, 128]);
    expect([...packing.mipMeta.subarray(4, 8)]).toEqual([1, 1, 4, 64]);
    expect([...packing.pageLayers]).toEqual([0, 1, 2, 3, 0]);
  });

  it("缺页显式 -1;layerOfPage undefined 同样 -1,不产伪映射", () => {
    const packing = packVirtualTexturePageTable(CATALOG, () => undefined, SAMPLES, 128);
    expect([...packing.pageLayers]).toEqual([-1, -1, -1, -1, -1]);
  });
});

describe("VirtualTextureTileLookupPass", () => {
  it("encode 合同:一次 compute pass、样本写入、7 个绑定项、dispatch 覆盖全部样本", () => {
    const f = fixture();
    const pass = new VirtualTextureTileLookupPass(f.session);
    const atlasView = ({} as GPUTextureView) ;
    const result = pass.encode(f.encoder, { atlasView, atlasEdge: 128, catalog: CATALOG,
      layerOfPage: (_id, tileX, tileY, mip) => (mip === 0 ? tileY * 2 + tileX : 0), samples: [...SAMPLES] });
    expect(result).toEqual({ dispatches: 1, samples: 2, skipped: undefined });
    expect(f.passes).toHaveLength(1);
    expect(f.passes[0]!.dispatchWorkgroups).toHaveBeenCalledWith(1);
    expect(f.writeBuffer).toHaveBeenCalledTimes(4);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(1);
    const entries = (f.device.createBindGroup as ReturnType<typeof vi.fn>).mock.calls[0]![0].entries;
    expect(entries).toHaveLength(7);
    expect(entries[3].resource).toBe(atlasView);
    pass.dispose();
  });

  it("skip 显式:空样本 no-samples;超容量 over-capacity;均零 dispatch 零写入", () => {
    const f = fixture();
    const pass = new VirtualTextureTileLookupPass(f.session);
    expect(pass.encode(f.encoder, { atlasView: {} as GPUTextureView, atlasEdge: 128, catalog: CATALOG,
      layerOfPage: () => 0, samples: [] })).toEqual({ dispatches: 0, samples: 0, skipped: "no-samples" });
    const overflow: readonly VirtualTextureSampleRequest[] = Array.from({ length: 65 }, (_, index) =>
      ({ textureIndex: 0, u: 0.1 + index * 0.001, v: 0.1, mip: 0 }));
    expect(pass.encode(f.encoder, { atlasView: {} as GPUTextureView, atlasEdge: 128, catalog: CATALOG,
      layerOfPage: () => 0, samples: overflow })).toEqual({ dispatches: 0, samples: 0, skipped: "over-capacity" });
    expect(pass.encode(f.encoder, { atlasView: {} as GPUTextureView, atlasEdge: 128, catalog: [],
      layerOfPage: () => 0, samples: [...SAMPLES] })).toEqual({ dispatches: 0, samples: 0, skipped: "over-capacity" });
    expect(f.passes).toHaveLength(0);
    expect(f.writeBuffer).not.toHaveBeenCalled();
    pass.dispose();
  });

  it("目录增长触发缓冲重建(容量只增不缩),writeBuffer 仍单次全量", () => {
    const f = fixture();
    const pass = new VirtualTextureTileLookupPass(f.session);
    const small: readonly VirtualTextureCatalogEntry[] = [{ textureId: "a", chainMips: 1,
      mipGrids: [{ gridWidth: 1, gridHeight: 1, levelWidth: 64, levelHeight: 64 }] }];
    const large: readonly VirtualTextureCatalogEntry[] = Array.from({ length: 8 }, (_, index) => ({
      textureId: `t${index}`, chainMips: 4,
      mipGrids: Array.from({ length: 4 }, (_, mip) =>
        ({ gridWidth: 4, gridHeight: 4, levelWidth: 64 >> mip, levelHeight: 64 >> mip })) }));
    pass.encode(f.encoder, { atlasView: {} as GPUTextureView, atlasEdge: 64, catalog: small,
      layerOfPage: () => 0, samples: [{ textureIndex: 0, u: 0.5, v: 0.5, mip: 0 }] });
    const bufferCountAfterSmall = f.buffers.length;
    pass.encode(f.encoder, { atlasView: {} as GPUTextureView, atlasEdge: 64, catalog: large,
      layerOfPage: () => 0, samples: [{ textureIndex: 0, u: 0.5, v: 0.5, mip: 0 }] });
    expect(f.buffers.length).toBeGreaterThan(bufferCountAfterSmall);
    pass.dispose();
  });

  it("dispose 幂等;dispose 后 encode 拒绝;WGSL 含缺页哨兵与页表查找", () => {
    const f = fixture();
    const pass = new VirtualTextureTileLookupPass(f.session);
    pass.dispose();
    pass.dispose();
    expect(() => pass.encode(f.encoder, { atlasView: {} as GPUTextureView, atlasEdge: 128, catalog: CATALOG,
      layerOfPage: () => 0, samples: [...SAMPLES] })).toThrow(/disposed/);
    expect(VIRTUAL_TEXTURE_TILE_LOOKUP_WGSL).toContain("pageLayers");
    expect(VIRTUAL_TEXTURE_TILE_LOOKUP_WGSL).toContain("texture_2d_array");
    expect(VIRTUAL_TEXTURE_TILE_LOOKUP_WGSL).toContain("1.0, 0.0, 1.0, 1.0");
  });
});
