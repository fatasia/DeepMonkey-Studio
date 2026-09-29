import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareTextures } from "../textures/decodedTexture.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import { createSyntheticRgba8, generateVirtualTexturePages } from "../virtualTextures/virtualTexturePages.js";
import { resolveVirtualTextureOptions } from "../virtualTextures/virtualTextureOptions.js";
import type { DeviceSession } from "./deviceSession.js";
import { VirtualTextureAtlasResidency } from "./virtualTextureResidency.js";
import { createVirtualTextureFrameBridge, virtualTextureUvBounds,
  VirtualTextureFrameBridge } from "./virtualTextureFrameBridge.js";

/**
 * F4 虚拟纹理帧桥:页按需切取与离线 paginatePreparedTexture 逐字节一致(同源锁定)、
 * 目录同步(新增/换版重建/移除释放/压缩纹理拒收)、反馈→驻留推进遥测、采样请求
 * bounded、fail-closed(dispose 拒绝)。GPU 走 mock session(照 residency 测试先例)。
 */

const SPEC = { tileEdgeTexels: 64, bytesPerTexel: 4 } as const;

function fixture() {
  const owned = new Set<{ destroy(): void }>();
  const writeTexture = vi.fn();
  const device = { lost: new Promise<void>(() => {}), features: new Set<GPUFeatureName>(),
    limits: { maxTextureDimension2D: 16384, maxTextureArrayLayers: 2048 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createTexture: vi.fn(() => ({ destroy: vi.fn(), createView: vi.fn(() => ({})) })),
    createSampler: vi.fn(() => ({})),
    queue: { writeTexture, writeBuffer: vi.fn() } };
  const session = { state: "ready", device,
    own: <T extends { destroy(): void }>(resource: T): T => { owned.add(resource); return resource; },
    release: (resource: { destroy(): void }) => { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  return { session, writeTexture, async settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); } };
}

function texture(id: string, revision = 0, withMipmaps = false): DecodedTexture {
  const source = createSyntheticRgba8(id, 64, 64, 3);
  if (!withMipmaps) return { ...source, revision };
  const mipmap = (level: { width: number; height: number; data: Uint8Array<ArrayBuffer> }) =>
    ({ width: Math.max(1, level.width >> 1), height: Math.max(1, level.height >> 1),
      data: new Uint8Array(Math.max(1, (level.width >> 1) * (level.height >> 1)) * 4).fill(7) });
  const l1 = mipmap(source), l2 = mipmap(l1);
  return { ...source, revision, mipmaps: [l1, l2, mipmap(l2), mipmap(mipmap(l2)!), mipmap(mipmap(mipmap(l2)!)!)] };
}

const ENTRY = (textureId: string, screenPixels = 10_000) =>
  ({ textureId, uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels });

beforeEach(() => vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 }));
afterEach(() => vi.unstubAllGlobals());

