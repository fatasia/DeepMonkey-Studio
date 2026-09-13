/// <reference types="@webgpu/types" />
import { ForwardPlusPbrRuntime } from "../src/lighting/forwardPlusPbrRuntime.js";
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { PacketCullingResources } from "../src/webgpu/packetCulling.js";
import { drawPacketBatches } from "../src/webgpu/packetDraw.js";
import { PacketLodResources } from "../src/webgpu/packetLodResources.js";
import { PacketLodSceneCache } from "../src/webgpu/packetLodSceneCache.js";
import { PacketShadowLodResources } from "../src/webgpu/packetShadowLodResources.js";
import { viewProjectionFrustum } from "../src/webgpu/pbrFrusta.js";
import { createPipelines, PBR_FRAME_UNIFORM_FLOATS } from "../src/webgpu/pipelines.js";
import { shadowProbePlan, shadowProbeScene } from "./packetShadowLodProbeScene.js";

const SIZE = 64, INDIRECT_BYTES = 160, DEPTH_BYTES = 256 * SIZE;

/** Production packet selection/drawing: off-camera caster, residency fallback, alpha mask, and independent cascades. */
export async function runPacketShadowLodProbe(session: DeviceSession) {
  const device = session.device, inputs = new PacketLodSceneCache(session), colorLod = new PacketLodResources(session, inputs);
  const shadowLod = new PacketShadowLodResources(session, inputs), culling = new PacketCullingResources(session);
  const lighting = new ForwardPlusPbrRuntime(session), scene = shadowProbeScene(session), plan = shadowProbePlan();
  const resources: Array<GPUBuffer | GPUTexture> = [];
  const own = <T extends GPUBuffer | GPUTexture>(value: T): T => { resources.push(value); return value; };
  let submitted = false;
  try {
    const pipelines = await createPipelines(device, "rgba8unorm", lighting.layout);
    const depth = own(device.createTexture({ label: "Deep shadow LOD probe depth", size: [SIZE, SIZE, 3], format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
    const counters = own(device.createBuffer({ label: "Deep shadow LOD probe counters", size: INDIRECT_BYTES * 4 + 60,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    const pixels = own(device.createBuffer({ label: "Deep shadow LOD probe depth readback", size: DEPTH_BYTES * 3,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    const encoder = device.createCommandEncoder({ label: "Deep independent shadow LOD probe" });
    colorLod.encode(encoder, scene.batches, scene.geometries, 0, {
      camera: { projection: "perspective", position: [0, 0, -10], forward: [0, 0, -1],
        verticalFovRadians: Math.PI / 2, near: 0.1, far: 100 }, viewport: { width: SIZE, height: SIZE },
      frustum: { planes: [[1, 0, 0, 100], [-1, 0, 0, 100], [0, 1, 0, 100],
        [0, -1, 0, 100], [0, 0, 1, 100], [0, 0, -1, 100]] } });
    const stats = shadowLod.encode(encoder, scene.batches, scene.geometries, 0, plan);
    const caster = [...scene.batches.values()].find(batch => batch.source.alphaMode === "OPAQUE" && batch.source.lod)!;
    const plain = [...scene.batches.values()].find(batch => !batch.source.lod)!;
    encoder.copyBufferToBuffer(colorLod.draws(caster.source.key)![0]!.indirect, 0, counters, 0, INDIRECT_BYTES);
    for (const cascade of plan.cascades) {
      culling.encode(encoder, viewProjectionFrustum(cascade.viewProjection), "shadow", scene.batches, scene.geometries, undefined, cascade.index);
      const uniform = own(device.createBuffer({ label: `Deep shadow LOD probe cascade ${cascade.index}`, size: PBR_FRAME_UNIFORM_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
      const data = new Float32Array(PBR_FRAME_UNIFORM_FLOATS); data.set(cascade.viewProjection, 48); device.queue.writeBuffer(uniform, 0, data);
      const binding = device.createBindGroup({ layout: pipelines.shadow.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
      const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
        view: depth.createView({ dimension: "2d", baseArrayLayer: cascade.index, arrayLayerCount: 1 }),
        depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 } });
      pass.setBindGroup(0, binding);
      drawPacketBatches(pass, pipelines, "shadow", scene.batches, scene.geometries, culling,
        shadowLod.cascade(cascade.index), undefined, true, cascade.index);
      pass.end();
      encoder.copyBufferToBuffer(shadowLod.cascade(cascade.index)!.draws(caster.source.key)![0]!.indirect,
        0, counters, (cascade.index + 1) * INDIRECT_BYTES, INDIRECT_BYTES);
      encoder.copyBufferToBuffer(culling.phase(plain.source.key, "shadow", cascade.index)!.indirect,
        0, counters, INDIRECT_BYTES * 4 + cascade.index * 20, 20);
    }
    encoder.copyTextureToBuffer({ texture: depth, aspect: "depth-only" },
      { buffer: pixels, bytesPerRow: 256, rowsPerImage: SIZE }, [SIZE, SIZE, 3]);
    const commands = encoder.finish(); submitted = true; device.queue.submit([commands]);
    colorLod.commitFrame(); shadowLod.commitFrame();
    await Promise.all([counters.mapAsync(GPUMapMode.READ), pixels.mapAsync(GPUMapMode.READ)]);
    const indirect = new Uint32Array(counters.getMappedRange().slice(0)), depthValues = new Float32Array(pixels.getMappedRange().slice(0));
    counters.unmap(); pixels.unmap();
    const counts = (view: number) => [0, 1, 2].map(level => indirect[view * 40 + level * 5 + 1]!);
    const colorCounts = counts(0), cascadeCounts = [1, 2, 3].map(counts);
    const nonLodCascadeCounts = [0, 1, 2].map(cascade => indirect[160 + cascade * 5 + 1]!);
    const writtenPixels = [0, 1, 2].map(cascade => depthValues.slice(cascade * SIZE * SIZE, (cascade + 1) * SIZE * SIZE)
      .filter(value => value < 0.9).length);
    // 只读取远级 LOD 投影体的区域，避免 x=2 的普通实例替它通过像素验收。
    const farCasterPixels = depthValues.slice(SIZE * SIZE, SIZE * SIZE * 2).filter((value, index) =>
      value < 0.9 && index % SIZE >= 26 && index % SIZE < 30 && Math.floor(index / SIZE) >= 30
      && Math.floor(index / SIZE) < 34).length;
    const maskDiscarded = depthValues[32 * SIZE + 48] === 1 && depthValues[SIZE * SIZE + 32 * SIZE + 36] === 1;
    const offCameraCaster = colorCounts.every(count => count === 0) && writtenPixels[0]! > 100;
    const lodAndResidency = JSON.stringify(cascadeCounts) === JSON.stringify([[1, 0, 0], [0, 0, 1], [0, 0, 0]]);
    const isolatedCulling = JSON.stringify(nonLodCascadeCounts) === JSON.stringify([0, 64, 0]);
    const passed = stats.indirectDraws === 18 && offCameraCaster && lodAndResidency && isolatedCulling
      && maskDiscarded && farCasterPixels > 0 && writtenPixels[2] === 0;
    return { colorCounts, cascadeCounts, nonLodCascadeCounts, writtenPixels, farCasterPixels, maskDiscarded, offCameraCaster,
      lodAndResidency, isolatedCulling, passed };
  } catch (error) {
    if (submitted) { colorLod.failFrame(); shadowLod.failFrame(); }
    else { colorLod.cancelFrame(); shadowLod.cancelFrame(); }
    throw error;
  } finally {
    colorLod.dispose(); shadowLod.dispose(); culling.dispose(); inputs.clear(); lighting.dispose(); scene.dispose();
    for (const resource of resources.reverse()) resource.destroy();
  }
}
