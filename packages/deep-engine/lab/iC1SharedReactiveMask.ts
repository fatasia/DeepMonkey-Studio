import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { GaussianSplatSceneOwner } from "../src/webgpu/gaussianSplatSceneOwner.js";
import { PbrParticlePass } from "../src/webgpu/pbrParticlePass.js";
import { GpuParticleRuntime } from "../src/webgpu/gpuParticleRuntime.js";
import { PbrTransparencyPass } from "../src/webgpu/pbrTransparencyPass.js";
import { lookAt, multiply, perspective } from "../src/webgpu/cameraMath.js";
/** Actual existing three writers, dirty mask negative control, and the configured-but-not-published branch. */
export async function probeIC1SharedReactiveMask(session: DeviceSession, drawParticle: boolean) {
  const device = session.device, before = session.resourceCount, textures: GPUTexture[] = [];
  const texture = (format: GPUTextureFormat, usage: GPUTextureUsageFlags) => {
    const t = session.own(device.createTexture({ size: [64, 64], format, usage })); textures.push(t); return t;
  };
  const hdr = texture("rgba16float", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
  const depth = texture("depth32float", GPUTextureUsage.RENDER_ATTACHMENT);
  const mask = texture("r8unorm", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC);
  const dirty = new Uint8Array(256 * 64).fill(230); device.queue.writeTexture({ texture: mask }, dirty, { bytesPerRow: 256 }, [64, 64]);
  const vm = lookAt([0, 0, 6], [0, 0, 0]), vp = multiply(perspective(.8, 1, .1, 50), vm);
  const particles = new GpuParticleRuntime(session, "c1-mask", { capacity: 2, initialParticles: [
    { id: 1, position: [-1, 0, 0], velocity: [0, 0, 0], lifetime: 10, color: [.1, .7, 1, .8], size: .6 } ] });
  const particlePass = new PbrParticlePass(session, "rgba16float", "depth32float", "r8unorm");
  const splats = new GaussianSplatSceneOwner(session, "rgba16float", "depth32float", true);
  const oit = new PbrTransparencyPass(session, undefined, true);
  const read = session.own(device.createBuffer({ size: 256 * 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
  let evidence: { min: number; max: number; left: number; right: number; sameTexture: boolean; remainingDelta: number };
  try {
    await splats.stage({ format: "reference", splatCount: 1, records: new Float32Array([1, 0, 0, .6, .2, .2, .2, 0, 0, 0, 0, 1, .8, .1, .1, .6]),
      shDegree: 0, shRest: null, shRestCount: 0 });
    const result = drawParticle ? await particles.beginFrame({ deltaTime: 0 }) : undefined;
    const encoder = device.createCommandEncoder();
    const clear = encoder.beginRenderPass({ colorAttachments: [{ view: hdr.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 } }); clear.end();
    if (result?.snapshot) particlePass.encode({ encoder, colorView: hdr.createView(), depthView: depth.createView(), reactiveView: mask.createView(),
      width: 64, height: 64, camera: { viewProjection: Array.from(vp), cameraRight: [1, 0, 0], cameraUp: [0, 1, 0] }, binding: result.snapshot.binding });
    splats.encode({ encoder, color: hdr.createView(), depth: depth.createView(), reactiveView: mask.createView(), clearReactive: !result?.snapshot,
      frame: { viewMatrix: vm, viewProjectionMatrix: vp, cameraPosition: [0, 0, 6], viewportPixels: [64, 64], focalPixels: [64 / (2 * Math.tan(.4)), 64 / (2 * Math.tan(.4))] } });
    const module = device.createShaderModule({ code: `
@vertex fn vs(@builtin(vertex_index) index:u32)->@builtin(position) vec4f {
let x=f32((index<<1u)&2u);let y=f32(index&2u);return vec4f(x*2.0-1.0,1.0-y*2.0,0.0,1.0);}
struct Out{@location(0) accumulation:vec4f,@location(1) revealage:f32}
@fragment fn fs()->Out{return Out(vec4f(.08,.16,.24,.4),.4);}` });
    const pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [
        { format: "rgba16float", blend: { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } } },
        { format: "r16float", blend: { color: { srcFactor: "zero", dstFactor: "one-minus-src", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } } } ] },
      depthStencil: { format: "depth32float", depthCompare: "always", depthWriteEnabled: false } });
    oit.encode({ encoder, opaqueColor: hdr, hdrColor: hdr, hdrView: hdr.createView(), depthView: depth.createView(), viewOf: t => t.createView(),
      reactiveTarget: { texture: mask, view: mask.createView() }, draw: pass => { pass.setPipeline(pipeline); pass.draw(3); return { drawCalls: 1, triangles: 1 }; } });
    encoder.copyTextureToBuffer({ texture: mask }, { buffer: read, bytesPerRow: 256 }, [64, 64]);
    device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(read.getMappedRange().slice(0)); read.unmap();
    let min = 255, max = 0; for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { min = Math.min(min, bytes[y * 256 + x]!); max = Math.max(max, bytes[y * 256 + x]!); }
    evidence = { min, max, left: bytes[32 * 256 + 19]!, right: bytes[32 * 256 + 44]!, sameTexture: oit.currentReactiveMask === mask, remainingDelta: 0 };
  } finally {
    if (read.mapState === "mapped") read.unmap(); session.release(read);
    oit.dispose(); splats.dispose(); particlePass.dispose(); particles.dispose(); await device.queue.onSubmittedWorkDone();
    for (let n = 0; n < 8; n++) await Promise.resolve(); for (const t of textures) session.release(t);
  }
  evidence!.remainingDelta = session.resourceCount - before;
  return { ...evidence!, drawParticle, passed: evidence!.min >= 101 && evidence!.max < 220 && evidence!.right > 130
    && (drawParticle ? evidence!.left > 150 : evidence!.left < 105) && evidence!.sameTexture && evidence!.remainingDelta === 0 };
}
