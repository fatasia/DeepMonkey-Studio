/** 只观察 DeviceSession 的所有权边界，不拥有资源，也不替代流式预算控制器。 */
export interface DeviceResourceMemorySnapshot {
  readonly bufferBytes: number;
  readonly textureBytes: number;
  readonly estimatedBytes: number;
  readonly peakEstimatedBytes: number;
  readonly unknownResources: number;
  readonly resourceCount: number;
}

const PIXEL_BYTES: Readonly<Record<string, number>> = Object.freeze({
  r8unorm: 1, r8snorm: 1, r8uint: 1, r8sint: 1,
  r16uint: 2, r16sint: 2, r16float: 2, rg8unorm: 2, rg8snorm: 2, rg8uint: 2, rg8sint: 2,
  r32uint: 4, r32sint: 4, r32float: 4, rg16uint: 4, rg16sint: 4, rg16float: 4,
  rgba8unorm: 4, "rgba8unorm-srgb": 4, rgba8snorm: 4, rgba8uint: 4, rgba8sint: 4,
  bgra8unorm: 4, "bgra8unorm-srgb": 4, rgb10a2unorm: 4, rgb10a2uint: 4, rg11b10ufloat: 4,
  rgb9e5ufloat: 4, rg32uint: 8, rg32sint: 8, rg32float: 8,
  rgba16uint: 8, rgba16sint: 8, rgba16float: 8, rgba32uint: 16, rgba32sint: 16, rgba32float: 16,
  depth16unorm: 2, depth32float: 4, stencil8: 1,
});

type Estimate = { kind: "buffer" | "texture"; bytes: number } | undefined;
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

/** depth24plus 等实现相关布局保持 unknown，不以逻辑位数冒充实际字节。 */
export function estimateDeviceResource(resource: object): Estimate {
  if ("size" in resource && typeof resource.size === "number" && Number.isSafeInteger(resource.size) && resource.size >= 0) {
    return { kind: "buffer", bytes: resource.size };
  }
  const texture = resource as Partial<GPUTexture>;
  const { width, height, depthOrArrayLayers: depth, sampleCount, mipLevelCount, dimension, format } = texture;
  if (![width, height, depth, sampleCount, mipLevelCount].every(positive) || !format
    || !["1d", "2d", "3d"].includes(dimension ?? "")) return undefined;
  // GPU 属性不由外部输入指定；仍限制循环，错误 test double 不得形成无界工作。
  if (mipLevelCount! > 32) return undefined;
  let blockWidth = 1, blockHeight = 1, blockBytes = PIXEL_BYTES[format];
  if (blockBytes === undefined) {
    if (/^bc(?:[1-5]|6h|7)-/.test(format)) { blockWidth = blockHeight = 4; blockBytes = /^bc[14]-/.test(format) ? 8 : 16; }
    else if (/^(etc2|eac)-/.test(format)) {
      blockWidth = blockHeight = 4; blockBytes = /^(etc2-rgba8|eac-rg11)/.test(format) ? 16 : 8;
    } else {
      const astc = /^astc-(\d+)x(\d+)-/.exec(format);
      if (!astc) return undefined;
      blockWidth = Number(astc[1]); blockHeight = Number(astc[2]); blockBytes = 16;
    }
  }
  let bytes = 0;
  for (let mip = 0; mip < mipLevelCount!; mip++) {
    const divisor = 2 ** mip;
    const mipWidth = Math.max(1, Math.floor(width! / divisor));
    const mipHeight = Math.max(1, Math.floor(height! / divisor));
    const mipDepth = dimension === "3d" ? Math.max(1, Math.floor(depth! / divisor)) : depth!;
    bytes += Math.ceil(mipWidth / blockWidth) * Math.ceil(mipHeight / blockHeight) * blockBytes * mipDepth * sampleCount!;
  }
  return Number.isSafeInteger(bytes) && bytes >= 0 ? { kind: "texture", bytes } : undefined;
}

export class DeviceResourceMemory {
  private readonly entries = new Map<object, Estimate>();
  private bufferBytes = 0;
  private textureBytes = 0;
  private unknownResources = 0;
  private peakEstimatedBytes = 0;

  add(resource: object): void {
    if (this.entries.has(resource)) return;
    const estimate = estimateDeviceResource(resource);
    this.entries.set(resource, estimate);
    if (!estimate) this.unknownResources++;
    else if (estimate.kind === "buffer") this.bufferBytes += estimate.bytes;
    else this.textureBytes += estimate.bytes;
    this.peakEstimatedBytes = Math.max(this.peakEstimatedBytes, this.bufferBytes + this.textureBytes);
  }

  remove(resource: object): void {
    if (!this.entries.has(resource)) return;
    const estimate = this.entries.get(resource); this.entries.delete(resource);
    if (!estimate) this.unknownResources--;
    else if (estimate.kind === "buffer") this.bufferBytes -= estimate.bytes;
    else this.textureBytes -= estimate.bytes;
  }

  clear(): void { this.entries.clear(); this.bufferBytes = 0; this.textureBytes = 0; this.unknownResources = 0; }

  get snapshot(): DeviceResourceMemorySnapshot {
    return Object.freeze({ bufferBytes: this.bufferBytes, textureBytes: this.textureBytes,
      estimatedBytes: this.bufferBytes + this.textureBytes, peakEstimatedBytes: this.peakEstimatedBytes,
      unknownResources: this.unknownResources, resourceCount: this.entries.size });
  }
}
