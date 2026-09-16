/// <reference types="@webgpu/types" />
import type { DecodedTexture, GeometryResource, RenderPacket } from "@bim-studio/deep-engine";
import { sphereMesh, type DeviceSession, type RenderView } from "@bim-studio/deep-engine/webgpu";

export type ChunkProbeRgba = readonly [number, number, number, number];

export function sceneChunkProbePacket(id: "west" | "east" | "ahead"): RenderPacket {
  const sharedTexture = id === "ahead" ? "chunk-ahead-white" : "chunk-shared-white";
  const texture: DecodedTexture = { id: sharedTexture, revision: 1, semantic: "emissive",
    width: 2, height: 2, data: solid(2), mipmaps: [{ width: 1, height: 1, data: solid(1) }],
    sampler: { magFilter: "nearest", minFilter: "nearest", mipmapFilter: "nearest" } };
  const mesh = sphereMesh(16, 10), geometry: GeometryResource = {
    id: `chunk-${id}-geometry`, revision: 1, ...mesh,
    uv0: new Float32Array(mesh.vertices.length / 3).fill(0.5),
  };
  const color = id === "west" ? [1, 0.01, 0.01] as const
    : id === "east" ? [0.01, 1, 0.01] as const : [0.01, 0.01, 1] as const;
  return { geometries: [geometry], textures: [texture], materials: [{ id: `chunk-${id}-material`,
    baseColor: [0, 0, 0], metallic: 0, roughness: 1, emissiveFactor: color, emissiveStrength: 8,
    emissiveTexture: { texture: sharedTexture } }], instances: [{ id: `chunk-${id}-instance`,
    geometry: geometry.id, material: `chunk-${id}-material`,
    transform: [0.45, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 0.45, 0, id === "west" ? -1 : id === "east" ? 1 : 0, 0.8, 0, 1] }] };
}

export function sceneChunkLegacyPacket(): RenderPacket {
  const mesh = sphereMesh(12, 8);
  return { geometries: [{ id: "chunk-legacy", revision: 1, ...mesh }],
    materials: [{ id: "chunk-legacy-material", baseColor: [0, 0, 0], metallic: 0, roughness: 1,
      emissiveFactor: [0.25, 0.25, 0.25], emissiveStrength: 2 }],
    instances: [{ id: "chunk-legacy-instance", geometry: "chunk-legacy",
      material: "chunk-legacy-material",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.8, 0, 1] }] };
}

export function sceneChunkProbeView(canvas: HTMLCanvasElement): RenderView {
  return { width: canvas.clientWidth, height: canvas.clientHeight, pixelRatio: devicePixelRatio,
    eye: [0, 0.8, 5], target: [0, 0.8, 0], up: [0, 1, 0], extent: 4, verticalFovRadians: Math.PI / 3,
    background: [0.002, 0.002, 0.002], floor: [0.003, 0.003, 0.003], exposure: 1, roughness: 1 };
}

export async function readSceneChunkPixel(session: DeviceSession,
  canvas: HTMLCanvasElement): Promise<ChunkProbeRgba> {
  return (await readSceneChunkPixels(session, canvas, [0]))[0]!;
}

/** All samples are copied from the same presented texture before awaiting GPU completion. */
export async function readSceneChunkPixels(session: DeviceSession,
  canvas: HTMLCanvasElement, worldXs: readonly number[]): Promise<readonly ChunkProbeRgba[]> {
  const buffer = session.device.createBuffer({ label: "Deep scene chunk surface readback", size: 256 * worldXs.length,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = session.device.createCommandEncoder({ label: "Deep scene chunk surface copy" });
    const texture = session.context.getCurrentTexture();
    worldXs.forEach((x, index) => encoder.copyTextureToBuffer({ texture,
      origin: [Math.max(0, Math.min(canvas.width - 1, Math.floor(canvas.width / 2 + x * canvas.height / (10 * Math.tan(Math.PI / 6))))), Math.max(0, Math.floor(canvas.height / 2))] },
    { buffer, offset: 256 * index, bytesPerRow: 256 }, [1, 1]));
    session.device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const mapped = buffer.getMappedRange();
    const values = worldXs.map((_, index) => {
      const bytes = Array.from(new Uint8Array(mapped, index * 256, 4));
      return Object.freeze((session.format.startsWith("bgra")
        ? [bytes[2]!, bytes[1]!, bytes[0]!, bytes[3]!] : bytes) as [number, number, number, number]);
    });
    buffer.unmap(); return Object.freeze(values);
  } finally { if (buffer.mapState === "mapped") buffer.unmap(); buffer.destroy(); }
}

export function dominantChunkPixel(pixel: ChunkProbeRgba | null, channel: 0 | 1 | 2): boolean {
  if (!pixel) return false;
  return pixel[channel] >= 96 && [0, 1, 2].filter(value => value !== channel)
    .every(value => pixel[channel] - pixel[value]! >= 32);
}

function solid(size: number): Uint8Array {
  return new Uint8Array(Array.from({ length: size * size }, () => [255, 255, 255, 255]).flat());
}
