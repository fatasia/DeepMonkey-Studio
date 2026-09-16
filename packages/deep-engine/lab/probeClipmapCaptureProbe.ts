import {
  PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL, ProbeClipmapCaptureExecutor, ProbeClipmapResources,
  ProbeClipmapUpdateScheduler,
} from "@bim-studio/deep-engine/lighting";
import {
  WebGpuProbeCaptureAdapter, type DeviceSession, type WebGpuProbeSamplingBinding,
} from "@bim-studio/deep-engine/webgpu";

const EXPECTED = Object.freeze([0.75, 0.25, 0.125, 1]);
const ROW_BYTES = 256;

export interface ProbeClipmapCaptureProbeResult {
  readonly action: "probe-clipmap-capture";
  readonly success: true;
  readonly pixel: readonly number[];
  readonly sampledPixel: readonly number[];
  readonly maxError: number;
  readonly updateCount: number;
  readonly mipLevelCount: number;
  readonly allocatedBytes: number;
}

/** Executes the production probe scheduler/resources/adapter and reads one filtered voxel back. */
export async function runProbeClipmapCaptureProbe(session: DeviceSession):
Promise<ProbeClipmapCaptureProbeResult> {
  if (session.state !== "ready") throw new Error("Probe clipmap capture probe requires a ready session.");
  const epoch = "lab-probe-1", resources = new ProbeClipmapResources(session, epoch);
  const adapter = new WebGpuProbeCaptureAdapter(session, epoch, { fallbackRadiance: [0.75, 0.25, 0.125] });
  const executor = new ProbeClipmapCaptureExecutor(resources, adapter,
    { maxUpdatesPerBatch: 8, deviceLost: session.device.lost });
  const scheduler = new ProbeClipmapUpdateScheduler(executor, { frameBudget: 8, cameraCutBudget: 8 });
  let readback: GPUBuffer | undefined;
  try {
    const frame = await scheduler.submit({ frame: 0, deviceEpoch: epoch, viewport: [4, 2],
      cameraPosition: [0, 0, 0], sceneBounds: { min: [-100, -100, -100], max: [100, 100, 100] },
      options: { levelCount: 2, gridSize: [4, 2, 4] } });
    const binding = executor.current?.published, update = frame.plan?.updates[0];
    if (frame.status !== "committed" || !binding || !update) throw new Error("Probe capture did not publish a sample.");
    readback = session.own(session.device.createBuffer({ label: "Deep GI probe capture readback",
      size: ROW_BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    const encoder = session.device.createCommandEncoder({ label: "Deep GI probe capture readback" });
    encoder.copyTextureToBuffer({ texture: binding.texture, origin: {
      x: update.localCell[0], y: update.localCell[1],
      z: update.localCell[2] + update.level * frame.plan!.profile.gridSize[2],
    } }, { buffer: readback, bytesPerRow: ROW_BYTES, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: 1 });
    session.device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const data = new DataView(readback.getMappedRange()), pixel = Object.freeze(Array.from({ length: 4 },
      (_, index) => halfToFloat(data.getUint16(index * 2, true))));
    readback.unmap();
    const sampledPixel = await samplePublishedProbe(session, binding, update.position,
      frame.plan.levels[update.level]!.spacing);
    const maxError = Math.max(...[...pixel, ...sampledPixel]
      .map((value, index) => Math.abs(value - EXPECTED[index % 4]!)));
    if (!Number.isFinite(maxError) || maxError > 0.01) {
      throw new Error(`Probe capture/sample mismatch: ${JSON.stringify({ pixel, sampledPixel,
        update: { level: update.level, position: update.position, localCell: update.localCell },
        level: frame.plan.levels[update.level] })}.`);
    }
    return Object.freeze({ action: "probe-clipmap-capture", success: true, pixel, sampledPixel, maxError,
      updateCount: frame.stats!.updateCount, mipLevelCount: binding.mipLevelCount,
      allocatedBytes: binding.allocatedBytes });
  } finally {
    if (readback?.mapState === "mapped") readback.unmap();
    if (readback) session.release(readback);
    scheduler.dispose(); executor.dispose();
  }
}

async function samplePublishedProbe(session: DeviceSession, binding: WebGpuProbeSamplingBinding,
  position: readonly [number, number, number], spacing: number): Promise<readonly number[]> {
  const device = session.device, resources: Array<GPUBuffer | GPUTexture> = [];
  const own = <T extends GPUBuffer | GPUTexture>(resource: T): T => {
    resources.push(session.own(resource)); return resource;
  };
  const empty = [0, 1, 2].map(index => device.createBindGroupLayout({ label: `Deep GI sample empty ${index}`, entries: [] }));
  const layout = device.createBindGroupLayout({ label: "Deep GI production sample bindings", entries: [
    { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
    { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    { binding: 11, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 256 } },
  ] });
  const samplePosition = [position[0], position[1] - spacing * 0.2, position[2]];
  const module = device.createShaderModule({ label: "Deep GI production texture sample WGSL", code: `${PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL}
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)); return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fragmentMain() -> @location(0) vec4f {
  return deepGiSampleTexture(vec3f(${samplePosition.join(",")}), vec3f(0.0, 1.0, 0.0));
}` });
  const pipeline = device.createRenderPipeline({ label: "Deep GI production texture sample",
    layout: device.createPipelineLayout({ bindGroupLayouts: [...empty, layout] }),
    vertex: { module, entryPoint: "vertexMain" }, fragment: { module, entryPoint: "fragmentMain",
      targets: [{ format: "rgba16float" }] } });
  const group = device.createBindGroup({ label: "Deep GI production texture sample binding", layout, entries: [
    { binding: 9, resource: binding.view }, { binding: 10, resource: binding.sampler },
    { binding: 11, resource: { buffer: binding.levelMetadataBuffer } },
  ] });
  const target = own(device.createTexture({ label: "Deep GI production sample target", size: [1, 1], format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
  const readback = own(device.createBuffer({ label: "Deep GI production sample readback", size: ROW_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  try {
    const encoder = device.createCommandEncoder({ label: "Deep GI production sample command" });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), clearValue: [0, 0, 0, 0],
      loadOp: "clear", storeOp: "store" }] });
    pass.setPipeline(pipeline); pass.setBindGroup(3, group); pass.draw(3); pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: ROW_BYTES }, [1, 1]);
    device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone(); await readback.mapAsync(GPUMapMode.READ);
    const data = new DataView(readback.getMappedRange()), pixel = Object.freeze(Array.from({ length: 4 },
      (_, index) => halfToFloat(data.getUint16(index * 2, true))));
    readback.unmap(); return pixel;
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    for (const resource of resources) session.release(resource);
  }
}

function halfToFloat(value: number): number {
  const sign = value & 0x8000 ? -1 : 1, exponent = value >>> 10 & 0x1f, fraction = value & 0x03ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}
