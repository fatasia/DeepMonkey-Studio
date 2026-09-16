import type { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
/** Observes the production atlas; does not render a replacement shadow. */
export async function readLocalSpotAtlas(renderer: PbrRenderer): Promise<Float32Array> {
  const view = (renderer as unknown as { localShadows: { bindings: { atlasView: GPUTextureView } } }).localShadows.bindings.atlasView;
  const device = renderer.session.device, bytes = 1024 * 1024 * 4;
  const output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const module = device.createShaderModule({ code: `
@group(0) @binding(0) var atlas: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> values: array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {
  values[id.y * 1024u + id.x] = textureLoad(atlas, vec2i(id.xy), 0);
}` });
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: view }, { binding: 1, resource: { buffer: output } },
    ] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(128, 128); pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, bytes); device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ); return new Float32Array(read.getMappedRange()).slice();
  } finally { read.destroy(); output.destroy(); }
}
