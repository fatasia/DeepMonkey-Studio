/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { BloomLevelSize } from "./bloomTypes.js";
import { BLOOM_COLOR_FORMAT } from "./bloomTypes.js";

export interface BloomLevelResources extends BloomLevelSize {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly temporary: GPUTexture;
  readonly temporaryView: GPUTextureView;
  readonly combined?: GPUTexture;
  readonly combinedView?: GPUTextureView;
}

export interface BloomInternalBindings {
  readonly downsample: readonly GPUBindGroup[];
  readonly horizontal: readonly GPUBindGroup[];
  readonly vertical: readonly GPUBindGroup[];
  /** Indexed by the high-resolution destination level. */
  readonly upsample: readonly GPUBindGroup[];
}

export interface BloomAllocation {
  readonly width: number;
  readonly height: number;
  readonly levels: readonly BloomLevelResources[];
  readonly output: GPUTexture;
  readonly outputView: GPUTextureView;
  readonly parameters: GPUBuffer;
  readonly internalBindings: BloomInternalBindings;
}

function bind(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  parameters: GPUBuffer,
  primary: GPUTextureView,
  secondary: GPUTextureView,
  target: GPUTextureView,
  label: string,
): GPUBindGroup {
  return device.createBindGroup({ label, layout, entries: [
    { binding: 0, resource: primary }, { binding: 1, resource: secondary },
    { binding: 2, resource: { buffer: parameters } }, { binding: 3, resource: target },
  ] });
}

function createTexture(
  session: DeviceSession,
  resources: Array<GPUTexture | GPUBuffer>,
  size: BloomLevelSize,
  label: string,
  usage: GPUTextureUsageFlags,
): readonly [GPUTexture, GPUTextureView] {
  const texture = session.own(session.device.createTexture({ label, size: { ...size, depthOrArrayLayers: 1 },
    dimension: "2d", format: BLOOM_COLOR_FORMAT, usage }));
  resources.push(texture);
  return [texture, texture.createView()];
}

function createInternalBindings(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  parameters: GPUBuffer,
  levels: readonly BloomLevelResources[],
): BloomInternalBindings {
  const downsample: GPUBindGroup[] = [], horizontal: GPUBindGroup[] = [], vertical: GPUBindGroup[] = [], upsample: GPUBindGroup[] = [];
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index]!;
    horizontal.push(bind(device, layout, parameters, level.view, level.view, level.temporaryView, `Deep bloom horizontal ${index}`));
    vertical.push(bind(device, layout, parameters, level.temporaryView, level.temporaryView, level.view, `Deep bloom vertical ${index}`));
    if (index > 0) {
      const previous = levels[index - 1]!;
      downsample.push(bind(device, layout, parameters, previous.view, previous.view, level.view, `Deep bloom downsample ${index}`));
    }
  }
  for (let index = levels.length - 2; index >= 0; index -= 1) {
    const high = levels[index]!, low = levels[index + 1]!;
    const lowView = low.combinedView ?? low.view;
    upsample[index] = bind(device, layout, parameters, high.view, lowView, high.combinedView!, `Deep bloom upsample ${index}`);
  }
  return { downsample: Object.freeze(downsample), horizontal: Object.freeze(horizontal),
    vertical: Object.freeze(vertical), upsample: Object.freeze(upsample) };
}

export function allocateBloomResources(
  session: DeviceSession,
  layout: GPUBindGroupLayout,
  width: number,
  height: number,
  sizes: readonly BloomLevelSize[],
): BloomAllocation {
  const resources: Array<GPUTexture | GPUBuffer> = [], sampledStorage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
  try {
    const levels = sizes.map((size, index): BloomLevelResources => {
      const [texture, view] = createTexture(session, resources, size, `Deep bloom level ${index}`, sampledStorage);
      const [temporary, temporaryView] = createTexture(session, resources, size, `Deep bloom temporary ${index}`, sampledStorage);
      if (index === sizes.length - 1) return { ...size, texture, view, temporary, temporaryView };
      const [combined, combinedView] = createTexture(session, resources, size, `Deep bloom combined ${index}`, sampledStorage);
      return { ...size, texture, view, temporary, temporaryView, combined, combinedView };
    });
    const [output, outputView] = createTexture(session, resources, { width, height }, "Deep bloom HDR output",
      sampledStorage | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
    const parameters = session.own(session.device.createBuffer({ label: "Deep bloom parameters", size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
    resources.push(parameters);
    const internalBindings = createInternalBindings(session.device, layout, parameters, levels);
    return { width, height, levels: Object.freeze(levels), output, outputView, parameters, internalBindings };
  } catch (error) {
    for (const resource of resources) session.release(resource);
    throw error;
  }
}

export function createBloomSourceBindings(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  allocation: BloomAllocation,
  source: GPUTexture,
): Readonly<{ extract: GPUBindGroup; composite: GPUBindGroup }> {
  const sourceView = source.createView({ format: BLOOM_COLOR_FORMAT, dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 });
  const top = allocation.levels[0]!;
  const bloomView = top.combinedView ?? top.view;
  return Object.freeze({
    extract: bind(device, layout, allocation.parameters, sourceView, sourceView, top.view, "Deep bloom extraction bindings"),
    composite: bind(device, layout, allocation.parameters, sourceView, bloomView, allocation.outputView, "Deep bloom scene composite bindings"),
  });
}

export function releaseBloomResources(session: DeviceSession, allocation: BloomAllocation): void {
  session.release(allocation.parameters); session.release(allocation.output);
  for (const level of allocation.levels) {
    session.release(level.texture); session.release(level.temporary);
    if (level.combined) session.release(level.combined);
  }
}
