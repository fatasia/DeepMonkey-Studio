import { describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PbrTransientTexturePool, transientTextureBytes } from "./pbrTransientTexturePool.js";

function fixture(budget = 32) {
  const textures: GPUTexture[] = [];
  const createTexture = vi.fn(() => {
    const texture = { createView: vi.fn(() => ({})), destroy: vi.fn() } as unknown as GPUTexture;
    textures.push(texture); return texture;
  });
  const session = { state: "ready", device: { createTexture }, own: (texture: GPUTexture) => texture,
    release: (texture: GPUTexture) => texture.destroy() } as unknown as DeviceSession;
  return { pool: new PbrTransientTexturePool(session, budget), textures, createTexture };
}
const request = (width: number) => ({ resourceId: "scratch", format: "rgba8unorm" as const,
  width, height: 1, sampleCount: 1, usage: 1 });
function frame(pool: PbrTransientTexturePool, width: number) {
  pool.beginFrame(); const handle = pool.acquire(request(width)); pool.release(handle); pool.endFrame(true);
  return handle;
}

describe("transient texture resident budget", () => {
  it("evicts the oldest free frame first and never exceeds its finite budget", () => {
    const { pool, textures } = fixture();
    frame(pool, 2); frame(pool, 3); frame(pool, 4);
    expect(textures[0].destroy).toHaveBeenCalledOnce();
    expect(textures[1].destroy).not.toHaveBeenCalled();
    expect(pool.stats).toMatchObject({ residentBytes: 28, peakResidentBytes: 28, budgetBytes: 32,
      budgetEvictedBytes: 8, evictedCount: 1 });
    const warm = frame(pool, 3);
    expect(warm.texture).toBe(textures[1]);
    pool.dispose(); expect(pool.stats.residentBytes).toBe(0);
  });

  it("rejects an impossible frame without destroying free or pending-submit resources", () => {
    const { pool, textures, createTexture } = fixture();
    frame(pool, 2);
    pool.beginFrame(); const busy = pool.acquire(request(6)); pool.release(busy);
    expect(() => pool.acquire(request(3))).toThrow(/24 busy.*12 requested/);
    expect(createTexture).toHaveBeenCalledTimes(2);
    for (const texture of textures) expect(texture.destroy).not.toHaveBeenCalled();
    expect(pool.stats).toMatchObject({ residentBytes: 32, budgetRejectedCount: 1, budgetEvictedBytes: 0 });
    pool.endFrame(false);
    expect(pool.stats.residentBytes).toBe(8);
    expect(frame(pool, 2).texture).toBe(textures[0]);
    frame(pool, 6); expect(pool.stats.residentBytes).toBe(32);
  });

  it("rejects oversized requests before any GPU call, then recovers after resize", () => {
    const { pool, createTexture } = fixture();
    pool.beginFrame(); expect(() => pool.acquire(request(9))).toThrow(/budget exceeded/);
    pool.endFrame(false); expect(createTexture).not.toHaveBeenCalled();
    frame(pool, 8); pool.invalidateAll("surface-resize");
    expect(pool.stats.residentBytes).toBe(0);
    frame(pool, 8); expect(createTexture).toHaveBeenCalledTimes(2);
    expect(pool.stats.peakResidentBytes).toBe(32);
  });

  it("does not count failed allocations or views as resident bytes", () => {
    const { pool, createTexture, textures } = fixture();
    createTexture.mockImplementationOnce(() => { throw new Error("allocation failed"); });
    pool.beginFrame(); expect(() => pool.acquire(request(4))).toThrow(/allocation failed/);
    expect(pool.stats).toMatchObject({ residentBytes: 0, allocatedBytes: 0, misses: 0 });
    createTexture.mockImplementationOnce(() => {
      const texture = { createView() { throw new Error("view failed"); }, destroy: vi.fn() } as unknown as GPUTexture;
      textures.push(texture); return texture;
    });
    expect(() => pool.acquire(request(4))).toThrow(/view failed/);
    expect(textures[0].destroy).toHaveBeenCalledOnce();
    expect(pool.stats.residentBytes).toBe(0); pool.endFrame(false);
    frame(pool, 8); expect(pool.stats.residentBytes).toBe(32);
  });

  it("rejects invalid budgets and overflow estimates", () => {
    for (const budget of [0, -1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => fixture(budget)).toThrow(/positive safe integer/);
    }
    expect(() => transientTextureBytes("rgba32float", Number.MAX_SAFE_INTEGER, 2, 4)).toThrow(/safe integer/);
  });
});
