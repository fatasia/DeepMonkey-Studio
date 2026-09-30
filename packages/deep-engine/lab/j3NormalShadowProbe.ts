/// <reference types="@webgpu/types" />
import { PbrRenderer, type RenderView } from "../src/webgpu/pbrRenderer.js";
import { materializeRuntimeRenderPacket } from "../src/runtimePackage/renderPacket.js";
import type { DeepRuntimePackageV1 } from "../src/runtimePackage/types.js";
import { lookAt, multiply, perspective } from "../src/webgpu/cameraMath.js";
import { buildJ3NormalShadowMatrix, type J3NormalShadowManifest } from "./j3NormalShadowMatrix.js";
import { j3NormalShadowReadbackShader } from "./j3NormalShadowReadbackShader.js";

type Point = ReturnType<typeof buildJ3NormalShadowMatrix>["cases"][number]["points"][number];
interface ProductionAttachments {
  targets: { normalTexture: GPUTexture; linearDepthTexture: GPUTexture; hdrTexture: GPUTexture };
  shadows: { uniform: GPUBuffer; texture: GPUTexture; sampler: GPUSampler };
  frameData: Float32Array;
}

async function observe(renderer: PbrRenderer, points: readonly (Point & { instanceId: string })[], width: number) {
  const actual = renderer as unknown as ProductionAttachments, device = renderer.session.device;
  if (!actual.targets.normalTexture) throw Error("Production normal attachment was not allocated.");
  const bytes = new ArrayBuffer(points.length * 48), floats = new Float32Array(bytes), uints = new Uint32Array(bytes);
  points.forEach((point, index) => {
    const offset = index * 12;
    floats.set([...point.worldPoint, 1, ...point.expectedWorldNormal,
      point.expectedWorldNormal.reduce((sum, value, lane) => sum + value * [-.6, -.3, Math.sqrt(.55)][lane]!, 0)], offset);
    uints.set([point.pixel % width, Math.floor(point.pixel / width), 0, 0], offset + 8);
  });
  const inputs = device.createBuffer({ size: bytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const outputSize = (156 + points.length * 12) * 4;
  const output = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    device.queue.writeBuffer(inputs, 0, bytes);
    const pipeline = await device.createComputePipelineAsync({ layout: "auto",
      compute: { module: device.createShaderModule({ code: j3NormalShadowReadbackShader }), entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: actual.targets.normalTexture.createView() },
      { binding: 1, resource: actual.targets.linearDepthTexture.createView() },
      { binding: 2, resource: actual.targets.hdrTexture.createView() },
      { binding: 3, resource: { buffer: inputs } }, { binding: 4, resource: { buffer: output } },
    ] });
    const shadow = device.createBindGroup({ layout: pipeline.getBindGroupLayout(2), entries: [
      { binding: 0, resource: { buffer: actual.shadows.uniform } },
      { binding: 1, resource: actual.shadows.texture.createView({ dimension: "2d-array", aspect: "depth-only" }) },
      { binding: 2, resource: actual.shadows.sampler },
    ] });
    const empty = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.setBindGroup(1, empty); pass.setBindGroup(2, shadow);
    pass.dispatchWorkgroups(Math.ceil(points.length / 64)); pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, outputSize); device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ); const data = new Float32Array(read.getMappedRange()).slice(); read.unmap();
    if (!data.every(Number.isFinite)) throw Error("Non-finite actual normal/shadow attachments.");
    return { shadowUniform: Array.from(data.slice(0, 156)), actualVP: Array.from(actual.frameData.slice(0, 16)),
      actualWorldToView: Array.from(actual.frameData.slice(32, 48)),
      samples: points.map((point, index) => {
        const offset = 156 + index * 12;
        return { pixel: point.pixel, instanceId: point.instanceId, encodedViewNormal: Array.from(data.slice(offset, offset + 4)),
          hdr: Array.from(data.slice(offset + 4, offset + 7)), sampledShadowVisibility: data[offset + 7]!,
          linearDepth: data[offset + 8]! };
      }) };
  } finally { inputs.destroy(); output.destroy(); read.destroy(); }
}

