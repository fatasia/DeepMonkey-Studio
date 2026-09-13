/// <reference types="@webgpu/types" />
import { buildMeshlets, expandMeshletIndices } from "@bim-studio/deep-engine/geometry";
import { MeshletCuller, MeshletIndexBuffer, MeshletIndirectExecutor, type DeviceSession } from "@bim-studio/deep-engine/webgpu";

export interface MeshletIndirectProbeResult {
  readonly meshletCount: number;
  readonly visibleCount: number;
  readonly validCommandCount: number;
  readonly sourceInstanceMapping: boolean;
  readonly renderedPixel: readonly [number, number, number, number];
  readonly passed: boolean;
}

/** Real-device compute-to-indirect-to-RenderBundle probe; intentionally not registered in lab/main.ts. */
export async function runMeshletIndirectProbe(session: DeviceSession): Promise<MeshletIndirectProbeResult> {
  if (session.state !== "ready") throw new Error("Meshlet indirect probe requires a ready device session.");
  const device = session.device, geometry = probeGeometry();
  const meshlets = buildMeshlets(geometry, { maxTriangles: 1 }), expanded = expandMeshletIndices(meshlets);
  const owned: Array<GPUBuffer | GPUTexture> = [];
  const own = <T extends GPUBuffer | GPUTexture>(resource: T): T => { owned.push(session.own(resource)); return resource; };
  const descriptors = own(device.createBuffer({ label: "Deep meshlet indirect probe descriptors", size: meshlets.descriptors.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  const bounds = own(device.createBuffer({ label: "Deep meshlet indirect probe bounds", size: meshlets.bounds.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  const vertices = own(device.createBuffer({ label: "Deep meshlet indirect probe vertices", size: geometry.positions.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }));
  const countReadback = own(device.createBuffer({ label: "Deep meshlet indirect probe count", size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const commandsReadback = own(device.createBuffer({ label: "Deep meshlet indirect probe commands", size: meshlets.meshletCount * 20,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const colorReadback = own(device.createBuffer({ label: "Deep meshlet indirect probe color", size: 256 * 64,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const color = own(device.createTexture({ label: "Deep meshlet indirect probe target", size: [64, 64, 1], format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
  const indexBuffer = new MeshletIndexBuffer(session, expanded), culler = new MeshletCuller(session), executor = new MeshletIndirectExecutor(session);
  try {
    device.queue.writeBuffer(descriptors, 0, meshlets.descriptors);
    device.queue.writeBuffer(bounds, 0, meshlets.bounds);
    device.queue.writeBuffer(vertices, 0, geometry.positions);
    const pipeline = probePipeline(device), encoder = device.createCommandEncoder({ label: "Deep meshlet indirect probe" });
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
    const frustum = { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1],
      [0, 0, 1, 0], [0, 0, -1, 1]] as const };
    const culled = culler.encode(encoder, { descriptors, bounds, count: meshlets.meshletCount, revision: 0 }, {
      viewProjection: identity, cameraPosition: [0, 0, 5], frustum, viewport: [64, 64], reversedZ: false,
    });
    if (culled.mode !== "gpu") throw new Error("Meshlet indirect probe unexpectedly selected direct drawing.");
    const plan = executor.encode(encoder, culled, { expandedIndexCount: indexBuffer.indexCount,
      instanceMapping: "source-meshlet" });
    const bundle = executor.prepareBundle(plan, { pipeline, indexBuffer: indexBuffer.buffer,
      vertexBuffers: [{ slot: 0, buffer: vertices }], colorFormats: ["rgba8unorm"] });
    const render = encoder.beginRenderPass({ label: "Deep meshlet indirect probe render", colorAttachments: [{
      view: color.createView(), clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store",
    }] });
    render.executeBundles([bundle.bundle]); render.end();
    encoder.copyBufferToBuffer(culled.visibleCount, 0, countReadback, 0, 4);
    encoder.copyBufferToBuffer(plan.commands, 0, commandsReadback, 0, meshlets.meshletCount * 20);
    encoder.copyTextureToBuffer({ texture: color }, { buffer: colorReadback, bytesPerRow: 256, rowsPerImage: 64 }, [64, 64, 1]);
    device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
    await Promise.all([countReadback.mapAsync(GPUMapMode.READ), commandsReadback.mapAsync(GPUMapMode.READ), colorReadback.mapAsync(GPUMapMode.READ)]);
    const visibleCount = new Uint32Array(countReadback.getMappedRange().slice(0))[0] ?? 0;
    const commands = new DataView(commandsReadback.getMappedRange().slice(0));
    let validCommandCount = 0, sourceInstanceMapping = true;
    for (let draw = 0; draw < meshlets.meshletCount; draw += 1) {
      const offset = draw * 20, valid = commands.getUint32(offset, true) === 3 && commands.getUint32(offset + 4, true) === 1
        && commands.getUint32(offset + 8, true) === draw * 3 && commands.getInt32(offset + 12, true) === 0;
      if (valid) validCommandCount += 1;
      sourceInstanceMapping &&= commands.getUint32(offset + 16, true) === draw;
    }
    const pixels = new Uint8Array(colorReadback.getMappedRange());
    const pixelOffset = 32 * 256 + 32 * 4;
    const renderedPixel = [pixels[pixelOffset]!, pixels[pixelOffset + 1]!, pixels[pixelOffset + 2]!, pixels[pixelOffset + 3]!] as const;
    countReadback.unmap(); commandsReadback.unmap(); colorReadback.unmap();
    const passed = visibleCount === meshlets.meshletCount && validCommandCount === meshlets.meshletCount
      && sourceInstanceMapping && renderedPixel[0] > 200 && renderedPixel[1] < 20 && renderedPixel[2] < 20;
    return Object.freeze({ meshletCount: meshlets.meshletCount, visibleCount, validCommandCount,
      sourceInstanceMapping, renderedPixel, passed });
  } finally {
    executor.dispose(); culler.dispose(); indexBuffer.dispose();
    for (const resource of owned.reverse()) session.release(resource);
  }
}

function probeGeometry() {
  const positions = new Float32Array(64 * 9), indices = new Uint16Array(64 * 3);
  for (let triangle = 0; triangle < 64; triangle += 1) {
    const vertex = triangle * 3;
    positions.set([-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0, 0.5, 0.5], vertex * 3);
    indices.set([vertex, vertex + 1, vertex + 2], triangle * 3);
  }
  return { positions, indices };
}

function probePipeline(device: GPUDevice): GPURenderPipeline {
  const module = device.createShaderModule({ label: "Deep meshlet indirect probe shader", code: /* wgsl */ `
struct VertexOutput { @builtin(position) position: vec4<f32> };
@vertex fn vertex(@location(0) position: vec3<f32>) -> VertexOutput {
  var output: VertexOutput; output.position = vec4<f32>(position, 1.0); return output;
}
@fragment fn fragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }
` });
  return device.createRenderPipeline({ label: "Deep meshlet indirect probe pipeline", layout: "auto",
    vertex: { module, entryPoint: "vertex", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
    fragment: { module, entryPoint: "fragment", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
}
