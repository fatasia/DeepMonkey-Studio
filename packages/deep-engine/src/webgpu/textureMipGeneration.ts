/** Hardware sRGB decoding/encoding keeps RGB filtering linear; alpha is always linear. */
export const TEXTURE_MIP_SHADER = `
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> Vertex {
  let point = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0))[index];
  return Vertex(vec4f(point, 0.0, 1.0), vec2f(point.x * 0.5 + 0.5, 0.5 - point.y * 0.5));
}
@fragment fn fs(input: Vertex) -> @location(0) vec4f {
  return textureSampleLevel(image, linearSampler, input.uv, 0.0);
}`;
const devices = new WeakMap<GPUDevice, Map<GPUTextureFormat, { pipeline: GPURenderPipeline; sampler: GPUSampler }>>();
export function generateTextureMips(device: GPUDevice, texture: GPUTexture, format: GPUTextureFormat, count: number): void {
  if (count <= 1) return;
  let formats = devices.get(device);
  if (!formats) { formats = new Map(); devices.set(device, formats); }
  let state = formats.get(format);
  if (!state) {
    const module = device.createShaderModule({ label: "Deep texture mip shader", code: TEXTURE_MIP_SHADER });
    state = { pipeline: device.createRenderPipeline({ label: "Deep texture mip pipeline", layout: "auto",
      vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" } }), sampler: device.createSampler({ minFilter: "linear", magFilter: "linear" }) };
    formats.set(format, state);
  }
  const encoder = device.createCommandEncoder({ label: "Deep texture mip generation" });
  for (let level = 1; level < count; level++) {
    const group = device.createBindGroup({ layout: state.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
      { binding: 1, resource: state.sampler },
    ] });
    const pass = encoder.beginRenderPass({ colorAttachments: [{
      view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0],
    }] });
    pass.setPipeline(state.pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
  }
  device.queue.submit([encoder.finish()]);
}
