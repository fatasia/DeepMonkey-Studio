import type { LodCamera, LodFrameBudget, LodViewport } from "../spatial/index.js";
import type { Frustum } from "./gpuFrustumCulling.js";

export interface PacketLodView {
  readonly camera: LodCamera;
  readonly viewport: LodViewport;
  readonly frustum: Frustum;
  readonly budget?: LodFrameBudget;
  readonly cameraJump?: boolean;
}

export interface PacketLodDraw {
  readonly meshlets?: { readonly indexBuffer: GPUBuffer; readonly commandCount: number };
  readonly geometry: string;
  readonly instances: GPUBuffer;
  /** 当前级别在实例缓冲区中的字节起点，间接命令的 firstInstance 固定为 0。 */
  readonly instanceByteOffset: number;
  readonly previousTransforms: GPUBuffer;
  readonly previousByteOffset: number;
  readonly indirect: GPUBuffer;
  readonly indirectOffset: number;
}

export interface PacketLodFrameStats {
  readonly meshletPasses?: number;
  readonly meshletDispatches?: number;
  readonly meshletFallbackReasons?: readonly string[];
  readonly authorFrustumPasses?: number;
  readonly authorFrustumDispatches?: number;
  readonly inputObjects: number;
  readonly selectionBatches: number;
  readonly indirectDraws: number;
  readonly historyReset: boolean;
}
