import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVirtualTextureSample } from "../virtualTextures/virtualTextureDiagnostics.js";
import { createSyntheticRgba8, generateVirtualTexturePages } from "../virtualTextures/virtualTexturePages.js";
import type { VirtualTexturePage } from "../virtualTextures/virtualTexturePages.js";
import type { DeviceSession } from "./deviceSession.js";
import { VirtualTextureAtlasResidency } from "./virtualTextureResidency.js";

/**
 * F3 GPU 预算驻留控制器:槽位分配、上传→提交、backlog 续传、逐出回收、
 * fail-closed(缺页级联/批失败/atlas 失败/session 未就绪)、release/dispose。
 * GPU 走 mock session(照 chunkGpuFixture 先例);真机上传与采样留联测。
 */
const SPEC = { tileEdgeTexels: 4, bytesPerTexel: 4 } as const;
const PAGES = generateVirtualTexturePages(createSyntheticRgba8("t", 64, 64, 3), SPEC);
const PAGE_SOURCE = (id: string): VirtualTexturePage | undefined => PAGES.pageByTile.get(id);
const TILE = (tileX: number, tileY: number, maxMip = 2) =>
  ({ textureId: "t", tileX, tileY, maxMip, weight: 1 });
const CHAIN_BYTES = 64 + 16 + 4;

interface Fixture {
  residency(maxResidentBytes: number, extra?: { maxUploadPagesPerFrame?: number; maxPages?: number },
    pageSource?: (id: string) => VirtualTexturePage | undefined): VirtualTextureAtlasResidency;
  writeTexture: ReturnType<typeof vi.fn>;
  popErrorScope: ReturnType<typeof vi.fn>;
  createTexture: ReturnType<typeof vi.fn>;
  setReady(ready: boolean): void;
  manualScopes(): () => void;
  settle(): Promise<void>;
}

