import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PBR_MAIN_SAMPLE_COUNT, PBR_HDR_FORMAT, PBR_VIEW_NORMAL_FORMAT } from "./renderTargets.js";
import { WEIGHTED_OIT_ACCUMULATION_FORMAT, WEIGHTED_OIT_REVEALAGE_FORMAT } from "./weightedOitTypes.js";
import { AMBIENT_OCCLUSION_OUTPUT_FORMAT } from "../postprocess/ambientOcclusionTypes.js";
import { framePlanUsageFlags, isPbrTransientPoolEligible, PbrTransientTexturePool, transientTextureBytes,
  type PbrTransientRequest } from "./pbrTransientTexturePool.js";

interface FakeTexture extends GPUTexture { readonly descriptor: GPUTextureDescriptor; readonly destroy: ReturnType<typeof vi.fn> }
function fixture() {
  const owned = new Set<FakeTexture>(), textures: FakeTexture[] = [];
  const device = {
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const value = { ...descriptor, descriptor, width: (descriptor.size as GPUExtent3DDict).width,
        height: (descriptor.size as GPUExtent3DDict).height, depthOrArrayLayers: 1, dimension: "2d", mipLevelCount: 1,
        destroy: vi.fn(), createView: vi.fn(() => ({ texture: value })) } as unknown as FakeTexture;
      textures.push(value); return value;
    }),
  };
  const session = { state: "ready", device, own<T extends FakeTexture>(value: T) { owned.add(value); return value; },
    release(value: FakeTexture) { if (owned.delete(value)) value.destroy(); } };
  return { session: session as unknown as DeviceSession & { state: string }, device, owned, textures };
}

type TestKey = Omit<PbrTransientRequest, "resourceId">;

/** 键必须惰性构造:framePlanUsageFlags 依赖测试运行期的 GPUTextureUsage stub。 */
function keys() {
  return {
    aoHalf: { format: AMBIENT_OCCLUSION_OUTPUT_FORMAT, width: 640, height: 360, sampleCount: 1,
      usage: framePlanUsageFlags(["storage-binding", "texture-binding", "copy-src"]) },
    oit: { format: WEIGHTED_OIT_ACCUMULATION_FORMAT, width: 1280, height: 720, sampleCount: 1,
      usage: framePlanUsageFlags(["render-attachment", "texture-binding", "copy-src"]) },
    revealage: { format: WEIGHTED_OIT_REVEALAGE_FORMAT, width: 1280, height: 720, sampleCount: 1,
      usage: framePlanUsageFlags(["render-attachment", "texture-binding", "copy-src"]) },
    surface: { format: PBR_HDR_FORMAT, width: 1280, height: 720, sampleCount: PBR_MAIN_SAMPLE_COUNT,
      usage: framePlanUsageFlags(["render-attachment", "texture-binding"]) },
  };
}

function request(resourceId: string, key: TestKey): PbrTransientRequest {
  return { resourceId, ...key };
}

/** 一帧内逐个 acquire 再 release 的常规 transient 目标集合,按 queue 生命周期闭合。 */
function runFrame(pool: PbrTransientTexturePool, specs: readonly { resourceId: string; key: TestKey }[]): void {
  pool.beginFrame();
  const handles = specs.map(({ resourceId, key }) => pool.acquire(request(resourceId, key)));
  for (const handle of handles) pool.release(handle);
  pool.endFrame(true);
}

