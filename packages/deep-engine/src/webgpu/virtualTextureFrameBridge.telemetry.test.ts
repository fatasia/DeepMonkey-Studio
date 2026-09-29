import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareTextures } from "../textures/decodedTexture.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import { createSyntheticRgba8 } from "../virtualTextures/virtualTexturePages.js";
import type { DeviceSession } from "./deviceSession.js";
import { createVirtualTextureFrameBridge, type VirtualTextureFrameBridge } from "./virtualTextureFrameBridge.js";

/**
 * F3/T06 虚拟纹理桥遥测增补:页命中/缺失计数(pages + 累计)、反馈不可用显式原因
 * (fail-closed,不静默)、页表打包缓存(packPageTable:稳定帧 O(1) 复用,目录/层
 * 分配变化才重打包)。GPU 走 mock session(照 bridge 测试 fixture 先例);
 * GPU 真机帧时/像素对照留联测,不在本文件口径内。
 */

function fixture() {
  const owned = new Set<{ destroy(): void }>();
  const writeTexture = vi.fn();
  const device = { lost: new Promise<void>(() => {}), features: new Set<GPUFeatureName>(),
    limits: { maxTextureDimension2D: 16384, maxTextureArrayLayers: 2048 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createTexture: vi.fn(() => ({ destroy: vi.fn(), createView: vi.fn(() => ({})) })),
    queue: { writeTexture, writeBuffer: vi.fn() } };
  const session = { state: "ready", device,
    own: <T extends { destroy(): void }>(resource: T): T => { owned.add(resource); return resource; },
    release: (resource: { destroy(): void }) => { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  return { session, writeTexture, async settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); } };
}

function texture(id: string): DecodedTexture {
  return createSyntheticRgba8(id, 64, 64, 3);
}

const ENTRY = (textureId: string, screenPixels = 10_000) =>
  ({ textureId, uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels });

function bridgeOf(session: DeviceSession, maxResidentBytes = 1 << 20): VirtualTextureFrameBridge {
  return createVirtualTextureFrameBridge(session, { enabled: true, maxResidentBytes })!;
}

beforeEach(() => vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 }));
afterEach(() => vi.unstubAllGlobals());

describe("页命中/缺失遥测与反馈不可用显式化", () => {
  it("pages 计数:in-flight 帧计回退整纹理,批次收口后计命中;累计口径同步", async () => {
    const f = fixture();
    const bridge = bridgeOf(f.session);
    bridge.syncTextures([texture("t")]);
    const first = bridge.observeFrame([ENTRY("t")]);
    // 本帧准入仍 in-flight:fail-closed 口径按不可采样计,不是缺陷。
    expect(first.pages).toEqual({ hits: 0, pageFaults: 0, fallbackTextures: 1 });
    await f.settle();
    const second = bridge.observeFrame([ENTRY("t")]);
    expect(second.pages).toEqual({ hits: 1, pageFaults: 0, fallbackTextures: 0 });
    expect(bridge.pageResolveCounts).toEqual({ hits: 1, pageFaults: 0, fallbackTextures: 1 });
    bridge.dispose();
  });

  it("请求 mip 深于驻留深度 → pageFault 计数(合法低 mip 兜底,不伪造可采样页)", async () => {
    const f = fixture();
    // 81920B 预算 → atlasLayers = 1:仅 mip0 可驻留,mip1..6 每帧 deferred。
    const bridge = bridgeOf(f.session, 81_920);
    bridge.syncTextures([texture("t")]);
    // screenPixels=1 → ρ=4096 → 请求 mip6,深于驻留深度 0。
    const deep = { textureId: "t", uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels: 1 };
    expect(bridge.observeFrame([deep]).pages!.fallbackTextures).toBe(1);
    await f.settle();
    expect(bridge.observeFrame([deep]).pages).toEqual({ hits: 0, pageFaults: 1, fallbackTextures: 0 });
    expect(bridge.pageResolveCounts.pageFaults).toBe(1);
    bridge.dispose();
  });

  it("反馈不可用显式原因:no-catalog / all-entries-dropped;合法空(零可见)不标", () => {
    const f = fixture();
    const bridge = bridgeOf(f.session);
    expect(bridge.observeFrame([ENTRY("t")]).feedback.unavailable).toBe("no-catalog");
    bridge.syncTextures([texture("t")]);
    const dropped = bridge.observeFrame([ENTRY("unknown-tex")]);
    expect(dropped.feedback.unavailable).toBe("all-entries-dropped");
    expect(dropped.feedback.droppedUnknownTexture).toBe(1);
    expect(bridge.observeFrame([ENTRY("t")]).feedback.unavailable).toBeUndefined();
    expect(bridge.observeFrame([]).feedback.unavailable).toBeUndefined();
    const invisible = bridge.observeFrame(
      [{ textureId: "t", uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels: 0 }]);
    expect(invisible.feedback.unavailable).toBeUndefined();
    expect(invisible.feedback.droppedInvisible).toBe(1);
    bridge.dispose();
  });
});

describe("页表打包缓存(packPageTable)", () => {
  it("稳定帧 O(1) 复用同一产物;层分配/目录变化才重打包;提交不改层分配仍命中", async () => {
    const f = fixture();
    const bridge = bridgeOf(f.session);
    bridge.syncTextures([texture("t")]);
    const cold = bridge.packPageTable();
    expect(bridge.packPageTable()).toBe(cold);
    expect(bridge.pageRepackCount).toBe(1);
    bridge.observeFrame([ENTRY("t")]);
    const afterFrame = bridge.packPageTable();
    expect(afterFrame).not.toBe(cold);
    expect(afterFrame.epoch).toBeGreaterThan(cold.epoch);
    expect(bridge.pageRepackCount).toBe(2);
    await f.settle();
    expect(bridge.packPageTable()).toBe(afterFrame);
    expect(bridge.pageRepackCount).toBe(2);
    // 目录变化(新纹理入目录)→ 失效重打包。
    bridge.syncTextures([texture("t"), texture("u")]);
    expect(bridge.packPageTable().epoch).toBeGreaterThan(afterFrame.epoch);
    bridge.dispose();
    expect(() => bridge.packPageTable()).toThrow(/disposed/);
  });

  it("打包内容:params 样本数占位 0 由消费方覆盖;未提交页显式 -1,不伪造映射", async () => {
    const f = fixture();
    const bridge = bridgeOf(f.session);
    bridge.syncTextures([texture("t")]);
    bridge.observeFrame([ENTRY("t")]);
    await f.settle();
    const { data, epoch } = bridge.packPageTable();
    expect(epoch).toBeGreaterThanOrEqual(0);
    // [样本数占位 0, 纹理数 1, 链长 7, atlasEdge 128]。
    expect([...data.params]).toEqual([0, 1, 7, 128]);
    expect(data.pageLayers[0]).toBeGreaterThanOrEqual(0);
    expect([...data.pageLayers.slice(1)]).toEqual([-1, -1, -1, -1, -1, -1]);
    bridge.dispose();
  });

  it("fallback 态显式拒绝打包(采样方走整纹理路径),与 pageTable 同语义", () => {
    const f = fixture();
    (f.session as { state: string }).state = "loading";
    const bridge = bridgeOf(f.session);
    bridge.syncTextures([texture("t")]);
    const metrics = bridge.observeFrame([ENTRY("t")]);
    expect(metrics.fallbackActive).toBe(true);
    expect(metrics.pages).toBeUndefined();
    expect(() => bridge.packPageTable()).toThrow(/fallback/);
    bridge.dispose();
  });
});
