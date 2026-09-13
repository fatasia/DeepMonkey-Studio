import { vi } from "vitest";
import { prepareRenderPacket, type GeometryResource, type PreparedPacket } from "../renderPacket.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import type { DeviceSession } from "./deviceSession.js";

const TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function chunkGeometry(id: string, first = 0): GeometryResource {
  return { id, revision: 3,
    vertices: new Float32Array([first, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    uv0: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
}

export function chunkTexture(id: string, first = 11): DecodedTexture {
  const data = new Uint8Array(16).fill(11); data[0] = first;
  return { id, revision: 7, semantic: "baseColor", width: 2, height: 2, data,
    mipmaps: [{ width: 1, height: 1, data: new Uint8Array(4).fill(22) }] };
}

export function chunkPacket(geometryId = "mesh", textureId = "base", first = 0,
  instance = "instance"): PreparedPacket {
  return prepareRenderPacket({ geometries: [chunkGeometry(geometryId, first)],
    textures: [chunkTexture(textureId, first + 11)],
    materials: [{ id: `mat-${instance}`, baseColor: [1, 1, 1], metallic: 0, roughness: 1,
      baseColorTexture: { texture: textureId } }],
    instances: [{ id: instance, geometry: geometryId, material: `mat-${instance}`, transform: TRANSFORM }],
  });
}

export interface ChunkGpuFixture {
  readonly session: DeviceSession;
  readonly device: {
    readonly createBuffer: ReturnType<typeof vi.fn>;
    readonly createTexture: ReturnType<typeof vi.fn>;
    readonly popErrorScope: ReturnType<typeof vi.fn>;
    readonly queue: { readonly writeBuffer: ReturnType<typeof vi.fn>;
      readonly writeTexture: ReturnType<typeof vi.fn> };
  };
  readonly owned: Set<{ destroy(): void }>;
  failTexture(value: boolean): void;
}

export function chunkGpuFixture(): ChunkGpuFixture {
  const owned = new Set<{ destroy(): void }>(); let textureFailure = false;
  const destroyable = () => ({ destroy: vi.fn() });
  const createBuffer = vi.fn(() => destroyable() as unknown as GPUBuffer);
  const createTexture = vi.fn(() => {
    if (textureFailure) throw new Error("injected texture allocation failure");
    return { ...destroyable(), createView: vi.fn(() => ({})) } as unknown as GPUTexture;
  });
  const queue = { writeBuffer: vi.fn(), writeTexture: vi.fn() };
  const device = { lost: new Promise<void>(() => {}), features: new Set<GPUFeatureName>(),
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 1_000_000 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    createBuffer, createTexture, createSampler: vi.fn(() => ({} as GPUSampler)), queue };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { owned.add(resource); return resource; },
    release(resource: { destroy(): void }) { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  return { session, device: { createBuffer, createTexture, popErrorScope: device.popErrorScope, queue }, owned,
    failTexture(value: boolean) { textureFailure = value; } };
}

export function visible(key: string) {
  return Object.freeze({ key, mode: "visible" as const, demands: Object.freeze([]) });
}
export function prefetch(key: string) {
  return Object.freeze({ key, mode: "prefetch" as const, demands: Object.freeze([]) });
}
