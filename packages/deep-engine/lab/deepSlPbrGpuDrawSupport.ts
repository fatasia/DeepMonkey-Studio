import type { DeepPbrMeshV1MaterialDefaults } from "@bim-studio/deep-engine/shader-authoring";
import type { PreparedShaderPackagePass } from "@bim-studio/deep-engine/webgpu";
import { decodePbrProbePixel, PBR_PROBE_BYTES_PER_ROW, PBR_PROBE_HEIGHT, PBR_PROBE_WIDTH } from "./deepSlPbrProbeFixture.js";

export interface DeepSlPbrMaterialTextureSource {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface DeepSlPbrGpuSample {
  readonly raw16: readonly number[];
  readonly pixel: readonly number[];
  readonly frameBytes: 208;
  readonly geometryStride: 40;
  readonly instanceStride: 144;
  readonly shadowDraws: 1;
  readonly forwardDraws: 1;
  readonly resolveUsed: true;
  readonly colorFormat: "rgba16float";
  readonly sampleCount: 4;
  readonly forwardDepthFormat: "depth24plus";
  readonly shadowDepthFormat: "depth32float";
  readonly shadowDepth: number;
  readonly samplePixels?: readonly (readonly number[])[];
}

export interface DeepSlPbrDrawOptions {
  readonly geometry?: Float32Array;
  readonly materialTextures?: Readonly<{
    parameters: readonly number[];
    baseColor?: DeepSlPbrMaterialTextureSource;
    metallicRoughness?: DeepSlPbrMaterialTextureSource;
    normal?: DeepSlPbrMaterialTextureSource;
    occlusion?: DeepSlPbrMaterialTextureSource;
    emissive?: DeepSlPbrMaterialTextureSource;
  }>;
  readonly tangents?: Float32Array;
  readonly cascadedShadow?: Readonly<{
    uniform: Float32Array;
    clearDepths: readonly [number, number, number, number];
    shadowLayer: number;
  }>;
  readonly samplePoints?: readonly (readonly [number, number])[];
}

export function validateCsmProbe(options: DeepSlPbrDrawOptions): void {
  const csm = options.cascadedShadow;
  if (csm && (csm.uniform.length !== 84 || csm.uniform.some(value => !Number.isFinite(value))
    || csm.clearDepths.length !== 4 || csm.clearDepths.some(value => !Number.isFinite(value) || value < 0 || value > 1)
    || !Number.isInteger(csm.shadowLayer) || csm.shadowLayer < 0 || csm.shadowLayer >= 4)) {
    throw new Error("CSM probe requires finite CSM336 data, four depth values, and a valid shadow layer.");
  }
  if (options.samplePoints?.some(([x, y]) => !Number.isInteger(x) || !Number.isInteger(y)
    || x < 0 || y < 0 || x >= PBR_PROBE_WIDTH || y >= PBR_PROBE_HEIGHT)) {
    throw new Error("PBR probe readback point is outside its fixed target.");
  }
}

export function clearCsmProbeLayers(encoder: GPUCommandEncoder, texture: GPUTexture,
  depths: readonly number[]): void {
  depths.forEach((depthClearValue, baseArrayLayer) => {
    encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
      view: texture.createView({ dimension: "2d", baseArrayLayer, arrayLayerCount: 1 }),
      depthClearValue, depthLoadOp: "clear", depthStoreOp: "store",
    } }).end();
  });
}

export function readPbrProbePoints(data: ArrayBuffer, points: readonly (readonly [number, number])[]) {
  return Object.freeze(points.map(([x, y]) => {
    const pixel = new DataView(data, y * PBR_PROBE_BYTES_PER_ROW + x * 8, 8);
    return decodePbrProbePixel(Array.from({ length: 4 }, (_, index) => pixel.getUint16(index * 2, true)));
  }));
}

export function readPbrProbeReadback(buffer: Pick<GPUBuffer, "getMappedRange">,
  points?: readonly (readonly [number, number])[]) {
  // WebGPU 禁止重复获取重叠映射范围；中心像素与附加样点共用一次映射。
  const data = buffer.getMappedRange();
  const offset = Math.floor(PBR_PROBE_HEIGHT / 2) * PBR_PROBE_BYTES_PER_ROW
    + Math.floor(PBR_PROBE_WIDTH / 2) * 8;
  const view = new DataView(data, offset, 8);
  const raw16 = Object.freeze(Array.from({ length: 4 }, (_, index) => view.getUint16(index * 2, true)));
  return Object.freeze({ raw16, pixel: decodePbrProbePixel(raw16),
    samplePixels: points ? readPbrProbePoints(data, points) : undefined });
}

export function uploadBuffer(device: GPUDevice, label: string, data: Float32Array,
  usage: GPUBufferUsageFlags): GPUBuffer {
  const result = device.createBuffer({ label, size: data.byteLength, usage, mappedAtCreation: true });
  new Float32Array(result.getMappedRange()).set(data);
  result.unmap();
  return result;
}

export function solidTexture(device: GPUDevice, label: string,
  color: readonly [number, number, number, number], cube = false,
  format: GPUTextureFormat = "rgba8unorm"): GPUTexture {
  const result = device.createTexture({ label, size: [1, 1, cube ? 6 : 1], format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const data = new Uint8Array(color);
  for (let layer = 0; layer < (cube ? 6 : 1); layer += 1) {
    device.queue.writeTexture({ texture: result, origin: [0, 0, layer] }, data,
      { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 1]);
  }
  return result;
}

export function rgbaTexture(device: GPUDevice, label: string,
  format: "rgba8unorm" | "rgba8unorm-srgb", source: DeepSlPbrMaterialTextureSource): GPUTexture {
  if (!Number.isInteger(source.width) || source.width <= 0
    || !Number.isInteger(source.height) || source.height <= 0
    || source.data.byteLength !== source.width * source.height * 4) {
    throw new Error("DeepSL package base-color texture must be tightly packed finite-size RGBA8 data.");
  }
  const result = device.createTexture({ label, size: [source.width, source.height], format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: result }, new Uint8Array(source.data),
    { bytesPerRow: source.width * 4, rowsPerImage: source.height }, [source.width, source.height]);
  return result;
}

export function validatePasses(forward: PreparedShaderPackagePass,
  shadow: PreparedShaderPackagePass, textured: boolean): void {
  if (!forward.resolveRequired || forward.attachmentProfile.sampleCount !== 4
    || forward.attachmentProfile.colorAttachments.length !== 1
    || forward.attachmentProfile.colorAttachments[0]?.format !== "rgba16float"
    || forward.attachmentProfile.depthAttachment.format !== "depth24plus"
    || forward.bindGroupLayouts.length !== (textured ? 2 : 1)) {
    throw new Error("DeepSL PBR probe requires the fixed forward 4x MSAA ABI.");
  }
  if (shadow.resolveRequired || shadow.attachmentProfile.sampleCount !== 1
    || shadow.attachmentProfile.depthAttachment.format !== "depth32float"
    || (shadow.bindGroupLayouts.length !== 1 && !(textured && shadow.bindGroupLayouts.length === 2))) {
    throw new Error("DeepSL PBR probe requires the fixed shadow ABI.");
  }
}
