import { vi } from "vitest";
import type { InstanceUpdate, RenderPacket } from "../renderPacket.js";
import type { FrameMetrics, RenderView } from "../webgpu/pbrRenderer.js";
import type { DeepWebGpuRenderRuntime } from "./DeepWebGpuBackend.js";

export const view: RenderView = { width: 100, height: 50, pixelRatio: 1, eye: [0, 0, 4], target: [0, 0, 0],
  extent: 2, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 0.5 };

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function runtime(shadowTier = "high", shadowDepthBytes = 64 * 1024 * 1024):
DeepWebGpuRenderRuntime & { packets: RenderPacket[]; updates: InstanceUpdate[] } {
  const packets: RenderPacket[] = [], updates: InstanceUpdate[] = [];
  return {
    id: "deep-webgpu",
    packets,
    updates,
    setPacketValidated: vi.fn(async (packet: RenderPacket) => { packets.push(packet); }),
    updateInstances: vi.fn((update: InstanceUpdate) => { updates.push(update); }),
    render: vi.fn((_view: RenderView): FrameMetrics | undefined => undefined),
    validateFrame: vi.fn(async (_view: RenderView): Promise<FrameMetrics> =>
      ({ frame: 1, shadowTier, shadowDepthBytes } as FrameMetrics)),
    dispose: vi.fn(),
  };
}

