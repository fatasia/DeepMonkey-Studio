import type { Deep2dGpuFrame } from "./frame.js";
const shader = `
struct Vertex { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32>, @location(1) uv: vec2<f32>, @location(2) bounds: vec4<f32> }
@vertex fn vertex(@location(0) position: vec2<f32>, @location(1) color: vec4<f32>, @location(2) uv: vec2<f32>, @location(3) bounds: vec4<f32>) -> Vertex {
  var output: Vertex; output.position=vec4(position,0.0,1.0); output.color=color; output.uv=uv; output.bounds=bounds; return output;
}
@group(0) @binding(0) var atlas: texture_2d<f32>;
@group(0) @binding(1) var atlasSampler: sampler;
@fragment fn solid(input:Vertex)->@location(0) vec4<f32> { return input.color; }
@fragment fn image(input:Vertex)->@location(0) vec4<f32> { return textureSample(atlas,atlasSampler,clamp(input.uv,input.bounds.xy,input.bounds.zw))*input.color; }
@fragment fn glyph(input:Vertex)->@location(0) vec4<f32> {
  return vec4(input.color.rgb,input.color.a*textureSample(atlas,atlasSampler,clamp(input.uv,input.bounds.xy,input.bounds.zw)).r);
}`;
export interface Deep2dGpuLease { dispose(): void }

/** Renders a hidden WebGPU surface and waits for submission/error validation before returning ownership. */
export async function renderDeep2dGpuFrame(device: GPUDevice, context: GPUCanvasContext,
  format: GPUTextureFormat, frame: Deep2dGpuFrame, signal: AbortSignal): Promise<Deep2dGpuLease> {
  const owned: { destroy(): void }[] = [];
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true;
    const failures: unknown[] = []; for (const item of owned) try { item.destroy(); } catch (error) { failures.push(error); }
    owned.length = 0; if (failures.length) throw new AggregateError(failures, "Deep2D GPU cleanup failed."); };
  const own = <T extends { destroy(): void }>(item: T): T => { owned.push(item); return item; };
  const check = () => { if (signal.aborted) throw new DOMException("Dashboard GPU preparation aborted.", "AbortError"); };
  check();
  device.pushErrorScope("out-of-memory"); device.pushErrorScope("validation");
  let failure: unknown, failed = false;
  try {
    const module = device.createShaderModule({ label: "Deep2D path and atlas", code: shader });
    const info = await module.getCompilationInfo();
    if (info.messages.some(m => m.type === "error")) throw new Error("Deep2D shader compilation failed.");
    check();
    const pipeline = (entryPoint: string) => device.createRenderPipelineAsync({ layout: "auto",
      vertex: { module, entryPoint: "vertex", buffers: [{ arrayStride: 48, attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x4" },
        { shaderLocation: 2, offset: 24, format: "float32x2" }, { shaderLocation: 3, offset: 32, format: "float32x4" }] }] },
      fragment: { module, entryPoint, targets: [{ format, blend: {
        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      } }] }, primitive: { topology: "triangle-list", cullMode: "none" }, multisample: { count: 4 } });
    // Await every pipeline before cleanup, including a failed compilation in another entrypoint.
    const pipelineResults = await Promise.allSettled([pipeline("solid"), pipeline("image"), pipeline("glyph")]);
    const bad = pipelineResults.find(r => r.status === "rejected"); if (bad?.status === "rejected") throw bad.reason;
    const [solid, image, glyph] = pipelineResults.map(r => (r as PromiseFulfilledResult<GPURenderPipeline>).value);
    check();
    const bindings = new Map<string, { pipeline: GPURenderPipeline; group: GPUBindGroup }>();
    for (const [key, atlas] of frame.atlases) {
      if (atlas.width > device.limits.maxTextureDimension2D || atlas.height > device.limits.maxTextureDimension2D) throw new Error("Atlas exceeds device limits.");
      const texture = own(device.createTexture({ size: [atlas.width, atlas.height], format: atlas.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
      device.queue.writeTexture({ texture }, atlas.bytes, { bytesPerRow: atlas.width * (atlas.format === "r8unorm" ? 1 : 4) }, [atlas.width, atlas.height]);
      const current = atlas.format === "r8unorm" ? glyph! : image!;
      const sampler = device.createSampler({ magFilter: atlas.sampling, minFilter: atlas.sampling,
        addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
      bindings.set(key, { pipeline: current, group: device.createBindGroup({ layout: current.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: sampler }] }) });
    }
    const msaa = own(device.createTexture({ size: [frame.width, frame.height], format, sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT }));
    const encoder = device.createCommandEncoder({ label: "Deep2D complete page" });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: msaa.createView(),
      resolveTarget: context.getCurrentTexture().createView({ format }), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "discard" }] });
    for (const draw of frame.draws) {
      const buffer = own(device.createBuffer({ size: draw.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }));
      device.queue.writeBuffer(buffer, 0, draw.vertices);
      const binding = draw.atlasKey ? bindings.get(draw.atlasKey) : undefined;
      if (draw.atlasKey && !binding) throw new Error("Missing GPU atlas binding.");
      pass.setPipeline(binding?.pipeline ?? solid!); if (binding) pass.setBindGroup(0, binding.group);
      pass.setVertexBuffer(0, buffer); pass.draw(draw.vertices.length / 12);
    }
    pass.end(); device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone(); check();
  } catch (error) { failure = error; failed = true; }
  // Scopes remain balanced even on cancellation, compilation failures, or synchronous driver errors.
  const scoped = await Promise.allSettled([device.popErrorScope(), device.popErrorScope()]);
  const errors = scoped.flatMap(r => r.status === "rejected" ? [r.reason] : r.value ? [r.value] : []);
  if (failed || errors.length) {
    try { dispose(); } catch (error) { errors.push(error); }
    throw new AggregateError([...(failed ? [failure] : []), ...errors], "Deep2D GPU candidate failed.");
  }
  return { dispose };
}
