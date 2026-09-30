import type { CsmBoundaryFixture } from "./j2CsmBoundaryFixture.js";

/** Diagnostic receiver target and the original constant two-layer depth fixture. */
export async function csmTimingResources(device: GPUDevice, fixture: CsmBoundaryFixture, width: number, height: number) {
  const depth = device.createTexture({ size: [fixture.size,fixture.size,2], format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const target = device.createTexture({ size: [width,height], format: "rgba32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const uniform = device.createBuffer({ size: 336, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const data = new Float32Array(84);
  for (let i=0;i<4;i++) data.set([1,0,0,0,0,1,0,0,0,0,0,0,0,0,fixture.receiverDepth,1],i*16);
  data.set([2,4,4,4],64); data.set([1.8,4,4,4],68);
  data.set([2,0,1/fixture.size,0],76); data[82]=1;
  device.queue.writeBuffer(uniform,0,data);
  const encoder = device.createCommandEncoder();
  for (let i=0;i<2;i++) {
    const pass=encoder.beginRenderPass({ colorAttachments:[],depthStencilAttachment:{
      view:depth.createView({ dimension:"2d",baseArrayLayer:i,arrayLayerCount:1 }),
      depthClearValue:fixture.clearDepths[i]!,depthLoadOp:"clear",depthStoreOp:"store" } });
    pass.end();
  }
  device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
  const sampler=device.createSampler({ compare:"less-equal",minFilter:"linear",magFilter:"linear",
    addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge" });
  const view=target.createView(), bytesPerRow=width*16;
  const read=device.createBuffer({size:bytesPerRow,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  return {
    target,view,bytesPerRow,read,
    bind(pipeline:GPURenderPipeline) { return device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
      {binding:7,resource:{buffer:uniform}}, {binding:1,resource:depth.createView({dimension:"2d-array"})},
      {binding:2,resource:sampler},
    ]}); },
    destroy() { depth.destroy();target.destroy();uniform.destroy();read.destroy(); },
  };
}