beforeEach(() => vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, STORAGE_BINDING: 4, COPY_SRC: 8 }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PBR transient texture pool", () => {
  it("reuses an identical compatibility key across frames and keeps distinct keys apart", () => {
    const f = fixture(), pool = new PbrTransientTexturePool(f.session), key = keys();
    pool.beginFrame();
    const first = pool.acquire(request("ao-half", key.aoHalf));
    pool.release(first);
    pool.endFrame(true);
    pool.beginFrame();
    const second = pool.acquire(request("ao-half", key.aoHalf));
    expect(second.texture).toBe(first.texture);
    expect(f.textures).toHaveLength(1);
    expect(pool.stats).toMatchObject({ acquireCount: 2, hits: 1, misses: 1 });
    pool.release(second);
    pool.endFrame(true);

    // 异键不串:格式/尺寸/采样/usage 任一不同都各自分配,绝不互借。
    pool.beginFrame();
    const differentFormat = pool.acquire(request("ao-half", { ...key.aoHalf, format: PBR_VIEW_NORMAL_FORMAT }));
    const differentSize = pool.acquire(request("ao-half", { ...key.aoHalf, width: 320, height: 180 }));
    const differentUsage = pool.acquire(request("ao-half", { ...key.aoHalf, usage: key.surface.usage }));
    const differentSamples = pool.acquire(request("ao-half", { ...key.aoHalf, sampleCount: 4 }));
    expect([differentFormat.texture, differentSize.texture, differentUsage.texture, differentSamples.texture])
      .not.toContain(first.texture);
    expect(f.textures).toHaveLength(5);
    expect(pool.stats).toMatchObject({ acquireCount: 6, hits: 1, misses: 5 });
    pool.endFrame(false);
    expect(f.owned.size).toBe(1); // 失败提交只作废本帧;首帧回池纹理仍在池中
    pool.dispose();
    expect(f.owned.size).toBe(0);
  });

  it("never pools cross-frame history resources", () => {
    const f = fixture(), pool = new PbrTransientTexturePool(f.session), key = keys();
    pool.beginFrame();
    for (const resourceId of ["previous-hiz", "next-hiz", "temporal-hdr"]) {
      expect(() => pool.acquire(request(resourceId, key.surface))).toThrow(/must never enter the transient pool/);
    }
    expect(f.textures).toHaveLength(0);
    expect(pool.stats.acquireCount).toBe(0);
    pool.endFrame(false);
    // 合同内非 history 帧内目标可以入池;合同外私有 transient 也可入池。
    expect(isPbrTransientPoolEligible("oit-accumulation")).toBe(true);
    expect(isPbrTransientPoolEligible("author-private-scratch")).toBe(true);
    expect(isPbrTransientPoolEligible("previous-hiz")).toBe(false);
  });

  it("invalidates the whole pool on surface resize and rebuilds from scratch", () => {
    const f = fixture(), pool = new PbrTransientTexturePool(f.session), key = keys();
    runFrame(pool, [{ resourceId: "ao-half", key: key.aoHalf }, { resourceId: "oit-accumulation", key: key.oit }]);
    const previous = [...f.textures];
    const before = pool.stats;
    pool.invalidateAll("surface-resize");
    expect(pool.epoch).toBe(before.epoch + 1);
    expect(pool.frameOpen).toBe(false);
    for (const texture of previous) expect(texture.destroy).toHaveBeenCalledOnce();
    expect(pool.stats).toMatchObject({ evictedCount: 2, freeCount: 0, inFlightCount: 0 });
    pool.beginFrame();
    const rebuilt = pool.acquire(request("ao-half", key.aoHalf));
    expect(rebuilt.texture).not.toBe(previous[0]);
    expect(f.textures).toHaveLength(3);
    expect(pool.stats.misses).toBe(3);
    pool.release(rebuilt);
    pool.endFrame(true);
    pool.dispose();
    expect(f.owned.size).toBe(0);
  });

  it("refuses allocation once the device session is lost and records the invalidation", () => {
    const f = fixture(), pool = new PbrTransientTexturePool(f.session), key = keys();
    runFrame(pool, [{ resourceId: "ao-half", key: key.aoHalf }]);
    f.session.state = "lost";
    pool.invalidateAll("device-lost");
    pool.beginFrame();
    expect(() => pool.acquire(request("ao-half", key.aoHalf))).toThrow(/session is lost/);
    pool.endFrame(false);
    expect(pool.stats.lastInvalidation).toEqual(["device-lost", pool.epoch]);
    expect(pool.epoch).toBe(1);
    expect(f.owned.size).toBe(0);
  });

  it("never returns in-flight textures to the pool after a failed commit", () => {
    const f = fixture(), pool = new PbrTransientTexturePool(f.session), key = keys();
    pool.beginFrame();
    const handle = pool.acquire(request("oit-accumulation", key.oit));
    pool.release(handle);
    pool.endFrame(false); // pass encode throw → 提交失败,本帧纹理全部作废
    expect(handle.texture.destroy).toHaveBeenCalledOnce();
    expect(pool.stats.discardedCount).toBe(1);
    pool.beginFrame();
    const retry = pool.acquire(request("oit-accumulation", key.oit));
    expect(retry.texture).not.toBe(handle.texture);
    expect(retry.texture.destroy).not.toHaveBeenCalled();
    expect(pool.stats).toMatchObject({ hits: 0, misses: 2 });
    pool.release(retry);
    pool.endFrame(true);
    expect(f.textures).toHaveLength(2);
  });

  it("keeps overlapping same-key lifetimes apart within one frame", () => {
    const f = fixture(), pool = new PbrTransientTexturePool(f.session), key = keys();
    pool.beginFrame();
    const first = pool.acquire(request("ao-half", key.aoHalf));
    pool.release(first);
    const second = pool.acquire(request("ao-half", key.aoHalf));
    expect(second.texture).not.toBe(first.texture);
    pool.release(second);
    expect(() => pool.release(first)).toThrow(/released twice/);
    pool.endFrame(true);
    expect(pool.stats).toMatchObject({ acquireCount: 2, hits: 0, misses: 2 });
  });

  it("enforces the explicit queue-lifecycle contract on scope misuse", () => {
    const f = fixture(), pool = new PbrTransientTexturePool(f.session), key = keys();
    expect(() => pool.acquire(request("ao-half", key.aoHalf))).toThrow(/open frame scope/);
    pool.beginFrame();
    expect(() => pool.beginFrame()).toThrow(/already open/);
    expect(() => pool.release({ texture: {} as GPUTexture, view: {} as GPUTextureView, key: key.aoHalf,
      resourceId: "ao-half" })).toThrow(/does not belong/);
    const leaked = pool.acquire(request("ao-half", key.aoHalf));
    expect(() => pool.endFrame(true)).toThrow(/never released/);
    expect(pool.frameOpen).toBe(true); // 校验先于状态翻转:调用方可修正后重试
    pool.release(leaked);
    pool.endFrame(true);
    expect(pool.frameOpen).toBe(false);
    expect(f.owned.size).toBe(1);
  });

  it("drives allocation count and estimated bytes below the no-pool baseline, including staging peak", () => {
    const f = fixture(), pool = new PbrTransientTexturePool(f.session), key = keys();
    const specs = [
      { resourceId: "ao-half", key: key.aoHalf },
      { resourceId: "oit-accumulation", key: key.oit },
      { resourceId: "oit-revealage", key: key.revealage },
    ];
    for (let frame = 0; frame < 5; frame += 1) runFrame(pool, specs);
    const acquireCount = 5 * specs.length;
    const perFrameBytes = specs.reduce((total, { key: specKey }) =>
      total + transientTextureBytes(specKey.format, specKey.width, specKey.height, specKey.sampleCount), 0);
    const stats = pool.stats;
    expect(stats.acquireCount).toBe(acquireCount);
    expect(stats.misses).toBe(specs.length);
    expect(stats.misses).toBeLessThan(stats.acquireCount);
    expect(stats.allocatedBytes).toBe(perFrameBytes);
    expect(stats.allocatedBytes).toBeLessThan(5 * perFrameBytes);
    expect(stats.reusedBytes).toBe(perFrameBytes * 4);
    expect(stats.peakResidentBytes).toBe(perFrameBytes);
    expect(stats.freeBytes).toBe(perFrameBytes);
    expect(f.textures).toHaveLength(specs.length);
  });

  it("keeps concurrent pool instances per device session fully isolated", () => {
    const a = fixture(), b = fixture(), key = keys();
    const poolA = new PbrTransientTexturePool(a.session as unknown as DeviceSession);
    const poolB = new PbrTransientTexturePool(b.session as unknown as DeviceSession);
    runFrame(poolA, [{ resourceId: "ao-half", key: key.aoHalf }]);
    runFrame(poolB, [{ resourceId: "ao-half", key: key.aoHalf }]);
    expect(a.textures[0]).not.toBe(b.textures[0]);
    poolA.invalidateAll("surface-resize");
    expect(a.textures[0].destroy).toHaveBeenCalledOnce();
    expect(poolA.stats).toMatchObject({ evictedCount: 1, hits: 0 });
    expect(poolB.stats.evictedCount).toBe(0);
    poolA.beginFrame();
    poolB.beginFrame();
    const fromA = poolA.acquire(request("ao-half", key.aoHalf)); // A 池已清空 → 全新分配
    const fromB = poolB.acquire(request("ao-half", key.aoHalf)); // B 池命中自己的回池纹理
    expect(fromA.texture).not.toBe(fromB.texture);
    expect(fromA.texture).not.toBe(a.textures[0]);
    expect(fromB.texture).toBe(b.textures[0]);
    expect(poolA.stats).toMatchObject({ hits: 0, misses: 2 });
    expect(poolB.stats.hits).toBe(1);
    expect(fromB.texture.destroy).not.toHaveBeenCalled();
    poolA.release(fromA);
    poolA.endFrame(true);
    poolB.release(fromB);
    poolB.endFrame(true);
    expect(a.owned.size).toBe(1);
    expect(b.owned.size).toBe(1);
  });
});
