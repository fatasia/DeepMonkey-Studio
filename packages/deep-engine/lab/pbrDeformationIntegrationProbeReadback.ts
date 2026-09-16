import type { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { INTEGRATION_SIZE } from "./pbrDeformationIntegrationProbeFixture.js";

/** Lab-only observation of production attachments; creates no substitute raster pass. */
export async function readIntegrationAttachments(renderer: PbrRenderer, colorOverride?: GPUTexture): Promise<Float32Array> {
  const observed = renderer as unknown as { targets: { hdrTexture: GPUTexture; motionTexture: GPUTexture };
    shadows: { texture: GPUTexture } };
  const device = renderer.session.device, size = INTEGRATION_SIZE;
  const output = device.createBuffer({ size: size * size * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: output.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const module = device.createShaderModule({ code: `
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var motion: texture_2d<f32>;
@group(0) @binding(2) var shadow: texture_depth_2d;
@group(0) @binding(3) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${size}u || id.y >= ${size}u) { return; }
  let xy = vec2i(id.xy); let offset = (id.y * ${size}u + id.x) * 2u;
  result[offset] = textureLoad(hdr, xy, 0);
  result[offset + 1u] = vec4f(textureLoad(motion, xy, 0).xy, textureLoad(shadow, xy, 0), 0.0);
}` });
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: (colorOverride ?? observed.targets.hdrTexture).createView() },
      { binding: 1, resource: observed.targets.motionTexture.createView() },
      { binding: 2, resource: observed.shadows.texture.createView({ dimension: "2d", baseArrayLayer: 0, arrayLayerCount: 1 }) },
      { binding: 3, resource: { buffer: output } },
    ] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(size / 8, size / 8); pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, output.size); device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(read.getMappedRange()).slice(); read.unmap(); return values;
  } finally { read.destroy(); output.destroy(); }
}

export function summarizeIntegrationPixels(values: Float32Array) {
  const channels = [0, 1, 2].map(() => ({ pixels: 0, centroidX: 0, motionX: 0 }));
  let shadowPixels = 0;
  for (let pixel = 0; pixel < INTEGRATION_SIZE ** 2; pixel++) {
    const offset = pixel * 8;
    if (values[offset + 6]! < 0.99) shadowPixels++;
    for (let channel = 0; channel < 3; channel++) if (values[offset + channel]! > 0.5) {
      const result = channels[channel]!; result.pixels++; result.centroidX += pixel % INTEGRATION_SIZE;
      result.motionX += values[offset + 4]!;
    }
  }
  channels.forEach(result => { result.centroidX /= result.pixels; result.motionX /= result.pixels; });
  return { channels, shadowPixels, finite: values.every(Number.isFinite) };
}
