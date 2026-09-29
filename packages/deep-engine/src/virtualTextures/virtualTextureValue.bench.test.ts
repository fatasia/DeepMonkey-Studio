import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVirtualTextureSample } from "./virtualTextureDiagnostics.js";
import type { VirtualTextureFootprint } from "./virtualTextureRequests.js";
import { DEFAULT_VIRTUAL_TEXTURE_TILE, boxDownsampleRgba8, createSyntheticRgba8,
  paginatePreparedTexture } from "./virtualTexturePages.js";
import type { VirtualTexturePage } from "./virtualTexturePages.js";
import { prepareTextures } from "../textures/decodedTexture.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { packVirtualTexturePageTable, VirtualTexturePageTablePacker } from "../webgpu/virtualTexturePagePacking.js";
import { VirtualTextureAtlasResidency } from "../webgpu/virtualTextureResidency.js";

/**
 * F3 价值量化(CPU 可证伪口径;证据写 test-output/deep-core/F3-virtual-texture/)。
 *
 * A. 显存对照:32 张 4K² RGBA8 全 mip 链(解析账本,精确算术)vs 虚拟化
 *    atlasBytes(由 maxResidentBytes 推导的硬预算);真实 4K 页化提供机制实证。
 * B. 命中率收敛:4K 单纹理相机 pan→freeze,采样反馈命中与换页收敛断言。
 * C. 帧时开销:advance 全链(反馈→请求→plan→上传排队)逐帧耗时 P50/P95,
 *    与空反馈基线对照——CPU 策略口径,GPU 帧时与 SSIM 留真机联测(如实声明)。
 */

const CHAIN_FRACTION = 4 / 3;
const WIDTH = 4096, HEIGHT = 4096, TEXTURE_COUNT = 32;
const BUDGET_BYTES = 16 * 1024 * 1024;
// pan 场景:144 tile × mip0..2 共 432 页,层帽(atlasLayers = budget/64KB)须容下冻结窗
// 工作集并留余量,否则深链被层帽截断(层级 atlas 对深链的真实约束,如实计入账本)。
const PAN_BUDGET_BYTES = 480 * 64 * 1024;
const WINDOW = 12, PAN_FRAMES = 240, FREEZE_FRAMES = 48;
const evidence: Record<string, unknown> = {
  honesty: { gpuFrameTimeMs: null, ssim: "pending-device-integration (F4 tie-in lane)" } };