/** Production PBR with its existing geometry MRT; original packet remains undeformed. */
export async function runJ3NormalShadowProbe(canvas: HTMLCanvasElement, source: DeepRuntimePackageV1,
  manifest: J3NormalShadowManifest, screenshot?: (id: string, round: number) => Promise<void>) {
  const matrix = buildJ3NormalShadowMatrix(source, manifest), abort = new AbortController();
  const original = materializeRuntimeRenderPacket(source.payloads[source.entrypoints.renderPacket], "$.normalShadowPacket");
  const frames = [];
  for (const cascadeCount of [1, 4]) {
    const renderer = await PbrRenderer.create(canvas, navigator.gpu, abort.signal, { deformation: true,
      shadows: { exactProfile: { cascadeCount, shadowMapSize: 2048, splitLambda: .7, blendRatio: 0, depthBias: .00075 } },
      features: { environment: false, groundPlane: false, groundGrid: false, ambientOcclusion: false,
        temporalAa: false, occlusionCulling: false, screenSpaceReflection: false, bloom: false, vignette: false, fog: false,
        volumetricFog: false, contactShadows: false } });
    try {
      for (const scenario of ["baseline", "cube-caster-disabled", "triangle-receiver-disabled"] as const) {
        const packet = { ...original, instances: original.instances.map(instance => ({ ...instance,
          ...(scenario === "cube-caster-disabled" && instance.id.startsWith("golden-instance") ? { castShadow: false } : {}),
          ...(scenario === "triangle-receiver-disabled" && instance.id.startsWith("golden-triangle") ? { receiveShadow: false } : {}),
        })) };
        await renderer.setPacketValidated(packet, abort.signal);
        for (const camera of manifest.cameras) {
          const points = matrix.cases.filter(row => row.cameraId === camera.id && row.cascadeCount === cascadeCount)
            .flatMap(row => row.points.map(point => ({ ...point, instanceId: row.instanceId })));
          const view: RenderView = { ...camera, far: 40, width: manifest.width, height: manifest.height, pixelRatio: 1,
            extent: 50, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: .8,
            fog: null, environmentIntensity: 0, lights: { directional: [{ directionWorld: [.6, .3, -Math.sqrt(.55)],
              color: [2.5, 2.4, 2.25], intensity: 1, castShadow: true }], points: [], spots: [], areas: [], ambient: [], hemisphere: [] } };
          for (let round = 0; round < 2; round++) {
            const metrics = await renderer.validateFrame(view);
            if (metrics.drawCalls < 1 || metrics.triangles < 1) throw Error("Empty production normal/shadow frame.");
            const observed = await observe(renderer, points, manifest.width);
            if (renderer.session.hasErrors) throw Error("Production attachment readback reported GPU errors.");
            const expectedVP = Array.from(multiply(perspective(camera.verticalFovRadians, manifest.width / manifest.height, camera.near, 40),
              lookAt(camera.eye, camera.target, camera.up)));
            frames.push({ cameraId: camera.id, cascadeCount, scenario, round, expectedVP, ...observed });
            await screenshot?.(`${camera.id}-csm${cascadeCount}-${scenario}`, round);
          }
        }
      }
    } finally { renderer.dispose(); }
  }
  abort.abort();
  return { host: "webgpu-production-pbr", packageHash: manifest.packageHash, packetHash: manifest.packetHash,
    normalAttachment: "production-view-normal-rgba8unorm", shadowObservation: "production-map-and-uniform-with-canonical-helper-at-fixed-world-points",
    normalAlpha: "perceptual-roughness", actualNormalAttachments: true, actualShadowAttachments: true,
    width: manifest.width, height: manifest.height, gpuErrors: [], frames };
}
