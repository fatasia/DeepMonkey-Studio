// F3/T06 虚拟纹理 probe 会话与驱动职责(sourceSizeGate 拆分:自 f3VirtualTextureGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:离屏会话、设备收口、bridge 构造、相机代理条目、驻留页集读取、settle 驱动。
import { DeviceSession } from "../src/webgpu/deviceSession.js";
import {
  createVirtualTextureFrameBridge,
  type VirtualTextureFeedbackEntry,
  type VirtualTextureFrameBridge,
  type VirtualTextureFrameMetrics,
  type VirtualTextureSampleRequest,
} from "../src/webgpu/virtualTextureFrameBridge.js";

export const TEXTURE_ID = "vt-evidence";
export const TEXTURE_SIZE = 1024;
export const TILE_EDGE = 128;
export const GRID = TEXTURE_SIZE / TILE_EDGE; // 8×8 = 64 tile/链/mip
export const PAGE_BYTES = TILE_EDGE * TILE_EDGE * 4; // 65536

/** 离屏 canvas 真机会话(照 clusterLightCullingGpuProbe 先例);附带设备错误收集。 */
export async function openF3Session(): Promise<{
  session: DeviceSession; adapter: unknown; deviceErrors: string[];
}> {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const canvas = document.createElement("canvas");
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const deviceErrors: string[] = [];
  session.device.addEventListener("uncapturederror", (event: Event) => {
    const error = (event as GPUUncapturedErrorEvent).error;
    deviceErrors.push(String(error?.message ?? String(error)));
  });
  const info = adapter.info;
  return { session, adapter: info ? { vendor: info.vendor, architecture: info.architecture,
    device: info.device, description: info.description } : {}, deviceErrors };
}

/** 微任务排空 + 队列收口(上传错误作用域 settle 依赖)。 */
export async function settleDevice(session: DeviceSession): Promise<void> {
  for (let index = 0; index < 32; index++) await Promise.resolve();
  await session.device.queue.onSubmittedWorkDone();
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

export function makeBridge(session: DeviceSession, maxResidentBytes: number,
  maxUploadPagesPerFrame: number): VirtualTextureFrameBridge {
  const bridge = createVirtualTextureFrameBridge(session, {
    enabled: true, maxResidentBytes, tileEdgeTexels: TILE_EDGE, maxUploadPagesPerFrame,
  });
  if (!bridge) throw new Error("virtual texture bridge failed to resolve enabled options.");
  return bridge;
}

/** 相机代理条目:一个可见 draw 占一个 tile 的中心小 UV 域,screenPixels 取足够大锁 mip0
 *  (wantedMip: ρ=域纹素/屏幕像素<2 → floor(log2ρ/2)=0)。A=近观,B=远观由 tile 集表达。 */
export function tileEntries(tiles: readonly (readonly [number, number])[]): VirtualTextureFeedbackEntry[] {
  return tiles.map(([tileX, tileY]) => ({
    textureId: TEXTURE_ID,
    uvMinX: (tileX + 0.4) / GRID, uvMaxX: (tileX + 0.6) / GRID,
    uvMinY: (tileY + 0.4) / GRID, uvMaxY: (tileY + 0.6) / GRID,
    screenPixels: 4096,
  }));
}

/** 全覆盖条目:整 UV 域 × 1080p 像素数 → 全 64 tile、mip0(ρ=1048576/2073600<1)。 */
export function fullCoverageEntries(): VirtualTextureFeedbackEntry[] {
  return [{ textureId: TEXTURE_ID, uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels: 1920 * 1080 }];
}

export function tileSet(from: number, to: number): readonly (readonly [number, number])[] {
  const tiles: [number, number][] = [];
  for (let tileY = from; tileY < to; tileY++)
    for (let tileX = from; tileX < to; tileX++) tiles.push([tileX, tileY]);
  return tiles;
}

export function pageDefined(bridge: VirtualTextureFrameBridge, tileX: number, tileY: number, mip: number): boolean {
  return bridge.layerOfPage(TEXTURE_ID, tileX, tileY, mip) !== undefined;
}

/** 提交态驻留页集(catalog × mipGrids × layerOfPage;in-flight 按未定义计,与打包口径一致)。 */
export function committedResidentPages(bridge: VirtualTextureFrameBridge): string[] {
  const ids: string[] = [];
  for (const entry of bridge.textureCatalog()) {
    for (let mip = 0; mip < entry.chainMips; mip++) {
      const grid = entry.mipGrids[mip]!;
      for (let tileY = 0; tileY < grid.gridHeight; tileY++)
        for (let tileX = 0; tileX < grid.gridWidth; tileX++)
          if (bridge.layerOfPage(entry.textureId, tileX, tileY, mip) !== undefined)
            ids.push(`${entry.textureId}|${tileX},${tileY}|mip${mip}`);
    }
  }
  return ids.sort();
}

export interface DriveOutcome {
  readonly frames: readonly VirtualTextureFrameMetrics[];
  readonly settled: boolean;
}

/** 逐帧推进直至 backlog 归零且期望页全部可采样(提交态);帧号单调由 bridge.tick 保证。 */
export async function driveToSettled(session: DeviceSession, bridge: VirtualTextureFrameBridge,
  entries: readonly VirtualTextureFeedbackEntry[],
  expectedTiles?: readonly (readonly [number, number])[]): Promise<DriveOutcome> {
  const frames: VirtualTextureFrameMetrics[] = [];
  for (let attempt = 0; attempt < 160; attempt++) {
    const metrics = bridge.observeFrame(entries);
    frames.push(metrics);
    await settleDevice(session);
    if (metrics.uploadBacklog === 0) {
      const ready = expectedTiles === undefined
        || expectedTiles.every(([tileX, tileY]) => pageDefined(bridge, tileX, tileY, 0));
      if (ready) return { frames, settled: true };
    }
  }
  return { frames, settled: false };
}

/** tile 中心采样集(与生产 sampleRequestsFrom 同布局:u=(tx+0.5)/grid, mip 0)。 */
export function tileCenterSamples(tiles: readonly (readonly [number, number])[]): VirtualTextureSampleRequest[] {
  return tiles.map(([tileX, tileY]) => ({ textureIndex: 0,
    u: (tileX + 0.5) / GRID, v: (tileY + 0.5) / GRID, mip: 0 }));
}
