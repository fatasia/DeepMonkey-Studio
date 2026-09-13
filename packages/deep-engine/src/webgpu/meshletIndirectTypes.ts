/// <reference types="@webgpu/types" />
import type { MeshletCullingGpuResult } from "./meshletCullingTypes.js";

export const MESHLET_DRAW_INDEXED_INDIRECT_STRIDE = 20;
export const MESHLET_INDIRECT_PARAMETER_SIZE = 32;
export const MESHLET_INDIRECT_MAX_DRAWS = 65_536;

export type MeshletInstanceMapping = "constant" | "source-meshlet" | "visible-order";

export interface MeshletIndirectOptions {
  /** Number of expanded uint32 indices addressable from firstIndexBase. */
  readonly expandedIndexCount: number;
  /** Offset inside the index buffer binding, measured in indices. */
  readonly firstIndexBase?: number;
  readonly baseVertex?: number;
  readonly baseInstance?: number;
  readonly instanceMapping?: MeshletInstanceMapping;
}

export interface MeshletIndirectPlan {
  readonly commands: GPUBuffer;
  readonly capacity: number;
  readonly inputMeshletCount: number;
  readonly expandedIndexCount: number;
  readonly firstIndexBase: number;
  readonly baseVertex: number;
  readonly baseInstance: number;
  readonly instanceMapping: MeshletInstanceMapping;
  readonly commandStride: typeof MESHLET_DRAW_INDEXED_INDIRECT_STRIDE;
  readonly generation: number;
  readonly updated: boolean;
}

export interface MeshletBundleVertexBuffer {
  readonly slot: number;
  readonly buffer: GPUBuffer;
  readonly offset?: number;
  readonly size?: number;
}

export interface MeshletBundleBindGroup {
  readonly index: number;
  readonly bindGroup: GPUBindGroup;
  readonly dynamicOffsets?: readonly number[];
}

export interface MeshletRenderBundleRequest {
  readonly label?: string;
  readonly pipeline: GPURenderPipeline;
  readonly indexBuffer: GPUBuffer;
  readonly indexOffset?: number;
  readonly indexSize?: number;
  readonly vertexBuffers?: readonly MeshletBundleVertexBuffer[];
  readonly bindGroups?: readonly MeshletBundleBindGroup[];
  readonly colorFormats: readonly (GPUTextureFormat | null)[];
  readonly depthStencilFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly depthReadOnly?: boolean;
  readonly stencilReadOnly?: boolean;
}

export interface MeshletBundleExecution {
  readonly bundle: GPURenderBundle;
  readonly drawCount: number;
  readonly reused: boolean;
}

export interface ValidatedMeshletIndirect {
  readonly source: MeshletCullingGpuResult;
  readonly expandedIndexCount: number;
  readonly firstIndexBase: number;
  readonly baseVertex: number;
  readonly baseInstance: number;
  readonly instanceMapping: MeshletInstanceMapping;
  readonly mappingCode: number;
  readonly workgroups: number;
}
