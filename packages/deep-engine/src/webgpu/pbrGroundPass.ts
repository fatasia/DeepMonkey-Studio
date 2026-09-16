import type { DeviceSession } from "./deviceSession.js";
import { MeshBuffers, uploadBuffer } from "./meshBuffers.js";
import { groundMesh } from "./primitives.js";
import { AuthorGridResources } from "./authorGridResources.js";

export interface PbrGroundResources {
  readonly author: AuthorGridResources;
  readonly mesh: MeshBuffers;
  readonly instance: GPUBuffer;
  readonly data: Float32Array<ArrayBuffer>;
}

/** Resources share the renderer's session lifetime, including failed preparation. */
export function createPbrGround(session: DeviceSession): PbrGroundResources {
  const data = new Float32Array(36);
  const mesh = new MeshBuffers(session, groundMesh());
  try {
    return { mesh, instance: uploadBuffer(session, "Deep ground", data, GPUBufferUsage.VERTEX), data, author: new AuthorGridResources(session) };
  } catch (error) {
    mesh.dispose();
    throw error;
  }
}

/** The preview plane is independent of authored geometry and of its grid decoration. */
export function drawPbrGround(enabled: boolean, pass: GPURenderPassEncoder,
  pipeline: GPURenderPipeline, mesh: Pick<MeshBuffers, "draw">, instances: GPUBuffer,
  directDisplay: boolean): { drawCalls: number; triangles: number } {
  if (!enabled) return { drawCalls: 0, triangles: 0 };
  pass.setPipeline(pipeline);
  mesh.draw(pass, instances, 1, false, directDisplay ? undefined : instances);
  return { drawCalls: 1, triangles: 2 };
}
