import { vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
export async function turns(count = 4): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve();
}
export function fixture(bufferLimit = 128 * 1024 * 1024) {
  const resources = new Set<{ destroy(): void }>(), lost = deferred<GPUDeviceLostInfo>();
  const queue = { writeBuffer: vi.fn(), submit: vi.fn(), onSubmittedWorkDone: vi.fn(() => Promise.resolve()) };
  const device = {
    limits: { maxBufferSize: bufferLimit, maxStorageBufferBindingSize: bufferLimit,
      maxTextureDimension2D: 16_384, maxTextureArrayLayers: 256,
      maxComputeWorkgroupsPerDimension: 65_535 },
    queue, lost: lost.promise, pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})),
    createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size,
      usage: descriptor.usage, destroy: vi.fn() })),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => ({ destroy: vi.fn(),
      createView: vi.fn(() => ({})), descriptor })),
    createCommandEncoder: vi.fn(() => ({ copyTextureToTexture: vi.fn(),
      beginComputePass: vi.fn(() => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(), end: vi.fn() })), finish: vi.fn(() => ({})) })),
  };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { resources.add(resource); return resource; },
    release(resource: { destroy(): void }): void { if (resources.delete(resource)) resource.destroy(); },
  };
  return { session: session as unknown as DeviceSession, rawSession: session, device, queue, lost, resources };
}
export const frame = (cameraPosition: readonly [number, number, number] = [0, 0, 0]) => ({
  viewport: [1280, 720] as const, cameraPosition,
  sceneBounds: { min: [-100, -100, -100], max: [100, 100, 100] } as const,
});
export const packet = (x: number): RenderPacket => ({
  geometries: [{ id: "robot-geometry", revision: 1,
    vertices: new Float32Array([
      -2, -2, -2, 0, 1, 0, 2, -2, -2, 0, 1, 0, 2, 2, 2, 0, 1, 0,
    ]), indices: new Uint32Array([0, 1, 2]) }],
  materials: [{ id: "robot-material", baseColor: [1, 1, 1], metallic: 0, roughness: 0.5 }],
  instances: [{ id: "robot", geometry: "robot-geometry", material: "robot-material",
    transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]) }],
});
export const options = { frameBudget: 4, cameraCutBudget: 6,
  clipmap: { levelCount: 2, gridSize: [4, 2, 4] as const } } as const;