describe("VirtualTextureFrameBridge", () => {
  it("按需切页与离线 paginatePreparedTexture 逐字节一致(无宿主 mipmaps,box 链路径)", async () => {
    const f = fixture();
    const bridge = createVirtualTextureFrameBridge(f.session, { enabled: true, maxResidentBytes: 1 << 20 })!;
    bridge.syncTextures([texture("t")]);
    // screenPixels=1 → ρ=4096 → 请求 mip6 全链;离线页表与 bridge 同 tile(默认 128)对齐。
    bridge.observeFrame([{ textureId: "t", uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels: 1 }]);
    await f.settle();
    const offline = generateVirtualTexturePages(texture("t"), { tileEdgeTexels: 128, bytesPerTexel: 4 });
    // 64×64 纹理 @ tile 64:grid 1×1,全链 7 页全部上传;上传缓冲按内容多重集与离线
    // 页表比对(layer 由 residency 槽位决定,不参与路由)。
    const uploads = f.writeTexture.mock.calls.map(call => ({
      data: call[1] as Uint8Array, bytesPerRow: (call[2] as { bytesPerRow: number }).bytesPerRow,
      edge: (call[2] as { rowsPerImage: number }).rowsPerImage }));
    expect(uploads.length).toBe(7);
    const offlineDigests = new Set([...offline.pageByTile.values()]
      .map(page => Buffer.from(page.data.buffer, page.data.byteOffset, page.costBytes).toString("base64")));
    expect(offlineDigests.size).toBe(7);
    for (const upload of uploads) {
      let compact: Uint8Array;
      if (upload.bytesPerRow === upload.edge * 4) {
        compact = upload.data.subarray(0, upload.edge * upload.edge * 4);
      } else {
        // 深 mip 小页:上传缓冲按 256 对齐行重排,重排回紧凑布局后比对。
        const rawRow = upload.edge * 4;
        compact = new Uint8Array(upload.edge * rawRow);
        for (let row = 0; row < upload.edge; row++) {
          compact.set(upload.data.subarray(row * upload.bytesPerRow, row * upload.bytesPerRow + rawRow), row * rawRow);
        }
      }
      expect(offlineDigests.has(Buffer.from(compact.buffer, compact.byteOffset, compact.byteLength).toString("base64")),
        `uploaded page edge=${upload.edge}`).toBe(true);
    }
    bridge.dispose();
  });

  it("宿主自带 mipmaps 时直用零计算;采样请求取 tile 中心且有界", () => {
    const f = fixture();
    const bridge = createVirtualTextureFrameBridge(f.session, { enabled: true, maxResidentBytes: 1 << 20 })!;
    bridge.syncTextures([texture("t", 0, true)]);
    const metrics = bridge.observeFrame([ENTRY("t")]);
    expect(metrics.enabled).toBe(true);
    expect(metrics.frame).toBe(0);
    expect(metrics.catalogTextures).toBe(1);
    expect(metrics.feedback.footprintCount).toBe(1);
    expect(metrics.atlasBytes).toBeLessThanOrEqual(1 << 20);
    expect(bridge.samples.length).toBeGreaterThan(0);
    expect(bridge.samples.length).toBeLessThanOrEqual(64);
    const catalog = bridge.textureCatalog();
    expect(catalog[0]!.textureId).toBe("t");
    // tile 64:1 + log2(64) = 7 级链(mip0..6,尾页 1×1)。
    expect(catalog[0]!.chainMips).toBe(7);
    expect(catalog[0]!.mipGrids).toHaveLength(7);
    bridge.dispose();
  });

  it("目录同步:换版重建、移除释放驻留、压缩纹理拒收进 droppedUnknownTexture", async () => {
    const f = fixture();
    const bridge = createVirtualTextureFrameBridge(f.session, { enabled: true, maxResidentBytes: 1 << 20 })!;
    bridge.syncTextures([texture("t")]);
    bridge.observeFrame([ENTRY("t")]);
    await f.settle();
    const residentBefore = bridge.metrics!.residentPages;
    expect(residentBefore).toBeGreaterThan(0);
    // 同版再同步:驻留保持(无重建风暴)。
    bridge.syncTextures([texture("t", 0)]);
    expect(bridge.metrics!.residentPages).toBe(residentBefore);
    // 换版:旧驻留释放,目录重建;plan-admitted 记账但未提交 → 缺页不可采样,提交后可采样。
    bridge.syncTextures([texture("t", 1)]);
    const afterRevision = bridge.observeFrame([ENTRY("t")]);
    expect(afterRevision.catalogTextures).toBe(1);
    expect(bridge.layerOfPage("t", 0, 0, 0)).toBeUndefined();
    await f.settle();
    expect(bridge.layerOfPage("t", 0, 0, 0)).toBeDefined();
    // 压缩纹理不入目录(unknown 计数);非法 id 含 '|' 在 entry 校验即拦(invalid 计数)。
    const compressed = { ...texture("c"), compression: "bc7-rgba" as const };
    bridge.syncTextures([texture("t", 1), compressed, { ...texture("bad|id") }]);
    const metrics = bridge.observeFrame([ENTRY("c"), ENTRY("bad|id"), ENTRY("t", 1)]);
    expect(metrics.catalogTextures).toBe(1);
    expect(metrics.feedback.droppedUnknownTexture).toBe(1);
    expect(metrics.feedback.droppedInvalid).toBe(1);
    // 移除:释放驻留(residency 合同=延迟释放:in-flight 页等批次收口后 settleBatch
    // 重试驱逐,故 syncTextures([]) 后须先 settle 让批次落地,驱逐重试才生效)。
    bridge.syncTextures([]);
    await f.settle();
    const removed = bridge.observeFrame([]);
    expect(removed.catalogTextures).toBe(0);
    expect(removed.residentPages).toBe(0);
    bridge.dispose();
  });

  it("驻留时钟独立自增:重复 observeFrame 单调,渲染侧重试帧安全", () => {
    const f = fixture();
    const bridge = createVirtualTextureFrameBridge(f.session, { enabled: true, maxResidentBytes: 1 << 20 })!;
    bridge.syncTextures([texture("t")]);
    bridge.observeFrame([ENTRY("t")]);
    bridge.observeFrame([ENTRY("t")]);
    bridge.observeFrame([ENTRY("t")]);
    expect(bridge.metrics!.frame).toBe(2);
    bridge.dispose();
  });

  it("dispose 后所有 API 显式拒绝;resolve 未启用返回 undefined(默认关门控)", () => {
    const f = fixture();
    const bridge = createVirtualTextureFrameBridge(f.session, { enabled: true, maxResidentBytes: 1 << 20 })!;
    bridge.dispose();
    expect(() => bridge.observeFrame([])).toThrow(/disposed/);
    expect(() => bridge.syncTextures([])).toThrow(/disposed/);
    bridge.dispose();
    expect(createVirtualTextureFrameBridge(f.session, undefined)).toBeUndefined();
    expect(createVirtualTextureFrameBridge(f.session, { enabled: false })).toBeUndefined();
    expect(createVirtualTextureFrameBridge(f.session, { enabled: true, maxResidentBytes: 0 })).toBeUndefined();
    expect(resolveVirtualTextureOptions({}).enabled).toBe(false);
  });

  it("page 越界与坏 id 显式 undefined,不产伪页;layerOfPage 缺页 undefined", async () => {
    const f = fixture();
    const bridge = new VirtualTextureFrameBridge(f.session,
      { ...resolveVirtualTextureOptions({ enabled: true, maxResidentBytes: 1 << 20 }),
        enabled: true } as never);
    bridge.syncTextures([texture("t")]);
    bridge.observeFrame([ENTRY("t")]);
    expect(bridge.layerOfPage("t", 999, 0, 0)).toBeUndefined();
    expect(bridge.layerOfPage("missing", 0, 0, 0)).toBeUndefined();
    bridge.dispose();
  });
});

