import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { PbrTransientTextureHandle, PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";
import { authorBloomSizes } from "./authorBloomCpu.js";
import type { BloomLevelSize } from "./bloomTypes.js";
import { failWithResourceCleanup, runResourceCleanup } from "../webgpu/resourceCleanup.js";

export interface AuthorBloomAllocation {
  readonly width: number; readonly height: number;
  readonly levels: readonly BloomLevelSize[];
  readonly textures: readonly GPUTexture[];
  readonly output: GPUTexture; readonly parameters: GPUBuffer;
  readonly fixedBindings: readonly GPUBindGroup[];
  readonly bright: GPUTexture; readonly combined: GPUTexture;
}
export interface PooledAuthorBloomAllocation {
  readonly allocation: AuthorBloomAllocation;
  readonly handles: readonly PbrTransientTextureHandle[];
}

export function bindAuthorBloom(device: GPUDevice, layout: GPUBindGroupLayout, parameters: GPUBuffer,
  source: GPUTexture, target: GPUTexture, mips: readonly GPUTexture[] = []): GPUBindGroup {
  const view = (texture: GPUTexture) => texture.createView({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 });
  return device.createBindGroup({ layout, entries: [
    { binding: 0, resource: view(source) },
    ...Array.from({ length: 5 }, (_, index) => ({ binding: index + 1, resource: view(mips[index] ?? source) })),
    { binding: 6, resource: { buffer: parameters } }, { binding: 7, resource: view(target) },
  ] });
}

export function allocateAuthorBloom(session: DeviceSession, layout: GPUBindGroupLayout,
  width: number, height: number): AuthorBloomAllocation {
  const textures: GPUTexture[] = []; let parameters: GPUBuffer | undefined;
  const texture = (size: BloomLevelSize, label: string) => {
    const result = session.own(session.device.createTexture({ label, size, format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC }));
    textures.push(result); return result;
  };
  try {
    const levels = authorBloomSizes(width, height), bright = texture(levels[0]!, "Deep author bloom bright");
    const horizontal = levels.map((size, index) => texture(size, `Deep author bloom horizontal ${index}`));
    const vertical = levels.map((size, index) => texture(size, `Deep author bloom vertical ${index}`));
    const combined = texture(levels[0]!, "Deep author bloom combined"), output = texture({ width, height }, "Deep author bloom output");
    parameters = session.own(session.device.createBuffer({ label: "Deep author bloom parameters", size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
    const fixedBindings = levels.flatMap((_, index) => [
      bindAuthorBloom(session.device, layout, parameters!, index === 0 ? bright : vertical[index - 1]!, horizontal[index]!),
      bindAuthorBloom(session.device, layout, parameters!, horizontal[index]!, vertical[index]!),
    ]);
    fixedBindings.push(bindAuthorBloom(session.device, layout, parameters, bright, combined, vertical));
    return { width, height, levels, textures, output, parameters, fixedBindings, bright, combined };
  } catch (error) {
    failWithResourceCleanup(error, "Author bloom allocation failed", [
      ...(parameters ? [() => session.release(parameters!)] : []), ...textures.map(item => () => session.release(item)),
    ]);
  }
}

/** Acquire the fixed r185 pyramid and retain bind groups only for an exact texture-identity permutation. */
export function acquirePooledAuthorBloom(session: DeviceSession, pool: PbrTransientTexturePool,
  layout: GPUBindGroupLayout, parameters: GPUBuffer, width: number, height: number,
  cached: readonly AuthorBloomAllocation[]): PooledAuthorBloomAllocation {
  const handles: PbrTransientTextureHandle[] = [], textures: GPUTexture[] = [];
  const acquire = (size: BloomLevelSize, resourceId: string) => {
    const handle = pool.acquire({ resourceId, ...size, sampleCount: 1, format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    handles.push(handle); textures.push(handle.texture); return handle.texture;
  };
  try {
    const levels = authorBloomSizes(width, height), bright = acquire(levels[0]!, "author-bloom-bright");
    const horizontal = levels.map((size, index) => acquire(size, `author-bloom-horizontal-${index}`));
    const vertical = levels.map((size, index) => acquire(size, `author-bloom-vertical-${index}`));
    const combined = acquire(levels[0]!, "author-bloom-combined");
    const output = acquire({ width, height }, "bloom-hdr");
    const match = cached.find(item => item.textures.length === textures.length
      && item.textures.every((texture, index) => texture === textures[index]));
    if (match) return { allocation: match, handles };
    const fixedBindings = levels.flatMap((_, index) => [
      bindAuthorBloom(session.device, layout, parameters, index === 0 ? bright : vertical[index - 1]!, horizontal[index]!),
      bindAuthorBloom(session.device, layout, parameters, horizontal[index]!, vertical[index]!),
    ]);
    fixedBindings.push(bindAuthorBloom(session.device, layout, parameters, bright, combined, vertical));
    return { allocation: { width, height, levels, textures, output, parameters,
      fixedBindings, bright, combined }, handles };
  } catch (error) { for (const handle of handles) pool.release(handle); throw error; }
}

export function releaseAuthorBloom(session: DeviceSession, allocation: AuthorBloomAllocation): void {
  runResourceCleanup("Author bloom resource cleanup failed", [() => session.release(allocation.parameters),
    ...allocation.textures.map(texture => () => session.release(texture))]);
}
