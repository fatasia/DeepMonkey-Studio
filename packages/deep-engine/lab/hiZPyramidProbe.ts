/// <reference types="@webgpu/types" />
import { HiZPyramid, type DeviceSession } from "@bim-studio/deep-engine/webgpu";

export interface HiZPyramidProbeResult {
  readonly mipLevelCount: number;
  readonly finalDepth: number;
  readonly expectedDepth: number;
  readonly passed: boolean;
}

const DEPTH_FIXTURE_WGSL = /* wgsl */ `
struct VertexOutput { @builtin(position) position: vec4<f32> };
@vertex fn vertexMain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));
  let depths = array<f32, 4>(0.2, 0.4, 0.6, 0.8);
  let cell = vec2<f32>(f32(instance & 1u), f32(instance >> 1u));
  var output: VertexOutput;
  output.position = vec4<f32>(cell - vec2<f32>(1.0) + corners[vertex], depths[instance], 1.0);
  return output;
}
`;

/** Independent real-device probe. It does not enter the lab or renderer frame loop. */
export async function runHiZPyramidProbe(session: DeviceSession): Promise<HiZPyramidProbeResult> {
  if (session.state !== "ready") throw new Error("Hi-Z probe requires a ready device session.");
  const device = session.device;
  const source = session.own(device.createTexture({ label: "Deep Hi-Z probe depth source", size: [4, 4, 1],
    format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
  const readback = session.own(device.createBuffer({ label: "Deep Hi-Z probe readback", size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const pyramid = new HiZPyramid(session);
  try {
    const module = device.createShaderModule({ label: "Deep Hi-Z probe fixture WGSL", code: DEPTH_FIXTURE_WGSL });
    const pipeline = device.createRenderPipeline({ label: "Deep Hi-Z probe fixture pipeline", layout: "auto",
      vertex: { module, entryPoint: "vertexMain" }, primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" } });
    const encoder = device.createCommandEncoder({ label: "Deep Hi-Z readback probe" });
    const render = encoder.beginRenderPass({ label: "Deep Hi-Z probe source", colorAttachments: [], depthStencilAttachment: {
      view: source.createView({ aspect: "depth-only" }), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store",
    } });
    render.setPipeline(pipeline); render.draw(6, 4); render.end();
    const result = pyramid.encode(encoder, { texture: source, revision: 0 }, { reversedZ: true, reduction: "conservative" });
    encoder.copyTextureToBuffer({ texture: result.texture, mipLevel: result.mipLevelCount - 1 },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 }, { width: 1, height: 1, depthOrArrayLayers: 1 });
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ, 0, 4);
    const finalDepth = new Float32Array(readback.getMappedRange(0, 4).slice(0))[0]!;
    readback.unmap();
    const expectedDepth = 0.2;
    return Object.freeze({ mipLevelCount: result.mipLevelCount, finalDepth, expectedDepth,
      passed: Number.isFinite(finalDepth) && Math.abs(finalDepth - expectedDepth) <= 1e-6 });
  } finally {
    pyramid.dispose(); session.release(readback); session.release(source);
  }
}
