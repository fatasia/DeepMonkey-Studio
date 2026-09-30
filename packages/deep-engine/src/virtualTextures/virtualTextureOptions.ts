import { DEFAULT_VIRTUAL_TEXTURE_TILE, type VirtualTextureTileSpec } from "./virtualTexturePages.js";

/**
 * F3 虚拟纹理 opt-in 契约与 fail-closed 解析。
 *
 * 默认不带 `enabled` 即零行为变化(整纹理 LOD 驻留保持权威路径)。启用但配置
 * 非法时解析结果显式 `enabled:false` + 原因(照 pbrAutoExposure 的 fail-closed
 * 回退先例:渲染循环必须存活,不抛、不静默),宿主把 reason 记入遥测。
 * 接线点(F4 主线 lane 落地):`PbrRendererOptions.virtualTextures?: VirtualTextureOptions`
 * ——照 contactShadows 的 import 类型字段先例,本模块不触碰 pbrRendererTypes.ts。
 */

export interface VirtualTextureOptions {
  /** opt-in 总开关;缺省 false = 不构造任何资源、零行为变化。 */
  readonly enabled?: boolean;
  /** 页驻留硬字节预算(页表 + atlas 同一账本);启用时必填且为正。 */
  readonly maxResidentBytes?: number;
  /** 驻留页数上限(可选,与字节预算同时生效)。 */
  readonly maxPages?: number;
  /** 页边长(纹素,2 的幂);缺省 128(默认 tile 规格)。 */
  readonly tileEdgeTexels?: number;
  /** 单帧最大上传页数(上传帧预算,超出顺延 backlog);缺省 16。 */
  readonly maxUploadPagesPerFrame?: number;
  /** 驻留保护帧数(防抖动 dwell);缺省 0 = 无保护。 */
  readonly minResidentFrames?: number;
  /** Injected monotonic frame clock for advanceMs telemetry; runtime modules
   * never touch host globals (the production renderer injects performance.now). */
  readonly frameClock?: () => number;
}

export type ResolvedVirtualTextureOptions =
  | { readonly enabled: false; readonly reason: string }
  | {
    readonly enabled: true;
    readonly maxResidentBytes: number;
    readonly maxPages?: number;
    readonly spec: VirtualTextureTileSpec;
    readonly maxUploadPagesPerFrame: number;
    readonly minResidentFrames: number;
    readonly frameClock?: () => number;
  };

/** 缺省值出处:128 MiB 覆盖 ~2048 张 128² RGBA8 页,单张 4K² 纹理全链的 ~1.4 倍。 */
export const DEFAULT_VIRTUAL_TEXTURE_RESIDENT_BYTES = 134_217_728;
export const DEFAULT_VIRTUAL_TEXTURE_UPLOAD_PAGES_PER_FRAME = 16;

const MAX_TILE_EDGE = 4096, MAX_DWELL = 4096;

/** 非法配置显式 fail-closed 回 `{ enabled:false, reason }`,不抛(渲染循环存活先例)。 */
export function resolveVirtualTextureOptions(options: VirtualTextureOptions = {}): ResolvedVirtualTextureOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return { enabled: false, reason: "virtual-texture:options-not-an-object" };
  }
  if (options.enabled !== true) return { enabled: false, reason: "virtual-texture:not-enabled" };
  const spec: VirtualTextureTileSpec = {
    tileEdgeTexels: options.tileEdgeTexels ?? DEFAULT_VIRTUAL_TEXTURE_TILE.tileEdgeTexels,
    bytesPerTexel: DEFAULT_VIRTUAL_TEXTURE_TILE.bytesPerTexel,
  };
  if (!Number.isSafeInteger(spec.tileEdgeTexels) || spec.tileEdgeTexels < 1
    || spec.tileEdgeTexels > MAX_TILE_EDGE || (spec.tileEdgeTexels & (spec.tileEdgeTexels - 1)) !== 0) {
    return { enabled: false, reason: "virtual-texture:tile-edge-must-be-power-of-two-1..4096" };
  }
  if (!Number.isSafeInteger(options.maxResidentBytes) || options.maxResidentBytes! < 1) {
    return { enabled: false, reason: "virtual-texture:max-resident-bytes-required-when-enabled" };
  }
  if (options.maxPages !== undefined
    && (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1)) {
    return { enabled: false, reason: "virtual-texture:max-pages-must-be-positive-integer" };
  }
  if (options.maxUploadPagesPerFrame !== undefined
    && (!Number.isSafeInteger(options.maxUploadPagesPerFrame) || options.maxUploadPagesPerFrame < 1)) {
    return { enabled: false, reason: "virtual-texture:max-upload-pages-per-frame-must-be-positive-integer" };
  }
  if (options.minResidentFrames !== undefined
    && (!Number.isSafeInteger(options.minResidentFrames) || options.minResidentFrames < 0
      || options.minResidentFrames > MAX_DWELL)) {
    return { enabled: false, reason: "virtual-texture:min-resident-frames-must-be-0..4096" };
  }
  return {
    enabled: true,
    maxResidentBytes: options.maxResidentBytes!,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    spec,
    maxUploadPagesPerFrame: options.maxUploadPagesPerFrame ?? DEFAULT_VIRTUAL_TEXTURE_UPLOAD_PAGES_PER_FRAME,
    minResidentFrames: options.minResidentFrames ?? 0,
    ...(options.frameClock !== undefined ? { frameClock: options.frameClock } : {}),
  };
}