describe("virtualTextureUvBounds", () => {
  it("恒等/平移/旋转镜像的仿射包围域", () => {
    expect(virtualTextureUvBounds([1, 0, 0, 0, 1, 0])).toEqual({ uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1 });
    expect(virtualTextureUvBounds([1, 0, 0.25, 0, 1, 0.5]))
      .toEqual({ uvMinX: 0.25, uvMinY: 0.5, uvMaxX: 1.25, uvMaxY: 1.5 });
    expect(virtualTextureUvBounds([2, 0, 0, 0, 2, 0]))
      .toEqual({ uvMinX: 0, uvMinY: 0, uvMaxX: 2, uvMaxY: 2 });
    expect(virtualTextureUvBounds([-1, 0, 1, 0, -1, 1]))
      .toEqual({ uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1 });
  });
});

describe("residency integration via bridge", () => {
  it("bridge 驱动的 residency 与直构造行为一致(提交后可采样)", async () => {
    const f = fixture();
    const bridge = createVirtualTextureFrameBridge(f.session, { enabled: true, maxResidentBytes: 1 << 20 })!;
    bridge.syncTextures([texture("t")]);
    const metrics = bridge.observeFrame([ENTRY("t")]);
    await f.settle();
    expect(metrics.uploadsQueued).toBe(1);
    expect(metrics.uploadBacklog).toBe(0);
    expect(bridge.layerOfPage("t", 0, 0, 0)).toBeDefined();
    expect(new VirtualTextureAtlasResidency(f.session, SPEC,
      { maxResidentBytes: 1 << 20 }, () => undefined).advance(0, []).residentPages).toBe(0);
    bridge.dispose();
  });
});
