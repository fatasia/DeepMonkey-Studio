import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { ForwardPlusPbrRuntime } from "../src/lighting/forwardPlusPbrRuntime.js";
import { createPipelines } from "../src/webgpu/pipelines.js";
import { PBR_OPAQUE_ATTACHMENT_FORMATS } from "../src/webgpu/renderTargets.js";
import { decodeFloat16Bits } from "./temporalAaProbe.js";
import { createProbeProducer, type ProbeProducerKind } from "./pbrDeformationProducerProbe.js";
import { DeformationDrawBindings } from "../src/webgpu/deformationDrawBindings.js";

const SIZE = 64, IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Production compute, submitted history and raster/motion in one command stream. */
export async function runPbrDeformationDrawProbe(session: DeviceSession, kind: ProbeProducerKind) {
  const device = session.device, lighting = new ForwardPlusPbrRuntime(session);
  const producer = createProbeProducer(session, kind);
  let bindings: DeformationDrawBindings | undefined;
  const resources: Array<GPUBuffer | GPUTexture> = [];
  const own = <T extends GPUBuffer | GPUTexture>(resource: T): T => { resources.push(resource); return resource; };
  const buffer = (data: Float32Array<ArrayBuffer>, usage: GPUBufferUsageFlags) => {
    const value = own(device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST }));
    device.queue.writeBuffer(value, 0, data); return value;
  };
  const texture = (format: GPUTextureFormat, layers = 1) => own(device.createTexture({ size: [SIZE, SIZE, layers], format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
  try {
    const pipelines = await createPipelines(device, "rgba8unorm", lighting.layout, true, false, true, { deformation: true });
    bindings = new DeformationDrawBindings(device, pipelines);
    const main = pipelines.mainPipelines.get("plain/depth/double")!, shadow = pipelines.shadowPipelines.get("author/solid/double")!;
    const frameData = new Float32Array(96);
    for (const offset of [0, 16, 32, 48]) frameData.set(IDENTITY, offset);
    frameData.set([0, 0, 3, 0], 64);
    const uniform = buffer(frameData, GPUBufferUsage.UNIFORM);
    const depthSample = texture("depth32float"), cube = texture("rgba8unorm", 6), image = texture("rgba8unorm");
    const sampler = device.createSampler(), comparison = device.createSampler({ compare: "less-equal" });
    const frame = device.createBindGroup({ layout: main.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: depthSample.createView() },
      { binding: 2, resource: comparison }, { binding: 3, resource: cube.createView({ dimension: "cube" }) },
      { binding: 4, resource: cube.createView({ dimension: "cube" }) }, { binding: 5, resource: image.createView() },
      { binding: 6, resource: sampler }, { binding: 7, resource: { buffer: buffer(new Float32Array(16), GPUBufferUsage.UNIFORM) } },
      { binding: 8, resource: { buffer: buffer(new Float32Array(8), GPUBufferUsage.UNIFORM) } },
    ] });
    const cascade = device.createBindGroup({ layout: pipelines.cascadedShadowLayout, entries: [
      { binding: 0, resource: { buffer: buffer(new Float32Array(156), GPUBufferUsage.UNIFORM) } },
      { binding: 1, resource: depthSample.createView({ dimension: "2d-array" }) }, { binding: 2, resource: comparison },
    ] });
    const shadowFrame = device.createBindGroup({ layout: shadow.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
    // Static vertex positions deliberately lie outside the viewport: only pose storage can draw the triangle.
    const vertices = buffer(new Float32Array([9, 9, 9, 0, 0, 1, 0, 0, 0, 0,
      9, 9, 9, 0, 0, 1, 0, 0, 0, 0, 9, 9, 9, 0, 0, 1, 0, 0, 0, 0]), GPUBufferUsage.VERTEX);
    const rows = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const instances = buffer(new Float32Array([...rows, ...rows, 1, 0.25, 0.125, 0, 1, 0, 1, 64 + 32 + 16, 0, 0, 0, 1]), GPUBufferUsage.VERTEX);
    const previousInstances = buffer(new Float32Array(rows), GPUBufferUsage.VERTEX);
    const observations = [];
    for (const [frameIndex, name] of ["baseline", "moved", "settled"].entries()) {
      const encoder = device.createCommandEncoder();
      const pose = producer.encode(encoder, frameIndex);
      const binding = bindings.get("moving", pose);
      const targets = PBR_OPAQUE_ATTACHMENT_FORMATS.map(format => texture(format));
      const depth = texture("depth32float"), shadowDepth = texture("depth32float");
      const lights = lighting.prepareAndEncode(encoder, { viewportWidth: SIZE, viewportHeight: SIZE,
        near: 0.1, far: 10, verticalFovRadians: 1, lights: {} });
      const pass = encoder.beginRenderPass({ colorAttachments: targets.map(value => ({ view: value.createView(),
        loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] })), depthStencilAttachment: {
        view: depth.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 } });
      pass.setPipeline(main); pass.setBindGroup(0, frame); pass.setBindGroup(1, binding);
      pass.setBindGroup(2, cascade); pass.setBindGroup(3, lights.bindGroup);
      pass.setVertexBuffer(0, vertices); pass.setVertexBuffer(1, instances); pass.setVertexBuffer(2, previousInstances);
      pass.draw(3); pass.end();
      const shadowPass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
        view: shadowDepth.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 } });
      shadowPass.setPipeline(shadow); shadowPass.setBindGroup(0, shadowFrame); shadowPass.setBindGroup(1, binding);
      shadowPass.setVertexBuffer(0, vertices); shadowPass.setVertexBuffer(1, instances); shadowPass.draw(3); shadowPass.end();
      const reads = [targets[0]!, targets[3]!, shadowDepth].map((value, index) => {
        const row = index === 0 ? 512 : 256;
        const read = own(device.createBuffer({ size: row * SIZE, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
        encoder.copyTextureToBuffer({ texture: value, ...(index === 2 ? { aspect: "depth-only" as const } : {}) },
          { buffer: read, bytesPerRow: row }, [SIZE, SIZE]); return read;
      });
      device.queue.submit([encoder.finish()]); producer.commit();
      await Promise.all(reads.map(read => read.mapAsync(GPUMapMode.READ)));
      const stationary = await producer.inspectStationary();
      const hdr = new Uint16Array(reads[0]!.getMappedRange()), motion = new Uint16Array(reads[1]!.getMappedRange());
      const shadowValues = new Float32Array(reads[2]!.getMappedRange());
      let pixels = 0, xSum = 0, motionSum = 0, shadowPixels = 0, shadowX = 0, finite = true;
      for (let index = 0; index < SIZE * SIZE; index++) {
        const red = decodeFloat16Bits(hdr[index * 4]!);
        finite &&= Number.isFinite(red) && Number.isFinite(decodeFloat16Bits(motion[index * 2]!));
        if (red > 0.5) { pixels++; xSum += index % SIZE; motionSum += decodeFloat16Bits(motion[index * 2]!); }
        if (shadowValues[index]! < 0.75) { shadowPixels++; shadowX += index % SIZE; }
      }
      observations.push({ name, stationary, historyValid: pose.historyValid, historyUpdated: pose.updated,
        pixels, centroidX: xSum / pixels, motionX: motionSum / pixels,
        shadowPixels, shadowCentroidX: shadowX / shadowPixels, finite });
      reads.forEach(read => read.unmap());
    }
    const [baseline, moved, settled] = observations;
    const passed = observations.every(item => item.stationary.unchanged && item.finite && item.pixels > 50 && item.shadowPixels === item.pixels
      && Math.abs(item.centroidX - item.shadowCentroidX) < 0.01)
      && moved!.centroidX - baseline!.centroidX > 24 && Math.abs(moved!.motionX + 0.4) < 0.002
      && Math.abs(baseline!.motionX) < 0.001 && Math.abs(settled!.motionX) < 0.001
      && !baseline!.historyValid && moved!.historyValid && moved!.historyUpdated && !settled!.historyUpdated;
    return { passed, kind, observations, expectedMotionX: -0.4,
      scope: "PacketDeformationResources -> DeformationDrawBindings -> HDR/shadow/motion; shared source two independent poses + cancelled encoder" };
  } finally {
    bindings?.dispose();
    try { producer.dispose(); } finally {
      try { lighting.dispose(); } finally { for (const resource of resources.reverse()) resource.destroy(); }
    }
  }
}
