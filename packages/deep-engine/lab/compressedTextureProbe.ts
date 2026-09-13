import { TextureResources, type DeviceSession } from "@bim-studio/deep-engine/webgpu";

const BC1_OPAQUE_RED = new Uint8Array([0x00, 0xf8, 0x1f, 0x00, 0x00, 0x00, 0x00, 0x00]);
const BYTES_PER_ROW = 256;

export function evaluateBc1RedPixel(pixel: readonly number[]): boolean {
  return pixel.length === 4 && pixel.every(Number.isFinite)
    && pixel[0]! >= 240 && pixel[1]! <= 8 && pixel[2]! <= 8 && pixel[3]! >= 250;
}

export type CompressedTextureProbeRecord = Readonly<{
  action: "compressed-texture-upload";
  success: boolean;
  feature: "texture-compression-bc";
  supported: boolean;
  format?: "bc1-rgba-unorm-srgb";
  sourceBytes?: number;
  rgba?: readonly number[];
  failure?: string;
}>;

/** Uploads an engine-owned BC1 block, samples it on the current device, and reads the rendered texel back. */
export async function verifyCompressedTextureUpload(session: DeviceSession): Promise<CompressedTextureProbeRecord> {
  const feature = "texture-compression-bc" as const;
  if (!session.device.features.has(feature)) return Object.freeze({
    action: "compressed-texture-upload", success: true, feature, supported: false,
  });
  const device = session.device, textures = new TextureResources(session);
  let target: GPUTexture | undefined, readback: GPUBuffer | undefined, validationScope = false;
  try {
    target = device.createTexture({ label: "Deep BC1 probe target", size: [4, 4], format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    readback = device.createBuffer({ label: "Deep BC1 probe readback", size: BYTES_PER_ROW * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    await textures.setValidated([{ id: "deep-probe-bc1", revision: 0, semantic: "baseColor",
      width: 4, height: 4, compression: "bc1-rgba", data: BC1_OPAQUE_RED }]);
    const source = textures.get("deep-probe-bc1");
    if (!source) throw new Error("Compressed texture binding was not published.");
    device.pushErrorScope("validation"); validationScope = true;
    const module = device.createShaderModule({ label: "Deep BC1 probe WGSL", code: `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}
@fragment fn fragmentMain() -> @location(0) vec4f {
  return textureSampleLevel(sourceTexture, sourceSampler, vec2f(0.5), 0.0);
}` });
    const pipeline = device.createRenderPipeline({ label: "Deep BC1 probe pipeline", layout: "auto",
      vertex: { module, entryPoint: "vertexMain" }, fragment: { module, entryPoint: "fragmentMain",
        targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    const bindings = device.createBindGroup({ label: "Deep BC1 probe bindings", layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: source.view }, { binding: 1, resource: source.sampler }] });
    const encoder = device.createCommandEncoder({ label: "Deep BC1 probe commands" });
    const pass = encoder.beginRenderPass({ label: "Deep BC1 probe draw", colorAttachments: [{ view: target.createView(),
      clearValue: [0, 0, 1, 1], loadOp: "clear", storeOp: "store" }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.draw(3); pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: BYTES_PER_ROW, rowsPerImage: 4 }, [4, 4]);
    device.queue.submit([encoder.finish()]);
    const validation = await device.popErrorScope();
    validationScope = false;
    if (validation) throw new Error(validation.message);
    await device.queue.onSubmittedWorkDone();
    await readback.mapAsync(GPUMapMode.READ);
    const rgba = Object.freeze(Array.from(new Uint8Array(readback.getMappedRange().slice(0, 4))));
    readback.unmap();
    if (!evaluateBc1RedPixel(rgba)) throw new Error(`BC1 sample mismatch: ${rgba.join(",")}`);
    return Object.freeze({ action: "compressed-texture-upload", success: true, feature, supported: true,
      format: "bc1-rgba-unorm-srgb", sourceBytes: BC1_OPAQUE_RED.byteLength, rgba });
  } catch (error) {
    if (validationScope) {
      try { await device.popErrorScope(); } catch { /* Preserve the original probe failure. */ }
    }
    return Object.freeze({ action: "compressed-texture-upload", success: false, feature, supported: true,
      failure: error instanceof Error ? error.message : String(error) });
  } finally {
    textures.dispose(); target?.destroy(); readback?.destroy();
  }
}