function fixture(): Fixture {
  const owned = new Set<{ destroy(): void }>();
  let ready = true, batchError: GPUError | null = null, manual = false;
  const resolvers: ((value: GPUError | null) => void)[] = [];
  const writeTexture = vi.fn();
  const createTexture = vi.fn(() => ({ destroy: vi.fn(), createView: vi.fn(() => ({})) }));
  const device = { lost: new Promise<void>(() => {}), features: new Set<GPUFeatureName>(),
    limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 2048 },
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => manual
      ? new Promise<GPUError | null>(resolve => resolvers.push(resolve))
      : Promise.resolve(batchError)),
    createTexture, createSampler: vi.fn(() => ({})),
    queue: { writeTexture, writeBuffer: vi.fn() } };
  const session = { state: "ready", device,
    own: <T extends { destroy(): void }>(resource: T): T => { owned.add(resource); return resource; },
    release: (resource: { destroy(): void }) => { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  return {
    residency(maxResidentBytes, extra = {}, pageSource = PAGE_SOURCE) {
      return new VirtualTextureAtlasResidency(session, SPEC, { maxResidentBytes, ...extra }, pageSource);
    },
    writeTexture, popErrorScope: device.popErrorScope, createTexture,
    setReady(value: boolean) { ready = value; (session as { state: string }).state = value ? "ready" : "loading"; },
    manualScopes() {
      manual = true;
      return () => { for (const resolve of resolvers.splice(0)) resolve(null); };
    },
    async settle() { for (let round = 0; round < 8; round++) await Promise.resolve(); },
  };
}

describe("VirtualTextureAtlasResidency", () => {
  let f: Fixture;
  beforeEach(() => { f = fixture(); vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 }); });
  afterEach(() => vi.unstubAllGlobals());

  it("atlas 由预算推导且 GPU 字节不超过 maxResidentBytes;显式 maxPages 生效", () => {
    expect(f.residency(640).advance(0, [TILE(0, 0)]).atlasLayers).toBe(10);
    expect(f.residency(640, { maxPages: 4 }).advance(0, []).atlasLayers).toBe(4);
    expect(f.residency(640).advance(0, []).atlasBytes).toBe(640);
  });

  it("maxPages 超设备上限、非 RGBA8 规格、预算不足一整层:构造即拒(可操作错误)", () => {
    expect(() => f.residency(640, { maxPages: 4096 })).toThrow(/exceeds device limit/);
    expect(() => f.residency(32)).toThrow(/smaller than one atlas layer/);
    expect(() => new VirtualTextureAtlasResidency(
      { device: { limits: {} } } as unknown as DeviceSession,
      { tileEdgeTexels: 4, bytesPerTexel: 2 }, { maxResidentBytes: 64 }, PAGE_SOURCE)).toThrow(/RGBA8/);
  });

  it("上传→提交→可采样;驻留页重复请求零重复上传", async () => {
    const r = f.residency(640);
    r.advance(0, [TILE(0, 0)]);
    await f.settle();
    expect(r.layerOf("t|0,0|mip0")).toBeDefined();
    expect(r.pageTable.residentByteCount).toBe(CHAIN_BYTES);
    expect(resolveVirtualTextureSample(r.pageTable, "t", 0, 0, 2))
      .toMatchObject({ status: "resident", resolvedMip: 2 });
    expect(f.writeTexture).toHaveBeenCalledTimes(3);
    expect(f.writeTexture.mock.calls[0]![2]).toEqual({ bytesPerRow: 256, rowsPerImage: 4 });
    expect(f.writeTexture.mock.calls[0]![3]).toEqual({ width: 4, height: 4, depthOrArrayLayers: 1 });
    expect(r.advance(1, [TILE(0, 0)]).uploadsQueued).toBe(3);
    expect(f.writeTexture).toHaveBeenCalledTimes(3);
  });

  it("单帧上传预算→backlog 跨帧续传至全部提交", async () => {
    const r = f.residency(640, { maxUploadPagesPerFrame: 2 });
    const first = r.advance(0, [TILE(0, 0)]);
    expect(first.uploadBacklog).toBe(1);
    await f.settle();
    const second = r.advance(1, [TILE(0, 0)]);
    expect(second.uploadBacklog).toBe(0);
    expect(second.uploadsCommitted).toBe(2);
    await f.settle();
    expect(r.pageTable.residentByteCount).toBe(CHAIN_BYTES);
  });

  it("页数硬顶(atlasLayers)触发 LRU 逐出并回收槽位,驻留字节逐帧不越硬预算", async () => {
    const r = f.residency(6 * 64);
    r.advance(0, [TILE(0, 0)]);
    await f.settle();
    expect(r.advance(1, [TILE(1, 0)]).residentBytes).toBeLessThanOrEqual(6 * 64);
    await f.settle();
    const third = r.advance(2, [TILE(2, 0)]);
    expect(third.residentBytes).toBeLessThanOrEqual(6 * 64);
    expect(third.evictions).toBe(3);
    expect(third.uploadBacklog).toBe(0);
  });

  it("缺页数据 fail-closed:级联回滚同链高 mip、missingPages 计数、采样回退整纹理", async () => {
    const hole = f.residency(640, {}, id => id.endsWith("mip1") ? undefined : PAGE_SOURCE(id));
    expect(hole.advance(0, [TILE(0, 0)]).missingPages).toBe(1);
    await f.settle();
    expect(hole.pageTable.residentMipDepth("t", 0, 0)).toBe(0);
    expect(resolveVirtualTextureSample(hole.pageTable, "t", 0, 0, 2))
      .toMatchObject({ status: "page-fault", resolvedMip: 0 });
    expect(hole.advance(1, [TILE(0, 0)]).missingPages).toBe(2);
  });

  it("mip0 缺失:整链不可采样,解析显式 fallback-texture(回整纹理 LOD)", async () => {
    const hole = f.residency(640, {}, id => id.endsWith("mip0") ? undefined : PAGE_SOURCE(id));
    hole.advance(0, [TILE(0, 0)]);
    await f.settle();
    expect(hole.pageTable.residentMipDepth("t", 0, 0)).toBe(-1);
    expect(resolveVirtualTextureSample(hole.pageTable, "t", 0, 0, 0))
      .toMatchObject({ status: "fallback-texture", resolvedMip: null });
    expect(f.writeTexture).toHaveBeenCalledTimes(0);
  });

  it("页数据长度失配按缺失处理,不伪造可采样页", async () => {
    const r = f.residency(640, {}, id =>
      id === "t|0,0|mip0" ? { ...PAGE_SOURCE(id)!, data: new Uint8Array(3) } : PAGE_SOURCE(id));
    expect(r.advance(0, [TILE(0, 0)]).missingPages).toBe(1);
    await f.settle();
    expect(r.pageTable.residentMipDepth("t", 0, 0)).toBe(-1);
  });

  it("错误作用域失败→整批回滚、槽位回收、计数暴露;恢复后可重新准入", async () => {
    const r = f.residency(640);
    f.popErrorScope.mockImplementation(() => Promise.resolve({ message: "injected" } as GPUError));
    r.advance(0, [TILE(0, 0)]);
    await f.settle();
    expect(r.pageTable.residentCount).toBe(0);
    const failed = r.advance(1, [TILE(0, 0)]);
    expect(failed.batchFailures).toBe(1);
    expect(failed.uploadsRolledBack).toBe(3);
    await f.settle();
    f.popErrorScope.mockImplementation(() => Promise.resolve(null));
    r.advance(2, [TILE(0, 0)]);
    await f.settle();
    expect(r.pageTable.residentByteCount).toBe(CHAIN_BYTES);
  });

  it("atlas 创建失败→整体 fallback(采样回退整纹理),advance 零工作", () => {
    f.createTexture.mockImplementation(() => { throw new Error("OOM"); });
    const r = f.residency(640);
    const frame = r.advance(0, [TILE(0, 0)]);
    expect(frame.fallbackActive).toBe(true);
    expect(frame.fallbackReason).toContain("atlas-creation-failed");
    expect(frame.uploadsQueued).toBe(0);
    expect(r.atlasTexture).toBeUndefined();
    expect(() => r.pageTable).toThrow(/fallback/);
    expect(r.advance(1, [TILE(0, 0)]).uploadsQueued).toBe(0);
  });

  it("session 未就绪→fallback:session-not-ready", () => {
    f.setReady(false);
    const r = f.residency(640);
    expect(r.advance(0, [TILE(0, 0)]).fallbackReason).toBe("virtual-texture:session-not-ready");
  });

  it("releaseTexture:已提交页整纹理逐出并回收槽位,再请求可重新上传", async () => {
    const r = f.residency(640);
    r.advance(0, [TILE(0, 0)]);
    await f.settle();
    r.releaseTexture("t");
    expect(r.pageTable.residentByteCount).toBe(0);
    expect(r.layerOf("t|0,0|mip0")).toBeUndefined();
    r.advance(2, [TILE(0, 0)]);
    await f.settle();
    expect(r.pageTable.residentByteCount).toBe(CHAIN_BYTES);
  });

  it("in-flight 批次期间 release:批次收口后完成释放,不卡死不泄漏", async () => {
    const releaseAll = f.manualScopes();
    const r = f.residency(640);
    r.advance(0, [TILE(0, 0)]);
    r.releaseTexture("t");
    releaseAll();
    await f.settle();
    expect(r.pageTable.residentByteCount).toBe(0);
    expect(r.layerOf("t|0,0|mip0")).toBeUndefined();
  });

  it("dispose 幂等;未收口批收口走回滚分支,不产生未处理拒绝", async () => {
    const releaseAll = f.manualScopes();
    const r = f.residency(640);
    r.advance(0, [TILE(0, 0)]);
    r.dispose();
    releaseAll();
    await f.settle();
    expect(r.atlasTexture).toBeUndefined();
    expect(r.layerOf("t|0,0|mip0")).toBeUndefined();
    expect(() => r.dispose()).not.toThrow();
    expect(() => r.advance(1, [])).toThrow(/disposed/);
    expect(() => r.releaseTexture("t")).toThrow(/disposed/);
  });

  it("帧序必须严格递增", () => {
    const r = f.residency(640);
    r.advance(5, []);
    expect(() => r.advance(5, [])).toThrow(RangeError);
    expect(() => r.advance(4, [])).toThrow(RangeError);
  });

  it("layerEpoch:槽位分配/回收递增,稳定帧(重复 footprint)冻结,打包缓存据此判稳", async () => {
    const r = f.residency(640);
    expect(r.layerEpoch).toBe(0);
    r.advance(0, [TILE(0, 0)]);
    const afterAdmission = r.layerEpoch;
    expect(afterAdmission).toBeGreaterThan(0);
    await f.settle();
    // 稳定帧:同 footprint 重复,无槽位变化 → epoch 冻结(缓存命中依据)。
    r.advance(1, [TILE(0, 0)]);
    expect(r.layerEpoch).toBe(afterAdmission);
    // 换 tile:新页占槽(分配驱动,未达逐出阈值)→ epoch 递增。
    r.advance(2, [TILE(1, 0)]);
    expect(r.layerEpoch).toBeGreaterThan(afterAdmission);
    // releaseTexture 逐出整纹理(槽位回收)→ 再递增。
    const beforeRelease = r.layerEpoch;
    await f.settle();
    r.releaseTexture("t");
    expect(r.layerEpoch).toBeGreaterThan(beforeRelease);
  });

  it("layerEpoch fallback 态冻结可读(层不再变化);disposed 显式拒绝", () => {
    f.setReady(false);
    const r = f.residency(640);
    r.advance(0, [TILE(0, 0)]);
    expect(r.fallbackActive).toBe(true);
    const frozen = r.layerEpoch;
    r.advance(1, [TILE(1, 0)]);
    expect(r.layerEpoch).toBe(frozen);
    r.dispose();
    expect(() => r.layerEpoch).toThrow(/disposed/);
  });
});