function mockSession(): DeviceSession {
  const device = { limits: { maxTextureDimension2D: 16384, maxTextureArrayLayers: 2048 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createTexture: vi.fn(() => ({ destroy: vi.fn(), createView: vi.fn(() => ({})) })),
    queue: { writeTexture: vi.fn(), writeBuffer: vi.fn() } };
  return { state: "ready", device, own: (r: unknown) => r, release: () => {} } as unknown as DeviceSession;
}
function residencyFor(budget: number,
  pageOf: (id: string) => VirtualTexturePage | undefined): VirtualTextureAtlasResidency {
  return new VirtualTextureAtlasResidency(mockSession(), DEFAULT_VIRTUAL_TEXTURE_TILE,
    { maxResidentBytes: budget, maxUploadPagesPerFrame: 512 }, pageOf);
}
async function settle(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve(); }
const windowTiles = (originX: number, originY: number, textureId: string, maxMip: number,
  window = WINDOW): VirtualTextureFootprint[] => {
  const footprints: VirtualTextureFootprint[] = [];
  for (let y = originY; y < originY + window; y++) for (let x = originX; x < originX + window; x++) {
    footprints.push({ textureId, tileX: x, tileY: y, maxMip, weight: 1 });
  }
  return footprints;
};
const panOrigin = (frame: number, span: number): number => {
  const cycle = frame % (2 * span);
  return cycle < span ? cycle : 2 * span - cycle;
};
const percentile = (samples: number[], q: number): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

describe("F3 virtual texture value evidence", () => {
  beforeEach(() => vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 }));
  afterEach(() => vi.unstubAllGlobals());

  it("A. 显存对照:32×4K² 全链 vs 16MiB 硬预算(解析账本,量级下降如实报)", () => {
    const mip0Bytes = WIDTH * HEIGHT * 4;
    const fullChainPerTexture = Math.round(mip0Bytes * CHAIN_FRACTION);
    const fullTotal = fullChainPerTexture * TEXTURE_COUNT;
    const atlasLayers = Math.floor(BUDGET_BYTES / (128 * 128 * 4));
    const atlasBytes = atlasLayers * 128 * 128 * 4;
    evidence.memoryLedger = { textures: TEXTURE_COUNT, width: WIDTH, height: HEIGHT,
      mip0BytesPerTexture: mip0Bytes, fullChainBytesPerTexture: fullChainPerTexture,
      fullResidentBytesTotal: fullTotal, virtualBudgetBytes: BUDGET_BYTES,
      atlasBytes, atlasLayers, reductionRatio: Math.round(fullTotal / atlasBytes),
      panBudgetBytes: PAN_BUDGET_BYTES,
      panAtlasLayers: Math.floor(PAN_BUDGET_BYTES / (128 * 128 * 4)),
      reductionRatioPanBudget: Math.round(fullTotal / PAN_BUDGET_BYTES) };
    expect(atlasBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(fullTotal / atlasBytes).toBeGreaterThan(100);
  });

  it("B+C. 4K 单纹理 pan→freeze:命中率与换页收敛 + 帧时 P50/P95(CPU 策略口径)", async () => {
    const source = createSyntheticRgba8("k", WIDTH, HEIGHT, 11);
    const levels = [source];
    while (levels.length < 13) levels.push(boxDownsampleRgba8(levels[levels.length - 1]!));
    const pages = paginatePreparedTexture(
      prepareTextures([{ ...source, mipmaps: levels.slice(1) }])[0]!, DEFAULT_VIRTUAL_TEXTURE_TILE);
    expect(pages.gridX).toBe(32);
    const r = residencyFor(PAN_BUDGET_BYTES, id => pages.pageByTile.get(id));
    const baseline = residencyFor(PAN_BUDGET_BYTES, () => undefined);
    const span = pages.gridX - WINDOW - 8, freezeStart = PAN_FRAMES - FREEZE_FRAMES;
    const hitRates: number[] = [], swaps: number[] = [], advanceMs: number[] = [], idleMs: number[] = [];
    let lastQueued = 0, lastEvictions = 0;
    for (let frame = 0; frame < PAN_FRAMES; frame++) {
      const originX = 8 + panOrigin(frame < freezeStart ? frame : freezeStart, span);
      const footprints = windowTiles(originX, 8, "k", 2);
      const started = performance.now();
      const telemetry = r.advance(frame, footprints);
      advanceMs.push(performance.now() - started);
      const idleStarted = performance.now();
      baseline.advance(frame, []);
      idleMs.push(performance.now() - idleStarted);
      // totals 为累计口径,换页取逐帧差分。
      swaps.push(telemetry.uploadsQueued - lastQueued + telemetry.evictions - lastEvictions);
      lastQueued = telemetry.uploadsQueued; lastEvictions = telemetry.evictions;
      await settle();
      // 采样解析在批次收口后测量:in-flight 页不可采样(fail-closed 语义)。
      let hits = 0;
      for (const footprint of footprints) {
        if (resolveVirtualTextureSample(r.pageTable, footprint.textureId, footprint.tileX,
          footprint.tileY, footprint.maxMip).status === "resident") hits += 1;
      }
      hitRates.push(hits / footprints.length);
    }
    const tailSwaps = swaps.slice(-16), tailHits = hitRates.slice(-16);
    const converged = tailSwaps.every(value => value === 0) && tailHits.every(value => value >= 0.99);
    evidence.pan = { frames: PAN_FRAMES, window: WINDOW, budgetBytes: PAN_BUDGET_BYTES, gridX: pages.gridX,
      chainMips: pages.chainMips, hitRateFirst8: hitRates.slice(0, 8).map(round3),
      hitRateLast16: tailHits.map(round3), swapsLast16: tailSwaps, converged,
      residentBytesEnd: r.pageTable.residentByteCount,
      note: "PAN budget sized to the atlas layer cap for the freeze-window working set"
        + " (144 tiles x mip0..2 = 432 pages, 480 layers with headroom);"
        + " deep chains cost one 64KiB layer per page." };
    evidence.frameTime = { advanceP50Ms: round3(percentile(advanceMs, 0.5)),
      advanceP95Ms: round3(percentile(advanceMs, 0.95)),
      advanceMeanMs: round3(advanceMs.reduce((a, b) => a + b, 0) / advanceMs.length),
      idleBaselineP50Ms: round3(percentile(idleMs, 0.5)),
      note: "CPU policy cost per frame (feedback→requests→plan→upload queue), mock GPU upload" };
    expect(converged).toBe(true);
    expect(r.pageTable.residentByteCount).toBeLessThanOrEqual(PAN_BUDGET_BYTES);
  }, 240_000);

  it("C. 多纹理竞争:16×1K²(共享页集省 CPU 内存,策略独立),预算内冻结收敛", async () => {
    const source = createSyntheticRgba8("c", 1024, 1024, 5);
    const levels = [source];
    while (levels.length < 11) levels.push(boxDownsampleRgba8(levels[levels.length - 1]!));
    const pages = paginatePreparedTexture(
      prepareTextures([{ ...source, mipmaps: levels.slice(1) }])[0]!, DEFAULT_VIRTUAL_TEXTURE_TILE);
    const pageOf = new Map<string, VirtualTexturePage>();
    for (const [id, page] of pages.pageByTile) {
      const [, tile, mip] = id.split("|");
      for (let texture = 0; texture < 16; texture++) pageOf.set(`c${texture}|${tile}|${mip}`, page);
    }
    const budget = 2 * 1024 * 1024;
    const residents = Array.from({ length: 16 }, (_, texture) =>
      residencyFor(budget, id => pageOf.get(id)));
    const swaps: number[] = [];
    let lastQueued = 0, lastEvictions = 0;
    for (let frame = 0; frame < 96; frame++) {
      const focus = frame < 64 ? frame % 16 : 7;
      const telemetry = residents[focus]!.advance(frame, windowTiles(2, 2, `c${focus}`, 1, 4));
      swaps.push(telemetry.uploadsQueued - lastQueued + telemetry.evictions - lastEvictions);
      lastQueued = telemetry.uploadsQueued; lastEvictions = telemetry.evictions;
      expect(telemetry.residentBytes).toBeLessThanOrEqual(budget);
      await settle();
    }
    evidence.competition = { textures: 16, textureSize: 1024, budgetBytesEach: budget,
      note: "16 textures share one 1024² page set (CPU memory only); per-texture independent policy",
      swapsLast16: swaps.slice(-16), converged: swaps.slice(-16).every(value => value === 0) };
    expect(evidence.competition.converged).toBe(true);
  }, 120_000);

  it("D. CPU 页表更新前后对照:全量重打包 vs epoch 缓存命中(CPU 口径,GPU 未测)", () => {
    // 8 纹理 × 4 mip(页表 320 项)的目录规模:打包循环量与重写字节按此账本。
    const catalog = Array.from({ length: 8 }, (_, texture) => ({ textureId: `t${texture}`, chainMips: 4,
      mipGrids: [
        { gridWidth: 16, gridHeight: 16, levelWidth: 1024, levelHeight: 1024 },
        { gridWidth: 16, gridHeight: 16, levelWidth: 512, levelHeight: 512 },
        { gridWidth: 4, gridHeight: 4, levelWidth: 256, levelHeight: 256 },
        { gridWidth: 4, gridHeight: 4, levelWidth: 128, levelHeight: 128 }] }));
    const layerOfPage = () => 3;
    // 前路径:每帧全量重打包(现状缺省行为)。
    const fullMs: number[] = [];
    for (let frame = 0; frame < 64; frame++) {
      const started = performance.now();
      packVirtualTexturePageTable(catalog, layerOfPage, [], 128);
      fullMs.push(performance.now() - started);
    }
    // 后路径:packer 以 (catalogEpoch, layerEpoch) 缓存,稳定帧 O(1) 复用。
    const packer = new VirtualTexturePageTablePacker(() => catalog, layerOfPage, 128);
    packer.pack(0, 0);
    const cachedMs: number[] = [];
    let packed = packer.pack(0, 0);
    for (let frame = 0; frame < 64; frame++) {
      const started = performance.now();
      packed = packer.pack(0, 0);
      cachedMs.push(performance.now() - started);
    }
    // 稳定帧省去的 GPU 上行重写字节(meta+layers;params 16B 与 samples 仍逐帧写)。
    const stableFrameRewriteBytesSaved = packed.data.mipMeta.byteLength + packed.data.pageLayers.byteLength;
    evidence.pageTableUpdate = { catalogTextures: catalog.length, pageTableEntries: packed.data.pageLayers.length,
      fullRepackP50Ms: round3(percentile(fullMs, 0.5)), fullRepackP95Ms: round3(percentile(fullMs, 0.95)),
      cachedEpochHitP50Ms: round3(percentile(cachedMs, 0.5)), cachedEpochHitP95Ms: round3(percentile(cachedMs, 0.95)),
      stableFrameRewriteBytesSaved, repackCountOver65Frames: packer.repackCount,
      note: "CPU packing cost per frame (mock-free, pure JS); GPU device frame time unmeasured,"
        + " device tie-in listed in the F3 integration checklist" };
    // 确定性断言(时延数字只入证据不做阈值,避免计时抖动假红):
    // 65 帧稳定视角仅 1 次重打包;命中返回同一产物(O(1));params 样本数占位 0。
    expect(packer.repackCount).toBe(1);
    expect(packer.pack(0, 0)).toBe(packed);
    expect(packed.data.params[0]).toBe(0);
  }, 60_000);

  it("写入证据 JSON", () => {
    const dir = join(process.cwd(), "test-output", "deep-core", "F3-virtual-texture");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "benchmark.json"), JSON.stringify({ generatedAt: new Date().toISOString(),
      ...evidence }, null, 2));
  });
});

function round3(value: number): number { return Math.round(value * 1000) / 1000; }
