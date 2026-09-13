/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { MAX_FORWARD_PLUS_CLUSTER_COUNT, normalizeClusterGrid } from "./clusterGrid.js";
import { ForwardPlusClusterAssigner, type ForwardPlusClusterResources } from "./clusterCompute.js";
import { ForwardPlusPbrLightingBindings } from "./pbrLightingBindings.js";
import type { ClusteredLights, NormalizedClusterGrid } from "./types.js";

type LightingSession = Pick<DeviceSession, "device" | "state" | "own" | "release">;

export const DEFAULT_FORWARD_PLUS_PBR_TUNING = Object.freeze({
  minimumTileSize: 32,
  zSlices: 24,
  maxLightsPerCluster: 64,
} as const);

export interface ForwardPlusPbrProjection {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly near: number;
  readonly far: number;
  readonly verticalFovRadians: number;
}

export interface ForwardPlusPbrTuning {
  /** Starting square tile size. It grows automatically for very large render targets. */
  readonly minimumTileSize?: number;
  readonly zSlices?: number;
  readonly maxLightsPerCluster?: number;
}

export interface ForwardPlusPbrFrameInput extends ForwardPlusPbrProjection {
  readonly lights: ClusteredLights;
  readonly tuning?: ForwardPlusPbrTuning;
}

export interface ForwardPlusPbrFrame {
  readonly bindGroupIndex: 3;
  readonly bindGroup: GPUBindGroup;
  readonly resources: ForwardPlusClusterResources;
  readonly grid: NormalizedClusterGrid;
  readonly lightCount: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
}

/** Builds a bounded grid while preserving depth resolution on large/HiDPI render targets. */
export function createForwardPlusPbrGrid(projection: ForwardPlusPbrProjection,
  tuning: ForwardPlusPbrTuning = {}): NormalizedClusterGrid {
  const minimumTileSize = tuning.minimumTileSize ?? DEFAULT_FORWARD_PLUS_PBR_TUNING.minimumTileSize;
  const zSlices = tuning.zSlices ?? DEFAULT_FORWARD_PLUS_PBR_TUNING.zSlices;
  const maxLightsPerCluster = tuning.maxLightsPerCluster ?? DEFAULT_FORWARD_PLUS_PBR_TUNING.maxLightsPerCluster;
  positiveInteger(projection.viewportWidth, "viewportWidth"); positiveInteger(projection.viewportHeight, "viewportHeight");
  positiveInteger(minimumTileSize, "minimumTileSize"); positiveInteger(zSlices, "zSlices");
  positiveInteger(maxLightsPerCluster, "maxLightsPerCluster");
  let tileSize = minimumTileSize;
  while (Math.ceil(projection.viewportWidth / tileSize) * Math.ceil(projection.viewportHeight / tileSize) * zSlices
    > MAX_FORWARD_PLUS_CLUSTER_COUNT) tileSize *= 2;
  return normalizeClusterGrid({ ...projection, tileSizeX: tileSize, tileSizeY: tileSize, zSlices, maxLightsPerCluster });
}

/** Owns the complete compute-to-fragment Forward+ lifecycle used by a PBR frame. */
export class ForwardPlusPbrRuntime {
  readonly layout: GPUBindGroupLayout;
  private readonly assigner: ForwardPlusClusterAssigner;
  private readonly bindings: ForwardPlusPbrLightingBindings;
  private disposed = false;

  constructor(private readonly session: LightingSession) {
    if (session.device.limits.maxBindGroups < 4 || session.device.limits.maxStorageBuffersPerShaderStage < 6) {
      throw new Error("Forward+ PBR requires four bind groups and six fragment storage buffers.");
    }
    this.assigner = new ForwardPlusClusterAssigner(session);
    this.bindings = new ForwardPlusPbrLightingBindings(session);
    this.layout = this.bindings.layout;
  }

  prepareAndEncode(encoder: GPUCommandEncoder, input: ForwardPlusPbrFrameInput): ForwardPlusPbrFrame {
    this.assertReady();
    const grid = createForwardPlusPbrGrid(input, input.tuning);
    const resources = this.assigner.prepare(grid, input.lights);
    const binding = this.bindings.bind(resources);
    this.assigner.encode(encoder);
    return Object.freeze({ bindGroupIndex: binding.group, bindGroup: binding.bindGroup, resources, grid,
      lightCount: resources.directionalCount + resources.pointCount + resources.spotCount });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.bindings.dispose(); this.assigner.dispose();
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Forward+ PBR runtime is disposed.");
    if (this.session.state !== "ready") throw new Error(`Forward+ PBR runtime cannot use a ${this.session.state} GPU session.`);
  }
}
